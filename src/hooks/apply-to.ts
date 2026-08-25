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
 * Path resolution matches `tool/read.ts` too: an absolute `filePath` is used
 * as-is; a relative one is resolved against the instance **directory**
 * (`path.resolve(instance.directory, filepath)` there), not the worktree --
 * the two differ when a session is launched from a subdirectory. The result
 * is made worktree-relative (posix) for glob matching.
 *
 * Only file reads inject: the read tool also lists directories, and Copilot
 * `applyTo` targets files -- a matching directory path is skipped.
 *
 * Append-once semantics: keyed by `(sessionID, read-file-path)` in a Set,
 * bounded at `maxTracked` keys with oldest-evicted-first FIFO replacement so
 * memory stays O(cap) for the plugin's lifetime, and cleared entirely by
 * `dispose()` (opencode's `Hooks.dispose`, called when the plugin instance
 * is torn down).
 *
 * Windows: the hook receives whatever path string the caller passed --
 * backslashes on win32. Paths are normalized to posix before glob matching
 * (see `glob.ts`; matching itself normalizes unconditionally).
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { Hooks } from "@opencode-ai/plugin";
import { isFile } from "../fs.js";
import { matchAny } from "../glob.js";
import type { PathScopedInstruction } from "../sources/types.js";

export interface ApplyToState {
  /** posix worktree root the reads are made relative to for matching. */
  worktree: string;
  /** opencode instance directory (where the session was started); relative reads resolve against it, like tool/read.ts. */
  directory: string;
  /** Path-scoped instructions collected by the config pass; matched per read. */
  instructions: readonly PathScopedInstruction[];
}

export interface ApplyToHookOptions {
  /**
   * Cap on tracked `(sessionID, file)` keys. Oldest evicted first, so memory
   * is O(cap) even if a long-lived process reads unbounded distinct files.
   */
  maxTracked?: number;
  /**
   * Whether the resolved absolute path is a regular file (directory reads
   * never inject). Defaults to the real filesystem; injectable for tests.
   */
  isTargetFile?: (abs: string) => boolean;
}

const DEFAULT_MAX_TRACKED_READS = 4096;

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
  private readonly maxTracked: number;
  private readonly targetIsFile: (abs: string) => boolean;

  constructor(
    private readonly stateSource: ApplyToStateSource,
    options: ApplyToHookOptions = {},
  ) {
    this.maxTracked =
      typeof options.maxTracked === "number" && options.maxTracked > 0
        ? options.maxTracked
        : DEFAULT_MAX_TRACKED_READS;
    this.targetIsFile = options.isTargetFile ?? ((abs) => isFile(abs));
  }

  handle: NonNullable<Hooks["tool.execute.after"]> = async (input, output) => {
    if (input.tool !== "read") return;
    const state = this.stateSource();
    if (!state || state.instructions.length === 0) return;

    const filePath = typeof input.args?.filePath === "string" ? input.args.filePath : undefined;
    if (filePath === undefined || filePath.length === 0) return;

    // tool/read.ts resolves exactly like this before doing anything else.
    const abs = isAbsolute(filePath) ? filePath : resolve(state.directory, filePath);
    if (!this.targetIsFile(abs)) return; // directory listings are not instruction targets

    const rel = toPosixRelative(state.worktree, abs);
    if (rel === undefined) return; // outside the worktree -> not covered by applyTo globs

    const key = `${input.sessionID}\u0000${rel}`;
    if (this.appended.has(key)) return;

    const matches = state.instructions.filter((instruction) => matchAny(rel, instruction.patterns));
    if (matches.length === 0) return;

    output.output += `\n\n${matches.map(banner).join("\n\n")}`;
    if (this.appended.size >= this.maxTracked) {
      // FIFO eviction: Sets iterate in insertion order.
      const oldest = this.appended.values().next();
      if (oldest.done !== true) this.appended.delete(oldest.value);
    }
    this.appended.add(key);
  };

  /** Clears the once-per-(session,file) memory; wired to opencode's `Hooks.dispose`. */
  dispose(): void {
    this.appended.clear();
  }
}

/**
 * Worktree-relative posix path of an absolute `filePath`, or `undefined`
 * when it is not under `worktree`.
 */
function toPosixRelative(worktree: string, abs: string): string | undefined {
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
