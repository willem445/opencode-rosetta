/**
 * Plugin options contract: `PluginOptions` (raw, as declared in the user's
 * `opencode.json`) -> `Options` (normalized). Full shape + examples: README
 * "Options". A plain `"opencode-rosetta"` string (no tuple) means "all
 * defaults" -- opencode passes `options: undefined` in that case (F11).
 * Kill switch: `OPENCODE_ROSETTA=off` disables the plugin regardless of
 * options (`index.ts` short-circuits on `Options.enabled === false`).
 */
import type { LogThreshold } from "./diagnostics.js";

export type ApplyToMode = "inject" | "always" | "ignore";

export interface ClaudeToggle {
  agents: boolean;
  commands: boolean;
  mcp: boolean;
  user: boolean;
}

export interface CopilotToggle {
  instructions: boolean;
  prompts: boolean;
  agents: boolean;
  skills: boolean;
  mcp: boolean;
  user: boolean;
  applyTo: ApplyToMode;
}

export interface Options {
  enabled: boolean;
  claude: ClaudeToggle;
  copilot: CopilotToggle;
  models: Record<string, string>;
  inputs: Record<string, string>;
  log: LogThreshold;
}

const DEFAULT_CLAUDE: ClaudeToggle = { agents: true, commands: true, mcp: true, user: true };
const DEFAULT_COPILOT: CopilotToggle = {
  instructions: true,
  prompts: true,
  agents: true,
  skills: true,
  mcp: true,
  user: true,
  applyTo: "inject",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeClaude(raw: unknown): ClaudeToggle {
  if (raw === false) return { agents: false, commands: false, mcp: false, user: false };
  if (raw === true || raw === undefined) return { ...DEFAULT_CLAUDE };
  if (!isRecord(raw)) return { ...DEFAULT_CLAUDE };
  return {
    agents: typeof raw.agents === "boolean" ? raw.agents : DEFAULT_CLAUDE.agents,
    commands: typeof raw.commands === "boolean" ? raw.commands : DEFAULT_CLAUDE.commands,
    mcp: typeof raw.mcp === "boolean" ? raw.mcp : DEFAULT_CLAUDE.mcp,
    user: typeof raw.user === "boolean" ? raw.user : DEFAULT_CLAUDE.user,
  };
}

function normalizeApplyTo(raw: unknown): ApplyToMode {
  return raw === "always" || raw === "ignore" || raw === "inject" ? raw : DEFAULT_COPILOT.applyTo;
}

function normalizeCopilot(raw: unknown): CopilotToggle {
  if (raw === false) {
    return {
      instructions: false,
      prompts: false,
      agents: false,
      skills: false,
      mcp: false,
      user: false,
      applyTo: DEFAULT_COPILOT.applyTo,
    };
  }
  if (raw === true || raw === undefined) return { ...DEFAULT_COPILOT };
  if (!isRecord(raw)) return { ...DEFAULT_COPILOT };
  return {
    instructions: typeof raw.instructions === "boolean" ? raw.instructions : DEFAULT_COPILOT.instructions,
    prompts: typeof raw.prompts === "boolean" ? raw.prompts : DEFAULT_COPILOT.prompts,
    agents: typeof raw.agents === "boolean" ? raw.agents : DEFAULT_COPILOT.agents,
    skills: typeof raw.skills === "boolean" ? raw.skills : DEFAULT_COPILOT.skills,
    mcp: typeof raw.mcp === "boolean" ? raw.mcp : DEFAULT_COPILOT.mcp,
    user: typeof raw.user === "boolean" ? raw.user : DEFAULT_COPILOT.user,
    applyTo: normalizeApplyTo(raw.applyTo),
  };
}

function normalizeStringMap(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function normalizeLog(raw: unknown): LogThreshold {
  return raw === "off" || raw === "warn" || raw === "info" || raw === "debug" ? raw : "warn";
}

/** `env` is the plugin's own env view (typically `process.env`), never logged. */
export function parseOptions(raw: unknown, env: Record<string, string | undefined>): Options {
  const source = isRecord(raw) ? raw : {};
  return {
    enabled: env.OPENCODE_ROSETTA !== "off",
    claude: normalizeClaude(source.claude),
    copilot: normalizeCopilot(source.copilot),
    models: normalizeStringMap(source.models),
    inputs: normalizeStringMap(source.inputs),
    log: normalizeLog(source.log),
  };
}
