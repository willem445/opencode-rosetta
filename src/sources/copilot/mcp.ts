/**
 * B9: Copilot / VS Code `.vscode/mcp.json` -> `cfg.mcp[name]`.
 *
 * Mapping: `type: stdio` + `command`/`args`/`env`/`cwd` ->
 * `{type:"local", command:[command,...args], environment, cwd}`;
 * `type: http|sse` + `url`/`headers` -> `{type:"remote", url, headers}`.
 * `envFile`, `dev`, `sandboxEnabled`, `oauth` are dropped with an info
 * (`envFile` is a documented follow-up; oauth shapes differ -- opencode's
 * own auto-detection stays on).
 *
 * `${env:VAR}` / `${workspaceFolder}` (-> worktree) / `${userHome}` expand;
 * a missing env var is left LITERAL + a warn carrying only the variable
 * NAME (values may be credentials; they are never logged).
 * `${input:id}` resolves through (1) plugin options `inputs[id]` (itself
 * `{env:VAR}`-expandable), (2) env `ROSETTA_INPUT_<ID>` (upper-cased,
 * non-alnum -> `_`), (3) the file's own `inputs[].default`. **An input that
 * resolves nowhere drops the whole server with a warn** -- VS Code would
 * prompt interactively, and a config hook cannot.
 */
import { join } from "node:path";
import type { Ctx } from "../../context.js";
import { expandString } from "../../env.js";
import type { Diagnostic } from "../../diagnostics.js";
import { isFile, readJson, toPosix } from "../../fs.js";
import { emptyFragment, type Fragment } from "../types.js";

const SOURCE = "copilot.mcp";
const REMOTE_TYPES = new Set(["http", "sse"]);
const DROPPED_FIELDS = ["envFile", "dev", "sandboxEnabled", "oauth"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `inputs:` array of the mcp.json -> id -> default map. */
function collectInputDefaults(data: Record<string, unknown>): Record<string, string> {
  const defaults: Record<string, string> = {};
  if (!Array.isArray(data.inputs)) return defaults;
  for (const item of data.inputs) {
    if (!isPlainObject(item)) continue;
    if (typeof item.id === "string" && typeof item.default === "string") {
      defaults[item.id] = item.default;
    }
  }
  return defaults;
}

function expandFields(
  ctx: Ctx,
  serverName: string,
  inputDefaults: Readonly<Record<string, string>>,
  fields: ReadonlyArray<{ label: string; text: string }>,
): { values: Map<string, string>; hasUnresolvedInput: boolean; diags: Diagnostic[] } {
  const values = new Map<string, string>();
  const diags: Diagnostic[] = [];
  let hasUnresolvedInput = false;
  for (const { label, text } of fields) {
    const out = expandString(text, {
      worktree: ctx.worktree,
      home: ctx.home,
      env: ctx.env,
      inputs: ctx.options.inputs,
      inputDefaults,
    });
    values.set(label, out.value);
    if (out.unexpandedVars.length > 0) {
      diags.push({
        level: "warn",
        source: SOURCE,
        field: `mcp.${serverName}${label}`,
        reason: "unexpanded-env-var",
      });
    }
    if (out.unresolvedInputs.length > 0) hasUnresolvedInput = true;
  }
  return { values, hasUnresolvedInput, diags };
}

function translateServer(
  ctx: Ctx,
  name: string,
  entry: unknown,
  inputDefaults: Readonly<Record<string, string>>,
): { value?: Record<string, unknown>; diags: Diagnostic[] } {
  const diags: Diagnostic[] = [];
  const field = (suffix = "") => `mcp.${name}${suffix}`;

  if (!isPlainObject(entry)) {
    diags.push({ level: "warn", source: SOURCE, field: field(), reason: "invalid-shape" });
    return { diags };
  }
  for (const key of DROPPED_FIELDS) {
    if (key in entry) {
      diags.push({ level: "info", source: SOURCE, field: field(`.${key}`), reason: "unsupported-field-dropped" });
    }
  }

  const type = typeof entry.type === "string" ? entry.type : undefined;
  const hasUrl = typeof entry.url === "string";

  if (hasUrl && type === undefined) {
    diags.push({ level: "warn", source: SOURCE, field: field(), reason: "url-without-type" });
    return { diags };
  }

  if (type === undefined || type === "stdio") {
    if (typeof entry.command !== "string" || entry.command === "") {
      diags.push({ level: "warn", source: SOURCE, field: field(".command"), reason: "missing-command" });
      return { diags };
    }
    const commandParts = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
      .filter((part): part is string => typeof part === "string");
    const envEntries = isPlainObject(entry.env)
      ? Object.entries(entry.env).filter((pair): pair is [string, string] => typeof pair[1] === "string")
      : [];
    const expanded = expandFields(ctx, name, inputDefaults, [
      ...commandParts.map((text, i) => ({ label: `.command[${i}]`, text })),
      ...envEntries.map(([key, value]) => ({ label: `.environment.${key}`, text: value })),
      ...(typeof entry.cwd === "string" ? [{ label: ".cwd", text: entry.cwd }] : []),
    ]);
    diags.push(...expanded.diags);
    if (expanded.hasUnresolvedInput) {
      diags.push({ level: "warn", source: SOURCE, field: field(), reason: "unresolved-input" });
      return { diags };
    }
    const value: Record<string, unknown> = {
      type: "local",
      command: commandParts.map((_part, i) => expanded.values.get(`.command[${i}]`) ?? ""),
    };
    if (envEntries.length > 0) {
      const environment: Record<string, string> = {};
      for (const [key] of envEntries) environment[key] = expanded.values.get(`.environment.${key}`) ?? "";
      value.environment = environment;
    }
    if (typeof entry.cwd === "string") value.cwd = expanded.values.get(".cwd") ?? "";
    return { value, diags };
  }

  if (REMOTE_TYPES.has(type)) {
    if (!hasUrl) {
      diags.push({ level: "warn", source: SOURCE, field: field(".url"), reason: "missing-url" });
      return { diags };
    }
    const headerEntries = isPlainObject(entry.headers)
      ? Object.entries(entry.headers).filter((pair): pair is [string, string] => typeof pair[1] === "string")
      : [];
    const expanded = expandFields(ctx, name, inputDefaults, [
      { label: ".url", text: entry.url as string },
      ...headerEntries.map(([key, value]) => ({ label: `.headers.${key}`, text: value })),
    ]);
    diags.push(...expanded.diags);
    if (expanded.hasUnresolvedInput) {
      diags.push({ level: "warn", source: SOURCE, field: field(), reason: "unresolved-input" });
      return { diags };
    }
    const value: Record<string, unknown> = { type: "remote", url: expanded.values.get(".url") ?? "" };
    if (headerEntries.length > 0) {
      const headers: Record<string, string> = {};
      for (const [key] of headerEntries) headers[key] = expanded.values.get(`.headers.${key}`) ?? "";
      value.headers = headers;
    }
    return { value, diags };
  }

  diags.push({ level: "warn", source: SOURCE, field: field(".type"), reason: "unsupported-type" });
  return { diags };
}

export function copilotMcp(ctx: Ctx): Fragment {
  const fragment = emptyFragment();
  const mcp: Record<string, unknown> = {};
  const diags: Diagnostic[] = [];

  for (const root of ctx.projectRoots) {
    const abs = toPosix(join(root, ".vscode", "mcp.json"));
    if (!isFile(abs)) continue;
    let data: unknown;
    try {
      data = readJson(abs);
    } catch {
      diags.push({ level: "warn", source: SOURCE, file: abs, reason: "unparseable" });
      continue;
    }
    if (!isPlainObject(data) || !isPlainObject(data.servers)) continue;
    const inputDefaults = collectInputDefaults(data);
    for (const [name, entry] of Object.entries(data.servers)) {
      const translated = translateServer(ctx, name, entry, inputDefaults);
      diags.push(...translated.diags);
      if (translated.value) mcp[name] = translated.value;
    }
  }

  if (Object.keys(mcp).length > 0) fragment.mcp = mcp;
  fragment.diagnostics = diags;
  return fragment;
}
