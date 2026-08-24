/**
 * Ordered, toggle-gated source registry. **Every** source lives here, real
 * or stub (S1 owns this file; S2-S5 each replace one stub module's
 * *content*, never a line in this registry).
 *
 * Order is fixed: Claude sources before Copilot, and within one source its
 * own project root(s) nearest-to-`directory` first, then (if `*.user`) the
 * user-scope root. This is a source-module-grained reading of precedence
 * rule 2 ("project Claude -> project Copilot -> user Claude -> user
 * Copilot") -- see the design note's "Precedence" section for why, and for
 * when to revisit it.
 *
 * Per-source try/catch: opencode only ignores a *hook* throwing (F2); a
 * mid-way throw inside our own hook would still leave partial injection.
 */
import type { Ctx } from "../context.js";
import type { Options } from "../options.js";
import type { Fragment, SourceFn } from "./types.js";
import { emptyFragment } from "./types.js";
import { claudeAgents } from "./claude/agents.js";
import { claudeCommands } from "./claude/commands.js";
import { claudeMcp } from "./claude/mcp.js";
import { copilotInstructions } from "./copilot/instructions.js";
import { copilotPrompts } from "./copilot/prompts.js";
import { copilotAgents } from "./copilot/agents.js";
import { copilotSkills } from "./copilot/skills.js";
import { copilotMcp } from "./copilot/mcp.js";

interface SourceEntry {
  key: string;
  enabled: (options: Options) => boolean;
  run: SourceFn;
}

export const registry: readonly SourceEntry[] = [
  { key: "claude.agents", enabled: (o) => o.claude.agents, run: claudeAgents },
  { key: "claude.commands", enabled: (o) => o.claude.commands, run: claudeCommands },
  { key: "claude.mcp", enabled: (o) => o.claude.mcp, run: claudeMcp },
  { key: "copilot.instructions", enabled: (o) => o.copilot.instructions, run: copilotInstructions },
  { key: "copilot.prompts", enabled: (o) => o.copilot.prompts, run: copilotPrompts },
  { key: "copilot.agents", enabled: (o) => o.copilot.agents, run: copilotAgents },
  { key: "copilot.skills", enabled: (o) => o.copilot.skills, run: copilotSkills },
  { key: "copilot.mcp", enabled: (o) => o.copilot.mcp, run: copilotMcp },
];

export interface SourceResult {
  key: string;
  fragment: Fragment;
}

/** Runs every enabled source, in registry order, catching per-source throws. */
export function runSources(ctx: Ctx): SourceResult[] {
  const out: SourceResult[] = [];
  for (const entry of registry) {
    if (!entry.enabled(ctx.options)) continue;
    try {
      out.push({ key: entry.key, fragment: entry.run(ctx) });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      ctx.diag.add({ level: "warn", source: entry.key, reason: `source threw: ${reason}` });
      out.push({ key: entry.key, fragment: emptyFragment() });
    }
  }
  return out;
}
