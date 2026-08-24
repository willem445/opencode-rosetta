/**
 * `Ctx` is the one thing every `sources/*` translator depends on: a source
 * is `(ctx: Ctx) => Fragment`, reading only the filesystem under `ctx`'s
 * paths and `ctx.env` -- never `process.cwd()`/`process.env` or the SDK
 * client directly -- which is what makes fixture-dir unit tests trivial.
 */
import { toPosix } from "./fs.js";
import { Diagnostics } from "./diagnostics.js";
import type { Options } from "./options.js";

export interface Ctx {
  /** opencode's `directory` (cwd the session was started in; may be nested in `worktree`). */
  directory: string;
  /** opencode's `worktree` (repo/worktree root). */
  worktree: string;
  /**
   * Project-scope roots to search, nearest-to-`directory` first (Claude
   * semantics, plan precedence rule 2). `[directory]` when `directory ===
   * worktree`, else `[directory, worktree]`. Always posix.
   */
  projectRoots: string[];
  /** User home directory (`os.homedir()`), posix. */
  home: string;
  /** The plugin's own env view -- never `process.env` read directly by a source. */
  env: Record<string, string | undefined>;
  options: Options;
  diag: Diagnostics;
}

export interface BuildContextInput {
  directory: string;
  worktree: string;
  home: string;
  env: Record<string, string | undefined>;
  options: Options;
}

export function buildContext(input: BuildContextInput): Ctx {
  const directory = toPosix(input.directory);
  const worktree = toPosix(input.worktree);
  const projectRoots = directory === worktree ? [directory] : [directory, worktree];
  return {
    directory,
    worktree,
    projectRoots,
    home: toPosix(input.home),
    env: input.env,
    options: input.options,
    diag: new Diagnostics(),
  };
}
