/**
 * Shared shape every `sources/*` translator returns -- a pure function
 * `(ctx: Ctx) => Fragment` (see `context.ts`). `apply.ts` folds every
 * enabled source's `Fragment` into the live config object.
 */
import type { Diagnostic } from "../diagnostics.js";
import type { Ctx } from "../context.js";

/**
 * A Copilot `applyTo`-scoped instructions file, not injected into
 * `cfg.instructions` directly -- consumed by the `tool.execute.after` read
 * hook (C1, owned by S4) instead. S1 declares the shape so `sources/types.ts`
 * never needs editing again; S1 itself never produces one (the S1 proof of
 * life is the unconditional `.github/copilot-instructions.md` row only).
 */
export interface PathScopedInstruction {
  /** Absolute posix path of the instructions file. */
  file: string;
  /** Original (possibly comma-separated) `applyTo` glob string, for the "Instructions from: <file> (applyTo: <glob>)" banner. */
  applyTo: string;
  /** `applyTo` split on `,` and trimmed -- matched against `path.relative(worktree, filePath)` (posix). */
  patterns: string[];
  /** File content appended on a matching read. */
  content: string;
}

export interface Fragment {
  /** `cfg.agent` entries this source contributes, keyed by agent name. */
  agent?: Record<string, unknown>;
  /** `cfg.command` entries this source contributes, keyed by command name. */
  command?: Record<string, unknown>;
  /** `cfg.mcp` entries this source contributes, keyed by server name. */
  mcp?: Record<string, unknown>;
  /** Absolute paths to append to `cfg.instructions` (consumers dedup, F8). */
  instructions?: string[];
  /** Absolute directories to append to `cfg.skills.paths` (consumers dedup, F9). */
  skillPaths?: string[];
  /** `applyTo`-scoped instructions, consumed by the C1 read hook (S4). */
  pathScoped?: PathScopedInstruction[];
  /** Everything this source has to say about what it skipped/translated. */
  diagnostics: Diagnostic[];
}

export type SourceFn = (ctx: Ctx) => Fragment;

export function emptyFragment(): Fragment {
  return { diagnostics: [] };
}
