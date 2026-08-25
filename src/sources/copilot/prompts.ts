/**
 * B6: `.github/prompts/` tree (`*.prompt.md`) -> `cfg.command[name]`.
 *
 * Placeholder translation (verified against the Copilot prompt-files docs
 * the plan grounds on): one distinct `${input:x}` becomes `$ARGUMENTS`,
 * several become `$1..$N` by first appearance (repeats reuse their number);
 * `${workspaceFolder}` becomes the absolute worktree path; `#file:path`
 * becomes opencode's `@path`; everything else VS Code-specific (`${file}`,
 * `${selection}`, `#tool:x`, ...) is left literal + a `warn`, because a
 * silent drop would corrupt a prompt the author did test in Copilot.
 */
import { basename, join } from "node:path";
import type { Ctx } from "../../context.js";
import { listFiles, readText, toPosix } from "../../fs.js";
import { parseFrontmatter, isFrontmatterError } from "../../frontmatter.js";
import { emptyFragment, type Fragment } from "../types.js";

/** opencode's non-hidden native agents (agent/agent.ts @ v1.18.21): build, plan, general, explore. */
const KNOWN_AGENTS = new Set(["build", "plan", "general", "explore"]);
/** Copilot's legacy prompt-file `mode` values; none has an opencode equivalent. */
const LEGACY_MODES = new Set(["ask", "edit", "agent"]);

const INPUT_RE = /\$\{input:([A-Za-z0-9_-]+)(?::[^}]*)?\}/g;
const LEFTOVER_VAR_RE = /\$\{([A-Za-z][A-Za-z0-9]*)\}/g;
const TOOL_REF_RE = /#tool:(\S+)/g;
const FILE_REF_RE = /#file:(\S+)/g;

interface PromptEntry {
  key: string;
  command: Record<string, unknown>;
}

function translateBody(body: string, worktree: string): { template: string; warnings: string[] } {
  const warnings: string[] = [];

  // Distinct inputs by first appearance -> $ARGUMENTS (one) or $1..$N (many).
  const ids: string[] = [];
  for (const match of body.matchAll(INPUT_RE)) {
    const id = match[1];
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  let template = body;
  if (ids.length === 1) {
    template = template.replaceAll(INPUT_RE, "$ARGUMENTS");
  } else if (ids.length > 1) {
    const numbers = new Map(ids.map((id, index) => [id, `$${index + 1}`]));
    template = template.replace(INPUT_RE, (_all, id: string) => numbers.get(id) ?? _all);
  }

  template = template.replaceAll("${workspaceFolder}", toPosix(worktree));
  template = template.replace(FILE_REF_RE, (_all, path: string) => `@${path}`);

  for (const match of template.matchAll(TOOL_REF_RE)) {
    warnings.push(`unsupported reference "#tool:${match[1]}" left literal`);
  }
  for (const match of template.matchAll(LEFTOVER_VAR_RE)) {
    warnings.push(`variable "\${${match[1]}}" left literal`);
  }
  return { template, warnings };
}

function translateModel(raw: unknown, ctx: Ctx, file: string): { model?: string; unmapped: boolean } {
  const candidates = Array.isArray(raw) ? raw : [raw];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && ctx.options.models[candidate] !== undefined) {
      return { model: ctx.options.models[candidate], unmapped: false };
    }
  }
  const present = Array.isArray(raw) ? raw.length > 0 : typeof raw === "string" && raw.length > 0;
  return { model: undefined, unmapped: present };
}

function translateAgent(rawAgent: unknown, rawMode: unknown): { agent?: string; dropped: boolean } {
  const raw = typeof rawAgent === "string" && rawAgent.length > 0 ? rawAgent : rawMode;
  if (typeof raw !== "string" || raw.length === 0) return { agent: undefined, dropped: false };
  if (KNOWN_AGENTS.has(raw)) return { agent: raw, dropped: false };
  return { agent: undefined, dropped: true };
}

function describe(rawDescription: unknown, rawHint: unknown): string | undefined {
  const description = typeof rawDescription === "string" ? rawDescription : undefined;
  const hint = typeof rawHint === "string" ? rawHint : undefined;
  if (description === undefined) return hint === undefined ? undefined : `— args: ${hint}`;
  return hint === undefined ? description : `${description} — args: ${hint}`;
}

function translateFile(abs: string, ctx: Ctx): { entry?: PromptEntry; diagnostics: Fragment["diagnostics"] } {
  const diagnostics: Fragment["diagnostics"] = [];
  const text = readText(abs);
  if (text === undefined) return { diagnostics };

  const parsed = parseFrontmatter(text);
  if (isFrontmatterError(parsed)) {
    diagnostics.push({ level: "warn", source: "copilot.prompts", file: abs, reason: "unparseable" });
    return { diagnostics };
  }

  const key =
    typeof parsed.data.name === "string" && parsed.data.name.trim().length > 0
      ? parsed.data.name.trim()
      : basename(abs).replace(/\.prompt\.md$/, "");
  if (key.length === 0) {
    diagnostics.push({ level: "warn", source: "copilot.prompts", file: abs, reason: "no-name" });
    return { diagnostics };
  }

  const { template, warnings } = translateBody(parsed.content.trim(), ctx.worktree);
  for (const warning of warnings) {
    diagnostics.push({ level: "warn", source: "copilot.prompts", file: abs, field: "template", reason: warning });
  }

  const command: Record<string, unknown> = { template };
  const description = describe(parsed.data.description, parsed.data["argument-hint"]);
  if (description !== undefined) command.description = description;

  const agentResult = translateAgent(parsed.data.agent, parsed.data.mode);
  if (agentResult.agent !== undefined) {
    command.agent = agentResult.agent;
  } else if (agentResult.dropped) {
    const legacy = typeof parsed.data.mode === "string" && LEGACY_MODES.has(parsed.data.mode);
    diagnostics.push({
      level: "info",
      source: "copilot.prompts",
      file: abs,
      field: "agent",
      reason: legacy ? "legacy-mode-has-no-opencode-agent" : "agent-not-resolvable",
    });
  }

  const modelResult = translateModel(parsed.data.model, ctx, abs);
  if (modelResult.model !== undefined) {
    command.model = modelResult.model;
  } else if (modelResult.unmapped) {
    diagnostics.push({
      level: "info",
      source: "copilot.prompts",
      file: abs,
      field: "model",
      reason: "model-unmapped",
    });
  }

  if ("tools" in parsed.data) {
    diagnostics.push({ level: "info", source: "copilot.prompts", file: abs, field: "tools", reason: "dropped-no-per-command-tools" });
  }

  return { entry: { key, command }, diagnostics };
}

export function copilotPrompts(ctx: Ctx): Fragment {
  const fragment = emptyFragment();
  const command: Record<string, unknown> = {};
  const claimed = new Set<string>();

  for (const root of ctx.projectRoots) {
    const dir = join(root, ".github", "prompts");
    for (const abs of listFiles(dir, [".prompt.md"])) {
      const { entry, diagnostics } = translateFile(abs, ctx);
      for (const d of diagnostics) fragment.diagnostics.push(d);
      if (!entry) continue;
      if (claimed.has(entry.key)) {
        fragment.diagnostics.push({
          level: "warn",
          source: "copilot.prompts",
          file: abs,
          field: `command.${entry.key}`,
          reason: "duplicate",
        });
        continue;
      }
      claimed.add(entry.key);
      command[entry.key] = entry.command;
    }
  }

  if (Object.keys(command).length > 0) fragment.command = command;
  return fragment;
}
