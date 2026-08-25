/**
 * Folds every source's `Fragment` into the *live* opencode config object, in
 * place (F3: no clone -- mutating here is what every later `config.get()`
 * sees). Precedence (design note "Precedence"): (1) a key already in `cfg`
 * is never touched (`instructions`/`skills.paths` append instead); (2)
 * among rosetta's own contributions, `sourceResults` order wins; (3) every
 * skip is a diagnostic (`exists-in-config` | `duplicate` | a `validate*`
 * failure below -- F5: injected objects bypass opencode's schema decode, so
 * refusing a `tools` key here is the only thing stopping a silently
 * over-permissive agent).
 */
import type { Diagnostics } from "./diagnostics.js";
import type { SourceResult } from "./sources/index.js";

type KeyedSection = "agent" | "command" | "mcp";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function ensureObject(cfg: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = cfg[key];
  if (isPlainObject(existing)) return existing;
  const created: Record<string, unknown> = {};
  cfg[key] = created;
  return created;
}

function validateAgent(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "invalid-shape";
  if ("tools" in value) return "emits-tools-not-permission";
  return undefined;
}

function validateCommand(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "invalid-shape";
  if (typeof value.template !== "string") return "missing-template";
  return undefined;
}

function validateMcp(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "invalid-shape";
  // Distinguish an ABSENT type from a PRESENT-but-unrecognized one (S1
  // review finding, #8 finding 1): the translators only ever emit
  // local/remote, so "invalid-type" here means a malformed fragment (a
  // rosetta bug or a future source), not a user artifact we chose to skip.
  if (!("type" in value) || value.type === undefined) return "missing-type";
  if (value.type !== "local" && value.type !== "remote") return "invalid-type";
  return undefined;
}

const VALIDATORS: Record<KeyedSection, (value: unknown) => string | undefined> = {
  agent: validateAgent,
  command: validateCommand,
  mcp: validateMcp,
};

function applyKeyedSection(
  cfg: Record<string, unknown>,
  section: KeyedSection,
  sourceResults: readonly SourceResult[],
  diag: Diagnostics,
): void {
  if (!sourceResults.some(({ fragment }) => fragment[section])) return;
  const target = ensureObject(cfg, section);
  const preexisting = new Set(Object.keys(target));
  const claimedThisRun = new Set<string>();
  const validate = VALIDATORS[section];

  for (const { key: sourceKey, fragment } of sourceResults) {
    const entries = fragment[section];
    if (!entries) continue;
    for (const [name, value] of Object.entries(entries)) {
      if (preexisting.has(name)) {
        diag.add({ level: "info", source: sourceKey, field: `${section}.${name}`, reason: "exists-in-config" });
        continue;
      }
      if (claimedThisRun.has(name)) {
        diag.add({ level: "warn", source: sourceKey, field: `${section}.${name}`, reason: "duplicate" });
        continue;
      }
      const invalid = validate(value);
      if (invalid) {
        diag.add({ level: "warn", source: sourceKey, field: `${section}.${name}`, reason: invalid });
        continue;
      }
      target[name] = value;
      claimedThisRun.add(name);
    }
  }
}

function appendDeduped(existing: unknown, additions: readonly string[]): string[] {
  const arr = Array.isArray(existing) ? [...(existing as string[])] : [];
  const seen = new Set(arr);
  for (const value of additions) {
    if (seen.has(value)) continue;
    seen.add(value);
    arr.push(value);
  }
  return arr;
}

function applyInstructions(cfg: Record<string, unknown>, sourceResults: readonly SourceResult[]): void {
  const additions = sourceResults.flatMap(({ fragment }) => fragment.instructions ?? []);
  if (additions.length === 0) return;
  cfg.instructions = appendDeduped(cfg.instructions, additions);
}

function applySkillPaths(cfg: Record<string, unknown>, sourceResults: readonly SourceResult[]): void {
  const additions = sourceResults.flatMap(({ fragment }) => fragment.skillPaths ?? []);
  if (additions.length === 0) return;
  const skills = ensureObject(cfg, "skills");
  skills.paths = appendDeduped(skills.paths, additions);
}

/** Mutates `cfg` in place. Idempotent -- a second call is a no-op. */
export function applyFragments(
  cfg: Record<string, unknown>,
  sourceResults: readonly SourceResult[],
  diag: Diagnostics,
): void {
  applyKeyedSection(cfg, "agent", sourceResults, diag);
  applyKeyedSection(cfg, "command", sourceResults, diag);
  applyKeyedSection(cfg, "mcp", sourceResults, diag);
  applyInstructions(cfg, sourceResults);
  applySkillPaths(cfg, sourceResults);
}
