/**
 * B7: `.github/agents/**\/*.agent.md` (+ `*.chatmode.md`, also under
 * `.github/chatmodes/` -- VS Code's own directory for chat modes) and
 * `~/.copilot/agents` -> `cfg.agent[name]`. Mapping table: plan part 5
 * (B7); sibling of the Claude agents translator (B1) and reuses its
 * worked-example shape: pure function of `Ctx`, emit `permission` never
 * `tools` (F5), every skip a diagnostic.
 */
import { basename, join } from "node:path";
import type { Diagnostic } from "../../diagnostics.js";
import { listFiles, readText } from "../../fs.js";
import { isFrontmatterError, parseFrontmatter } from "../../frontmatter.js";
import { sanitizeMcpSegment } from "../../permission.js";
import type { Ctx } from "../../context.js";
import { emptyFragment, type Fragment } from "../types.js";

const SOURCE = "copilot.agents";

/**
 * B7 "drop" row -- documented in README limitations, surfaced as one info
 * per file naming the fields. `mcp-servers` is cloud-only (`${{ secrets.X }}`),
 * the rest have no opencode agent-field equivalent.
 */
const DROPPED_FIELDS = ["mcp-servers", "handoffs", "hooks", "target", "argument-hint", "metadata", "infer"];

export interface CopilotAgentsDiscovery {
  /** Translated `cfg.agent` entries, keyed by agent name. */
  agents: Record<string, Record<string, unknown>>;
  diagnostics: Diagnostic[];
}

/**
 * Copilot tool-family -> opencode tool names (B7 tools row). The family key
 * is matched with an optional trailing `/*` stripped (`read/*` == `read`);
 * everything in a family's array is allowed when the family appears in the
 * allowlist. Anything not listed here and not `<server>/<tool>` is dropped +
 * info.
 */
const TOOL_FAMILIES: Record<string, string[]> = {
  read: ["read"],
  readFile: ["read"],
  edit: ["edit"],
  editFiles: ["edit"],
  createFile: ["edit"],
  createDirectory: ["edit"],
  execute: ["bash"],
  runInTerminal: ["bash"],
  runCommands: ["bash"],
  runTasks: ["bash"],
  search: ["grep", "glob", "list"],
  codebase: ["grep", "glob", "list"],
  fileSearch: ["grep", "glob", "list"],
  textSearch: ["grep", "glob", "list"],
  usages: ["grep", "glob", "list"],
  listDirectory: ["grep", "glob", "list"],
  web: ["webfetch", "websearch"],
  fetch: ["webfetch", "websearch"],
  agent: ["task"],
  runSubagent: ["task"],
  todos: ["todowrite"],
};

/** Copilot tool names that are not MCP servers but carry a `/` prefix. */
const PREFIXED_TOOL_MAP: Record<string, string[]> = {
  "vscode/askQuestions": ["question"],
};

interface ToolsResult {
  /** The ruleset for `cfg.agent[name].permission`; absent when there is nothing to constrain. */
  permission?: Record<string, unknown>;
  /** Tool names dropped because no family maps them (for one info diagnostic per file). */
  dropped: string[];
}

/**
 * B7 tools row: an allowlist (array or comma-separated string; `"*"`) ->
 * `{ "*": "deny", ...allows }`, the same shape as B1/opencode's native
 * `explore`. `"*"` or absent -> no rule at all.
 */
function translateTools(raw: unknown): ToolsResult {
  const entries =
    typeof raw === "string"
      ? raw.split(",").map((s) => s.trim()).filter((s) => s !== "")
      : Array.isArray(raw)
        ? raw.flatMap((v) => (typeof v === "string" ? v.split(",").map((s) => s.trim()) : [])).filter((s) => s !== "")
        : [];

  if (entries.length === 0 || entries.includes("*")) return { dropped: [] };

  const permission: Record<string, unknown> = { "*": "deny" };
  const dropped: string[] = [];
  let used = false;

  for (const entry of entries) {
    // Exact/prefixed names first ("vscode/askQuestions"), then family with
    // an optional trailing "/*", then Copilot's MCP form "<server>/<tool>".
    let mapped = PREFIXED_TOOL_MAP[entry] ?? TOOL_FAMILIES[entry];
    if (mapped === undefined && entry.endsWith("/*")) {
      mapped = PREFIXED_TOOL_MAP[entry.slice(0, -2)] ?? TOOL_FAMILIES[entry.slice(0, -2)];
    }
    if (mapped === undefined && entry.includes("/")) {
      const slash = entry.indexOf("/");
      const server = entry.slice(0, slash);
      const tool = entry.slice(slash + 1);
      if (server !== "" && tool !== "" && tool !== "*") {
        // opencode names MCP tool ids `<server>_<tool>` after its own
        // sanitization (McpCatalog.toolName, v1.18.21 -- same rule B1 uses).
        mapped = [`${sanitizeMcpSegment(server)}_${sanitizeMcpSegment(tool)}`];
      } else if (server !== "") {
        // "<server>/*" or bare "<server>" -> whole-server wildcard id.
        mapped = [`${sanitizeMcpSegment(server)}_*`];
      }
    }
    if (mapped === undefined) {
      dropped.push(entry);
      continue;
    }
    used = true;
    for (const tool of mapped) permission[tool] = "allow";
  }

  if (!used) return { dropped };
  return { permission, dropped };
}

/**
 * B7 agents row: which subagents this agent may invoke. `[]` -> task deny;
 `[a,b]` -> `{"*": "deny", a: "allow", b: "allow"}`; `["*"]` / absent ->
 * no rule. Applied AFTER the tools allowlist so an explicit deny wins.
 */
function applyAgentsRule(permission: Record<string, unknown>, raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  const names = raw.flatMap((v) => (typeof v === "string" ? [v.trim()] : [])).filter((s) => s !== "");
  if (names.length === 0) {
    // Empty (or whitespace-only) list: subagents explicitly disallowed.
    // Note this is NOT the same as the field being absent (no rule at all).
    permission.task = "deny";
    return true;
  }
  if (names.includes("*")) return false; // ["*"] -> all subagents, no rule needed
  const bucket =
    typeof permission.task === "object" && permission.task !== null
      ? (permission.task as Record<string, unknown>)
      : typeof permission.task === "string"
        ? { "*": permission.task }
        : {};
  bucket["*"] ??= "deny";
  for (const name of names) bucket[name] = "allow";
  permission.task = bucket;
  return true;
}

/**
 * B7 model row: a string or array of strings resolved through
 * `options.models`; arrays take the first mappable candidate. Unmapped ->
 * omitted + info (never guessed -- C2).
 */
function translateModel(raw: unknown, ctx: Ctx): { model?: string; unmapped: boolean } {
  const candidates = Array.isArray(raw) ? raw : [raw];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && ctx.options.models[candidate] !== undefined) {
      const mapped = ctx.options.models[candidate];
      if (mapped !== "") return { model: mapped, unmapped: false };
    }
  }
  const present = candidates.some((c) => typeof c === "string" && c.trim() !== "");
  return { model: undefined, unmapped: present };
}

function translateFile(abs: string, ctx: Ctx): { name?: string; agent?: Record<string, unknown>; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const text = readText(abs);
  if (text === undefined) return { diagnostics };

  const parsed = parseFrontmatter(text);
  if (isFrontmatterError(parsed)) {
    diagnostics.push({ level: "warn", source: SOURCE, file: abs, reason: "unparseable" });
    return { diagnostics };
  }
  const data = parsed.data;

  const base = basename(abs);
  const fileKey = base.replace(/\.(agent|chatmode)\.md$/i, "");
  const name =
    typeof data.name === "string" && data.name.trim() !== "" ? data.name.trim() : fileKey;
  if (name === "") return { diagnostics };

  // B7 description row: missing description -> skipped + info (Copilot only
  // shows described agents in its picker; there is nothing to render anyway).
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!description) {
    diagnostics.push({ level: "info", source: SOURCE, file: abs, field: "description", reason: "missing-description" });
    return { diagnostics };
  }

  const agent: Record<string, unknown> = {
    description,
    prompt: parsed.content.trim(),
    mode: "all", // B7: a Copilot agent is both user-invocable and model-invocable by default
  };

  // B7 mode row: narrow the default "all".
  if (data["user-invocable"] === false) {
    agent.mode = "subagent"; // not user-invocable -> model-invocable only
  } else if (data["disable-model-invocation"] === true) {
    agent.mode = "primary"; // user-invocable only
  }

  // B7 tools row -> permission (F5: emit `permission`, never `tools`).
  const tools = translateTools(data.tools);
  if (tools.permission) agent.permission = tools.permission;

  // B7 agents row, after tools so an explicit subagent deny wins over the
  // `agent` tool family's allow.
  const permissionForAgents =
    typeof agent.permission === "object" && agent.permission !== null
      ? (agent.permission as Record<string, unknown>)
      : {};
  if (applyAgentsRule(permissionForAgents, data.agents)) {
    agent.permission = permissionForAgents;
  }

  const model = translateModel(data.model, ctx);
  if (model.model) agent.model = model.model;
  else if (model.unmapped)
    diagnostics.push({
      level: "info",
      source: SOURCE,
      file: abs,
      field: "model",
      reason: "unmapped-model (add it to the plugin's \"models\" option to map it)",
    });

  if (tools.dropped.length > 0) {
    diagnostics.push({
      level: "info",
      source: SOURCE,
      file: abs,
      field: "tools",
      reason: `dropped-tools: ${tools.dropped.join(", ")}`,
    });
  }

  const dropped = DROPPED_FIELDS.filter((field) => data[field] !== undefined);
  if (dropped.length > 0) {
    diagnostics.push({ level: "info", source: SOURCE, file: abs, reason: `dropped-fields: ${dropped.join(", ")}` });
  }

  return { name, agent, diagnostics };
}

/** Project roots nearest-first, then (if `copilot.user`) `~/.copilot/agents`. */
function agentDirs(ctx: Ctx): string[] {
  const dirs: string[] = [];
  for (const root of ctx.projectRoots) {
    dirs.push(join(root, ".github", "agents"));
    dirs.push(join(root, ".github", "chatmodes"));
  }
  if (ctx.options.copilot.user) dirs.push(join(ctx.home, ".copilot", "agents"));
  return dirs;
}

export function discoverCopilotAgents(ctx: Ctx): CopilotAgentsDiscovery {
  const diagnostics: Diagnostic[] = [];
  const agents: Record<string, Record<string, unknown>> = {};

  for (const dir of agentDirs(ctx)) {
    for (const file of listFiles(dir, [".agent.md", ".chatmode.md"])) {
      const { name, agent, diagnostics: fileDiags } = translateFile(file, ctx);
      diagnostics.push(...fileDiags);
      if (!name || !agent) continue;
      if (name in agents) {
        diagnostics.push({ level: "warn", source: SOURCE, file, field: `agent.${name}`, reason: "duplicate" });
        continue;
      }
      agents[name] = agent;
    }
  }

  return { agents, diagnostics };
}

export function copilotAgents(ctx: Ctx): Fragment {
  const fragment = emptyFragment();
  const found = discoverCopilotAgents(ctx);
  for (const diagnostic of found.diagnostics) ctx.diag.add(diagnostic);
  if (Object.keys(found.agents).length > 0) fragment.agent = found.agents;
  fragment.diagnostics = found.diagnostics;
  return fragment;
}
