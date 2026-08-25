/**
 * C1: the read hook for Copilot path-scoped instructions (`applyTo` globs
 * narrower than `**`). opencode has no config-time concept of "instructions
 * scoped to files matching X", but it already does the closest thing for
 * nested AGENTS.md files: `tool/read.ts` appends resolved instruction
 * content to the read tool's output inside a `<system-reminder>` block.
 * This hook mirrors that shape exactly, via the plugin
 * `tool.execute.after` hook (F16) filtered to `tool === "read"`.
 *
 * The read tool's argument name is `filePath` -- verified against
 * `tool/read.ts` at tag v1.18.21 (the installed binary): `Parameters =
 * Schema.Struct({ filePath: ... })`.
 *
 * Append-once semantics: keyed by `(sessionID, read-file-path)` in a Map
 * cleared by `dispose()` (opencode's `Hooks.dispose`, called when the
 * plugin instance is torn down), so re-reading a file in one session never
 * duplicates an injection while two sessions stay independent.
 *
 * Windows: the hook receives whatever path string the caller passed --
 * backslashes on win32. The worktree-relative path is computed natively and
 * normalized to posix before glob matching (see `glob.ts`; matching itself
 * normalizes unconditionally).
 */
import { isAbsolute, relative } from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import { matchAny } from "../glob.js";
import type { PathScopedInstruction } from "../sources/types.js";

export interface ApplyToState {
  /** posix worktree root the reads are relative to. */
  worktree: string;
  /** Path-scoped instructions collected by the config pass; matched per read. */
  instructions: readonly PathScopedInstruction[];
}

function banner(instruction: PathScopedInstruction): string {
  return `<system-reminder>\nInstructions from: ${instruction.file} (applyTo: ${instruction.applyTo})\n${instruction.content.trimEnd()}\n</system-reminder>`;
}

/**
 * The hook reads its state through this indirection because the state does
 * not exist until the `config` hook runs (opencode calls `server()` once,
 * long before/after either hook fires); `index.ts` points this at a holder
 * it fills in during the config pass.
 */
export type ApplyToStateSource = () => ApplyToState | undefined;

export class ApplyToHook {
  private readonly appended = new Set<string>();

  constructor(private readonly stateSource: ApplyToStateSource) {}

  handle: NonNullable<Hooks["tool.execute.after"]> = async (input, output) => {
    if (input.tool !== "read") return;
    const state = this.stateSource();
    if (!state || state.instructions.length === 0) return;

    const filePath = typeof input.args?.filePath === "string" ? input.args.filePath : undefined;
    if (filePath === undefined || filePath.length === 0) return;

    const rel = toPosixRelative(state.worktree, filePath);
    if (rel === undefined) return; // outside the worktree -> not covered by applyTo globs

    const key = `${input.sessionID}\u0000${rel}`;
    if (this.appended.has(key)) return;

    const matches = state.instructions.filter((instruction) => matchAny(rel, instruction.patterns));
    if (matches.length === 0) return;

    output.output += `\n\n${matches.map(banner).join("\n\n")}`;
    this.appended.add(key);
  };

  /** Clears the once-per-(session,file) memory; wired to opencode's `Hooks.dispose`. */
  dispose(): void {
    this.appended.clear();
  }
}

/**
 * Worktree-relative posix path, or `undefined` when `filePath` is not under
 * `worktree` (an absolute path elsewhere, or already-relative garbage that
 * escapes the root).
 */
function toPosixRelative(worktree: string, filePath: string): string | undefined {
  const abs = isAbsolute(filePath)
    ? filePath
    : // tool/read.ts resolves relative reads against the instance directory;
      // treat them as relative to the worktree here, the only root we know.
      `${worktree}/${filePath}`;
  let rel: string;
  try {
    rel = relative(worktree, abs);
  } catch {
    return undefined;
  }
  if (rel.length === 0) return undefined;
  const posix = rel.replace(/\\/g, "/");
  return posix.startsWith("../") ? undefined : posix;
}
