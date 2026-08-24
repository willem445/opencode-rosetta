import { buildContext, type Ctx } from "../src/context.js";
import { parseOptions } from "../src/options.js";

/**
 * Build a throwaway `Ctx` rooted at fixture directories, for
 * `sources/*` unit tests. `directory` defaults to `worktree` (single
 * project root) unless a nested `directory` is passed explicitly.
 */
export function makeCtx(input: {
  worktree: string;
  directory?: string;
  home?: string;
  env?: Record<string, string | undefined>;
  rawOptions?: unknown;
}): Ctx {
  const env = input.env ?? {};
  return buildContext({
    worktree: input.worktree,
    directory: input.directory ?? input.worktree,
    home: input.home ?? "/home/nobody",
    env,
    options: parseOptions(input.rawOptions, env),
  });
}
