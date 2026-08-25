/**
 * B1/B2 "model" row: a Claude `model:` frontmatter value -> an opencode
 * `provider/model` id, or nothing.
 *
 * Rules (mapping tables B1/B2, plan part 4):
 * - absent / not a string / `inherit` -> omit (the agent/command inherits the
 *   session model; emitting a guess would fail at prompt time, C2);
 * - alias `sonnet|opus|haiku|fable` -> `options.models[alias]`; if the user
 *   did not map that alias, omit + an `info` diagnostic (`unmapped-model-alias`)
 *   rather than guessing (C2: an unresolvable `provider/model` fails at prompt
 *   time -- worse than inheriting);
 * - a full `claude-*` id -> `anthropic/<id>` (documented default, overridable
 *   via the same `models` map taking precedence);
 * - anything else -> omit + `info` (`unmapped-model`).
 */
import type { Diagnostic } from "./diagnostics.js";

export const MODEL_ALIASES = ["sonnet", "opus", "haiku", "fable"] as const;

export interface MappedModel {
  /** The opencode `provider/model` id to emit; absent when unmapped. */
  model?: string;
  /** Why nothing was emitted (never set when `model` is). */
  diagnostic?: Diagnostic;
}

export function mapModel(raw: unknown, models: Record<string, string>, source: string): MappedModel {
  if (typeof raw !== "string") return {};
  const value = raw.trim();
  if (value === "" || value === "inherit") return {};

  // An explicit user mapping always wins, whatever the raw shape is.
  const mapped = models[value];
  if (mapped !== undefined && mapped !== "") return { model: mapped };

  if ((MODEL_ALIASES as readonly string[]).includes(value)) {
    return {
      diagnostic: {
        level: "info",
        source,
        field: "model",
        reason: `unmapped-model-alias: "${value}" (add it to the plugin's "models" option to map it)`,
      },
    };
  }

  if (value.startsWith("claude-")) return { model: `anthropic/${value}` };

  return {
    diagnostic: {
      level: "info",
      source,
      field: "model",
      reason: `unmapped-model: "${value}"`,
    },
  };
}
