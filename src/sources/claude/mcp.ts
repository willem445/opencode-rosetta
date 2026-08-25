/**
 * B3: Claude Code MCP -> `cfg.mcp[name]`.
 *
 * Sources, in order (`sources/index.ts` registry order gives project before
 * user scope):
 *   1. `<root>/.mcp.json` for every project root, nearest-to-directory first;
 *   2. `~/.claude.json` `projects[<worktree>].mcpServers` (local scope);
 *   3. `~/.claude.json` top-level `mcpServers` (user scope).
 * Sources 2-3 are gated by the `claude.user` toggle.
 *
 * Mapping (B3): `type: stdio` or absent + `command`/`args`/`env` ->
 * `{type:"local", command:[command,...args], environment}`, plus `cwd`/
 * `timeout`; `type: http|streamable-http|sse` + `url`/`headers` ->
 * `{type:"remote", url, headers}` (opencode tries StreamableHTTP then SSE
 * itself); `oauth` -> dropped (shapes differ); `url` without `type` ->
 * skipped + warn (Claude rejects it too); any other `type` (e.g. `ws`) ->
 * skipped + warn -- so this translator only ever emits `local`/`remote`
 * fragments and `apply.ts` never sees an unrecognized type from us.
 *
 * `${VAR}` / `${VAR:-default}` expansion applies to command/args/env/url/
 * headers (B3): a missing var with no default is left LITERAL + a warn that
 * carries only the variable NAME -- env values may be credentials and are
 * never logged. Names listed in `.claude/settings*.json`
 * `disabledMcpjsonServers` are skipped with an info.
 */
import { join } from "node:path";
import type { Ctx } from "../../context.js";
import { expandString } from "../../env.js";
import type { Diagnostic } from "../../diagnostics.js";
import { isFile, readJson, toPosix } from "../../fs.js";
import { emptyFragment, type Fragment } from "../types.js";

const SOURCE = "claude.mcp";

const REMOTE_TYPES = new Set(["http", "streamable-http", "sse"]);
const CLAUDE_SETTINGS = ["settings.json", "settings.local.json"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Names in `.claude/settings{,.local}.json` (every project root + home) `disabledMcpjsonServers`. */
function collectDisabled(ctx: Ctx): Set<string> {
  const disabled = new Set<string>();
  const dirs = [...ctx.projectRoots.map((root) => join(root, ".claude")), join(ctx.home, ".claude")];
  for (const dir of dirs) {
    for (const name of CLAUDE_SETTINGS) {
      const abs = toPosix(join(dir, name));
      if (!isFile(abs)) continue;
      let data: unknown;
      try {
        data = readJson(abs);
      } catch {
        continue; // broken settings files don't block MCP translation; the mcp.json parse warns separately
      }
      if (!isPlainObject(data) || !Array.isArray(data.disabledMcpjsonServers)) continue;
      for (const entry of data.disabledMcpjsonServers) {
        if (typeof entry === "string") disabled.add(entry);
      }
    }
  }
  return disabled;
}

/**
 * Expand every string in `fields` (labelled for diagnostics as
 * `mcp.<name><label>`), collecting NAME-only warnings. Returns the expanded
 * map plus whether any `${input:}` reference resolved nowhere (caller drops
 * the whole server in that case).
 */
function expandFields(
  ctx: Ctx,
  serverName: string,
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
    });
    values.set(label, out.value);
    for (const _variable of out.unexpandedVars) {
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
  disabled: ReadonlySet<string>,
): { value?: Record<string, unknown>; diags: Diagnostic[] } {
  const diags: Diagnostic[] = [];
  const field = (suffix = "") => `mcp.${name}${suffix}`;

  if (!isPlainObject(entry)) {
    diags.push({ level: "warn", source: SOURCE, field: field(), reason: "invalid-shape" });
    return { diags };
  }
  if (disabled.has(name)) {
    diags.push({ level: "info", source: SOURCE, field: field(), reason: "disabled-mcpjson-server" });
    return { diags };
  }

  const type = typeof entry.type === "string" ? entry.type : undefined;
  const hasUrl = typeof entry.url === "string";

  if (hasUrl && type === undefined) {
    diags.push({ level: "warn", source: SOURCE, field: field(), reason: "url-without-type" });
    return { diags };
  }

  const timeout = typeof entry.timeout === "number" ? { timeout: entry.timeout } : {};

  if (type === undefined || type === "stdio") {
    if (typeof entry.command !== "string" || entry.command === "") {
      diags.push({ level: "warn", source: SOURCE, field: field(".command"), reason: "missing-command" });
      return { diags };
    }
    // command occupies index 0 of opencode's command[]; args follow.
    const commandParts = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
      .filter((part): part is string => typeof part === "string");
    const envEntries = isPlainObject(entry.env)
      ? Object.entries(entry.env).filter((pair): pair is [string, string] => typeof pair[1] === "string")
      : [];
    const expanded = expandFields(ctx, name, [
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
    const environment: Record<string, string> = {};
    for (const [key] of envEntries) environment[key] = expanded.values.get(`.environment.${key}`) ?? "";
    if (Object.keys(environment).length > 0) value.environment = environment;
    if (typeof entry.cwd === "string") value.cwd = expanded.values.get(".cwd") ?? "";
    Object.assign(value, timeout);
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
    const expanded = expandFields(ctx, name, [
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
    Object.assign(value, timeout);
    return { value, diags };
  }

  // Unrecognized Claude-native type (e.g. ws): dropped with a warn, never
  // emitted -- apply.ts's invalid-type guard exists for defense in depth,
  // not as this translator's normal path.
  diags.push({ level: "warn", source: SOURCE, field: field(".type"), reason: "unsupported-type" });
  return { diags };
}

export function claudeMcp(ctx: Ctx): Fragment {
  const fragment = emptyFragment();
  const mcp: Record<string, unknown> = {};
  const diags: Diagnostic[] = [];
  const seen = new Set<string>();

  const addScope = (servers: unknown): void => {
    if (!isPlainObject(servers)) return;
    for (const [name, entry] of Object.entries(servers)) {
      if (seen.has(name)) {
        diags.push({ level: "warn", source: SOURCE, field: `mcp.${name}`, reason: "duplicate" });
        continue;
      }
      seen.add(name);
      const translated = translateServer(ctx, name, entry, disabledOnce);
      diags.push(...translated.diags);
      if (translated.value) mcp[name] = translated.value;
    }
  };

  // Perf note: the settings scan is cheap (2 small json files per root) but
  // done once per run rather than once per server.
  const disabledOnce = collectDisabled(ctx);

  for (const root of ctx.projectRoots) {
    const abs = toPosix(join(root, ".mcp.json"));
    if (!isFile(abs)) continue;
    let data: unknown;
    try {
      data = readJson(abs);
    } catch {
      diags.push({ level: "warn", source: SOURCE, file: abs, reason: "unparseable" });
      continue;
    }
    addScope(isPlainObject(data) ? data.mcpServers : undefined);
  }

  if (ctx.options.claude.user) {
    const claudeJson = toPosix(join(ctx.home, ".claude.json"));
    if (isFile(claudeJson)) {
      let data: unknown;
      try {
        data = readJson(claudeJson);
      } catch {
        diags.push({ level: "warn", source: SOURCE, file: claudeJson, reason: "unparseable" });
        data = undefined;
      }
      if (isPlainObject(data)) {
        const projects = isPlainObject(data.projects) ? data.projects : {};
        const localEntry = projects[ctx.worktree];
        const local = isPlainObject(localEntry) ? localEntry : {};
        addScope(local.mcpServers);
        addScope(data.mcpServers);
      }
    }
  }

  if (Object.keys(mcp).length > 0) fragment.mcp = mcp;
  fragment.diagnostics = diags;
  return fragment;
}
