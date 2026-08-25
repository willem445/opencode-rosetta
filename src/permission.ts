/**
 * B1 "tools"/"disallowedTools" rows (and the same shape reused by B7 later):
 * a Claude tool list -> an opencode `permission` ruleset.
 *
 * F5: hook-injected agent objects bypass opencode's schema decoder, which is
 * the only place that converts a `tools:` allowlist into permissions -- so we
 * do the conversion here and the caller emits `permission`, never `tools`.
 * `apply.ts` enforces this (`emits-tools-not-permission`).
 *
 * Allowlist semantics: Claude `tools: A, B` means "only A and B", so the
 * ruleset is `{ "*": "deny", <a>: "allow", <b>: "allow" }` -- the same shape
 * as opencode's native `explore` agent. `tools` absent -> no rule at all
 * (the agent keeps opencode's defaults).
 *
 * MCP tool ids: opencode names MCP tools `<server>_<tool>` after its own
 * sanitization (`McpCatalog.toolName = sanitize(clientName) + "_" +
 * sanitize(name)`, `sanitize = v => v.replace(/[^a-zA-Z0-9_-]/g, "_")`,
 * verified in `packages/opencode/src/mcp/catalog.ts` at tag v1.18.21). So
 * Claude `mcp__srv` -> `"srv_*": "allow"` and `mcp__srv__tool` ->
 * `"srv_tool": "allow"`, with both segments run through the same sanitizer.
 */
import type { Diagnostic } from "./diagnostics.js";

/** Same character class as opencode's `McpCatalog.sanitize` (v1.18.21). */
export function sanitizeMcpSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

const TOOL_MAP: Record<string, string> = {
  Read: "read",
  Write: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "bash",
  Glob: "glob",
  Grep: "grep",
  LS: "list",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  Task: "task",
  Agent: "task",
  TodoWrite: "todowrite",
  Skill: "skill",
  AskUserQuestion: "question",
};

export interface PermissionResult {
  /** The ruleset for `cfg.agent[name].permission`; absent when there is nothing to constrain. */
  permission?: Record<string, unknown>;
  diagnostics: Diagnostic[];
}

interface Entry {
  /** Claude tool name, e.g. `Read`, `Bash`, `mcp__srv`. */
  name: string;
  /** Parenthesized spec, e.g. `git *` in `Bash(git *)`; undefined when absent/empty. */
  spec?: string;
}

/** A diagnostic before the caller attaches `source`/`file`. */
type PendingDiagnostic = Omit<Diagnostic, "source">;

/** Split on top-level commas only -- `Task(a, b)` must stay one entry. */
function splitTopLevelCommas(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of value) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function parseEntries(raw: unknown): { entries: Entry[] } {
  const list =
    typeof raw === "string"
      ? splitTopLevelCommas(raw)
      : Array.isArray(raw)
        ? raw.flatMap((v) => (typeof v === "string" ? splitTopLevelCommas(v) : []))
        : [];
  const entries: Entry[] = [];
  for (const item of list) {
    const trimmed = item.trim();
    if (trimmed === "") continue;
    const m = trimmed.match(/^([^(]+)(?:\((.*)\))?$/);
    if (!m) continue;
    const name = (m[1] ?? "").trim();
    const spec = m[2]?.trim();
    entries.push({ name, spec: spec === "" ? undefined : spec });
  }
  return { entries };
}

/**
 * Convert one entry into a permission write against `permission`.
 * Returns a diagnostic when the entry is not translatable and must be dropped.
 */
function applyEntry(
  permission: Record<string, unknown>,
  entry: Entry,
  action: "allow" | "deny",
): PendingDiagnostic | undefined {
  // mcp__srv | mcp__srv__tool | mcp__* (the last one has no opencode equivalent)
  if (entry.name.startsWith("mcp__")) {
    if (action === "deny") {
      // No "all MCP" key exists in opencode's permission namespace; a blanket
      // MCP deny cannot be expressed, so dropping silently would widen access.
      return {
        level: "warn",
        field: "disallowedTools",
        reason: `dropped "${entry.name}": no all-MCP deny rule exists in opencode permissions`,
      };
    }
    const rest = entry.name.slice("mcp__".length);
    if (rest === "*" || rest === "") {
      return {
        level: "warn",
        field: "tools",
        reason: `dropped "${entry.name}": no all-MCP allow rule exists in opencode permissions`,
      };
    }
    const [server, ...toolParts] = rest.split("__");
    const key =
      toolParts.length === 0
        ? `${sanitizeMcpSegment(server ?? "")}_*`
        : `${sanitizeMcpSegment(server ?? "")}_${toolParts.map(sanitizeMcpSegment).join("_")}`;
    permission[key] = action;
    return undefined;
  }

  const mapped = TOOL_MAP[entry.name];
  if (mapped === undefined) {
    return {
      level: "warn",
      field: action === "allow" ? "tools" : "disallowedTools",
      reason: `unknown-tool: "${entry.name}"`,
    };
  }

  if (entry.spec === undefined) {
    const current = permission[mapped];
    if (typeof current === "object" && current !== null) {
      // plain rule over an existing pattern bucket: "*" is the whole-tool
      // posture in both readings (opencode permission globs and the task
      // subagent list), so it merges instead of clobbering.
      (current as Record<string, unknown>)["*"] = action;
    } else {
      permission[mapped] = action;
    }
    return undefined;
  }

  // Tool(spec): narrow grant under that tool, e.g. Bash(git *) -> bash["git *"].
  // For Task/Agent the parenthesized value is a comma-separated list of
  // subagent types (B1: Agent(a, b) -> task: {"*":"deny", a:"allow",
  // b:"allow"}), and "*" pins the whole-tool posture so unlisted types keep
  // the allowlist stance.
  const specs =
    mapped === "task"
      ? entry.spec.split(",").map((s) => s.trim()).filter((s) => s !== "")
      : [entry.spec];

  const current = permission[mapped];
  const bucket =
    typeof current === "object" && current !== null
      ? (current as Record<string, unknown>)
      : typeof current === "string"
        ? { "*": current }
        : {};
  if (mapped === "task") bucket["*"] ??= "deny";
  for (const spec of specs) bucket[spec] = action;
  permission[mapped] = bucket;
  return undefined;
}

/**
 * Build the `permission` ruleset from a Claude agent/command frontmatter's
 * `tools` + `disallowedTools`. `source`/`file` are attached to diagnostics.
 */
export function toolsToPermission(input: {
  tools?: unknown;
  disallowedTools?: unknown;
  source: string;
  file: string;
}): PermissionResult {
  const diagnostics: Diagnostic[] = [];

  const tools = parseEntries(input.tools);
  const disallowed = parseEntries(input.disallowedTools);

  const hasAllowlist = tools.entries.length > 0;
  const permission: Record<string, unknown> = {};
  let used = false;

  if (hasAllowlist) {
    // Allowlist semantics: everything not listed is denied (same shape as
    // opencode's native `explore`). Side effect, documented in README:
    // `question`/`todowrite` are denied too unless explicitly listed.
    permission["*"] = "deny";
    for (const entry of tools.entries) {
      const drop = applyEntry(permission, entry, "allow");
      if (drop) diagnostics.push({ ...drop, source: input.source, file: input.file });
    }
    used = true;
  }

  for (const entry of disallowed.entries) {
    const drop = applyEntry(permission, entry, "deny");
    if (drop) diagnostics.push({ ...drop, source: input.source, file: input.file });
    else used = true;
  }

  if (!used) return { diagnostics };
  return { permission, diagnostics };
}
