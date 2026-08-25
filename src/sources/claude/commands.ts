/**
 * B2: `.claude/commands/**\/*.md`, `~/.claude/commands/**\/*.md` -> `cfg.command[name]`.
 *
 * Argument placeholders (F12, verified 2026-08-24 against the current Claude
 * Code skills doc, "Available string substitutions": `$N` is shorthand for
 * `$ARGUMENTS[N]`, "$0 for the first argument or $1 for the second" -- i.e.
 * 0-based; opencode's `$N` is 1-based, `session/prompt.ts` v1.18.21:1383-1389
 * substitutes `placeholderRegex = /\$(\d+)/g` with `argIndex = position - 1`):
 * - `$ARGUMENTS[N]` -> `$<N+1>`
 * - `$N`            -> `$<N+1>`
 * - named `arguments:` entries -> positional `$1..$k` in declaration order
 * - `$ARGUMENTS` stays as-is (opencode understands it natively)
 * - `${CLAUDE_PROJECT_DIR}` -> the worktree root
 * - `` !`cmd` `` shell injection and `@file` references pass through unchanged
 *   (identical syntax in opencode)
 * Claude's `\$` escape becomes a literal `$` AFTER the shift so it is not
 * itself shifted. Limitation (README): opencode has no template escape -- its
 * substitution regex runs over the whole template unconditionally -- so an
 * escaped `$1` still reads as a positional reference to opencode.
 */
import type { Diagnostic } from "../../diagnostics.js";
import { readText } from "../../fs.js";
import { isFrontmatterError, parseFrontmatter } from "../../frontmatter.js";
import { mapModel } from "../../model.js";
import type { Ctx } from "../../context.js";
import { emptyFragment, type Fragment } from "../types.js";
import { discoverClaudeAgents } from "./agents.js";
import { claudeMarkdownFiles, commandKeyFromFile } from "./util.js";

const SOURCE = "claude.commands";

/** B2 "drop" row -- documented in README limitations, surfaced as one info per file. */
const DROPPED_FIELDS = [
  "allowed-tools",
  "disallowed-tools",
  "disable-model-invocation",
  "user-invocable",
  "hooks",
  "paths",
  "effort",
  "when_to_use",
  "background",
];

/** B2 `context: fork` + `agent`: built-in Claude subagent types with opencode equivalents. */
const FORK_AGENT_MAP: Record<string, string> = {
  Explore: "explore",
  Plan: "plan",
  "general-purpose": "general",
};

/**
 * `arguments:` frontmatter -- a space-separated string or a YAML list of
 * names ("Names map to argument positions in order", current skills doc).
 */
function namedArguments(raw: unknown): string[] {
  if (typeof raw === "string") return raw.split(/\s+/).filter((s) => s !== "");
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  return [];
}

/**
 * Rewrite the command body. Positional rewrites stash their final `$n` text
 * behind a sentinel first, so the later bare-`$N` pass cannot shift an
 * already-shifted placeholder a second time.
 */
export function translateBody(
  body: string,
  opts: { argumentNames: string[]; worktree: string },
): string {
  const finals: string[] = [];
  const stash = (finalText: string): string => {
    finals.push(finalText);
    return `\u0000${finals.length - 1}\u0000`;
  };

  let out = body;

  // Named arguments -> their 1-based position ($issue with arguments:
  // [issue, branch] -> $1). Token-exact: a trailing non-name-character guard
  // stops `$branch` from matching inside `$branches` (Claude's substitution
  // is token-exact too). Function replacement, so stashed placeholders are
  // never re-read as replacement-string `$` patterns.
  opts.argumentNames.forEach((argName, index) => {
    const escaped = argName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\$${escaped}(?![A-Za-z0-9_])`, "g"), () => stash(`$${index + 1}`));
  });

  // $ARGUMENTS[N] before bare $N so the bracket form is not double-matched.
  out = out.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, n: string) => stash(`$${Number(n) + 1}`));

  // Bare $N, skipping Claude's \$ escape (un-escaped in step 5 below).
  out = out.replace(/(?<!\\)\$(\d+)/g, (_, n: string) => stash(`$${Number(n) + 1}`));

  out = out.split("${CLAUDE_PROJECT_DIR}").join(opts.worktree);

  out = out.replaceAll("\\$", "$");

  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => finals[Number(i)] ?? "");
}

export interface ClaudeCommandsDiscovery {
  /** Translated `cfg.command` entries, keyed by command name. */
  commands: Record<string, Record<string, unknown>>;
  diagnostics: Diagnostic[];
}

export function discoverClaudeCommands(ctx: Ctx): ClaudeCommandsDiscovery {
  const diagnostics: Diagnostic[] = [];
  const commands: Record<string, Record<string, unknown>> = {};

  // Names of agents this same run translates from .claude/agents (B2 keeps a
  // `context: fork` agent when it is a known built-in OR a rosetta Claude
  // agent). Only consult them when the agents source is actually enabled --
  // discoverClaudeAgents is pure (diagnostics returned, none pushed to
  // ctx.diag), but honoring the toggle keeps the two sources' contract honest.
  const rosettaAgentNames =
    ctx.options.claude.agents
      ? new Set(Object.keys(discoverClaudeAgents(ctx).agents))
      : new Set<string>();

  for (const file of claudeMarkdownFiles(ctx, "commands")) {
    const text = readText(file, (reason) => diagnostics.push({ level: "warn", source: SOURCE, file, reason }));
    if (text === undefined) continue;

    const parsed = parseFrontmatter(text);
    if (isFrontmatterError(parsed)) {
      diagnostics.push({ level: "warn", source: SOURCE, file, reason: "unparseable" });
      continue;
    }
    const data = parsed.data;

    // B2: key = file basename without extension; subdirs are NOT part of the
    // name (Claude docs: "file name without extension"); collision ->
    // precedence + warn.
    const key = commandKeyFromFile(file);
    if (key === "") continue;
    if (key in commands) {
      diagnostics.push({
        level: "warn",
        source: SOURCE,
        file,
        field: `command.${key}`,
        reason: "duplicate",
      });
      continue;
    }

    const command: Record<string, unknown> = {
      template: translateBody(parsed.content, {
        argumentNames: namedArguments(data.arguments),
        worktree: ctx.worktree,
      }).trim(),
    };

    let description = typeof data.description === "string" ? data.description.trim() : "";
    if (description !== "" && typeof data["argument-hint"] === "string" && data["argument-hint"].trim() !== "") {
      description = `${description} — args: ${data["argument-hint"].trim()}`;
    }
    if (description !== "") command.description = description;

    const model = mapModel(data.model, ctx.options.models, SOURCE);
    if (model.model) command.model = model.model;
    if (model.diagnostic) diagnostics.push({ ...model.diagnostic, file });

    if (data.context === "fork") {
      command.subtask = true;
      const forkAgent = typeof data.agent === "string" ? data.agent.trim() : "";
      if (forkAgent !== "") {
        const mappedAgent = FORK_AGENT_MAP[forkAgent] ?? (rosettaAgentNames.has(forkAgent) ? forkAgent : undefined);
        if (mappedAgent) command.agent = mappedAgent;
        else
          diagnostics.push({
            level: "info",
            source: SOURCE,
            file,
            field: "agent",
            reason: `unknown-fork-agent: "${forkAgent}"`,
          });
      }
    }

    const dropped = DROPPED_FIELDS.filter((field) => data[field] !== undefined);
    if (dropped.length > 0) {
      diagnostics.push({ level: "info", source: SOURCE, file, reason: `dropped-fields: ${dropped.join(", ")}` });
    }

    commands[key] = command;
  }

  return { commands, diagnostics };
}

export function claudeCommands(ctx: Ctx): Fragment {
  const fragment = emptyFragment();
  const found = discoverClaudeCommands(ctx);
  // Diagnostics go to ctx.diag (what runtime flushes via client.app.log) AND
  // onto the fragment (what unit tests assert on); they are copies, so a
  // consumer that ignores one channel does not suppress the other.
  for (const diagnostic of found.diagnostics) ctx.diag.add(diagnostic);
  if (Object.keys(found.commands).length > 0) fragment.command = found.commands;
  fragment.diagnostics = found.diagnostics;
  return fragment;
}
