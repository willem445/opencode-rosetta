/**
 * B1: `.claude/agents/**\/*.md`, `~/.claude/agents/**\/*.md` -> `cfg.agent[name]`.
 * Mapping table: plan part 4 (B1); mechanism: design note 0001 (pure function
 * of `Ctx`, `permission` never `tools` per F5).
 */
import type { Diagnostic } from "../../diagnostics.js";
import { readText } from "../../fs.js";
import { isFrontmatterError, parseFrontmatter } from "../../frontmatter.js";
import { mapModel } from "../../model.js";
import { toolsToPermission } from "../../permission.js";
import type { Ctx } from "../../context.js";
import { emptyFragment, type Fragment } from "../types.js";
import { claudeMarkdownFiles } from "./util.js";

const SOURCE = "claude.agents";

const COLOR_MAP: Record<string, string> = {
  red: "error",
  blue: "primary",
  green: "success",
  yellow: "warning",
  purple: "secondary",
  orange: "accent",
  pink: "accent",
  cyan: "info",
};

/** B1 "drop" row -- documented in README limitations, surfaced as one info per file. */
const DROPPED_FIELDS = [
  "skills",
  "mcpServers",
  "hooks",
  "memory",
  "background",
  "effort",
  "isolation",
  "initialPrompt",
];

/**
 * permissionMode values with no opencode equivalent (C4: in particular,
 * `bypassPermissions` is deliberately NOT mapped to `"*": "allow"` -- the
 * orchestrator adopted the planner recommendation).
 */
const NO_OP_PERMISSION_MODES = ["default", "manual", "auto", "dontAsk", "bypassPermissions"];

export interface ClaudeAgentsDiscovery {
  /** Translated `cfg.agent` entries, keyed by agent name. */
  agents: Record<string, Record<string, unknown>>;
  diagnostics: Diagnostic[];
}

export function discoverClaudeAgents(ctx: Ctx): ClaudeAgentsDiscovery {
  const diagnostics: Diagnostic[] = [];
  const agents: Record<string, Record<string, unknown>> = {};

  for (const file of claudeMarkdownFiles(ctx, "agents")) {
    const text = readText(file, (reason) => diagnostics.push({ level: "warn", source: SOURCE, file, reason }));
    if (text === undefined) continue;

    const parsed = parseFrontmatter(text);
    if (isFrontmatterError(parsed)) {
      diagnostics.push({ level: "warn", source: SOURCE, file, reason: "unparseable" });
      continue;
    }
    const data = parsed.data;

    // No usable `name` -> skipped silently: to Claude this is a docs file.
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (!name) continue;
    if (name.includes(":") || name.startsWith("-")) {
      diagnostics.push({ level: "warn", source: SOURCE, file, field: "name", reason: `invalid-name: "${name}"` });
      continue;
    }

    // `name` without `description` -> skipped + info (Claude does the same).
    const description = typeof data.description === "string" ? data.description.trim() : "";
    if (!description) {
      diagnostics.push({ level: "info", source: SOURCE, file, field: "description", reason: "missing-description" });
      continue;
    }

    if (name in agents) {
      diagnostics.push({
        level: "warn",
        source: SOURCE,
        file,
        field: `agent.${name}`,
        reason: "duplicate",
      });
      continue;
    }

    const agent: Record<string, unknown> = {
      description,
      prompt: parsed.content.trim(),
      mode: "subagent", // B1: Claude subagents are subagents; keeps the primary picker clean
    };

    // tools/disallowedTools -> permission (F5: emit `permission`, never `tools`).
    const perm = toolsToPermission({ tools: data.tools, disallowedTools: data.disallowedTools, source: SOURCE, file });
    diagnostics.push(...perm.diagnostics);
    if (perm.permission) agent.permission = perm.permission;

    if (data.permissionMode !== undefined) {
      const mode = typeof data.permissionMode === "string" ? data.permissionMode.trim() : String(data.permissionMode);
      if (mode === "plan") {
        agent.permission = { ...(typeof agent.permission === "object" && agent.permission !== null ? agent.permission : {}), edit: "deny" };
      } else if (mode === "acceptEdits") {
        agent.permission = { ...(typeof agent.permission === "object" && agent.permission !== null ? agent.permission : {}), edit: "allow" };
      } else {
        diagnostics.push({
          level: "info",
          source: SOURCE,
          file,
          field: "permissionMode",
          reason:
            NO_OP_PERMISSION_MODES.includes(mode)
              ? `permission-mode-not-mapped: "${mode}" has no opencode equivalent`
              : `unknown-permission-mode: "${mode}"`,
        });
      }
    }

    const model = mapModel(data.model, ctx.options.models, SOURCE);
    if (model.model) agent.model = model.model;
    if (model.diagnostic) diagnostics.push({ ...model.diagnostic, file });

    if (typeof data.color === "string" && data.color.trim() !== "") {
      const color = COLOR_MAP[data.color.trim()];
      if (color) agent.color = color;
      else
        diagnostics.push({
          level: "info",
          source: SOURCE,
          file,
          field: "color",
          reason: `unmapped-color: "${data.color}"`,
        });
    }

    if (data.maxTurns !== undefined) {
      if (typeof data.maxTurns === "number" && Number.isFinite(data.maxTurns) && data.maxTurns > 0) {
        agent.steps = data.maxTurns;
      } else {
        diagnostics.push({
          level: "info",
          source: SOURCE,
          file,
          field: "maxTurns",
          reason: `invalid-max-turns: ${JSON.stringify(String(data.maxTurns))}`,
        });
      }
    }

    const dropped = DROPPED_FIELDS.filter((field) => data[field] !== undefined);
    if (dropped.length > 0) {
      diagnostics.push({
        level: "info",
        source: SOURCE,
        file,
        reason: `dropped-fields: ${dropped.join(", ")}`,
      });
    }

    agents[name] = agent;
  }

  return { agents, diagnostics };
}

export function claudeAgents(ctx: Ctx): Fragment {
  const fragment = emptyFragment();
  const found = discoverClaudeAgents(ctx);
  for (const diagnostic of found.diagnostics) ctx.diag.add(diagnostic);
  if (Object.keys(found.agents).length > 0) fragment.agent = found.agents;
  fragment.diagnostics = found.diagnostics;
  return fragment;
}
