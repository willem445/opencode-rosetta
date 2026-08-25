/**
 * Shared discovery helper for the two Claude markdown-artifact sources
 * (B1 `.claude/agents/**\/*.md`, B2 `.claude/commands/**\/*.md`): the
 * project-scope directories nearest-to-`directory` first (`ctx.projectRoots`,
 * Claude semantics / precedence rule 2), then -- gated by the `claude.user`
 * toggle -- the user-scope `~/.claude/<subdir>` tree. Owned by S2 alongside
 * its two consumers; S3's `mcp.ts` reads JSON config files, not md trees,
 * and must not be tempted into this shape (see B3).
 */
import { join } from "node:path";
import type { Ctx } from "../../context.js";
import { listFiles } from "../../fs.js";

/**
 * Every `.md` file under `<root>/.claude/<subdir>` for each scope root, in
 * precedence order (nearest root first, then file order within a root, then
 * user scope). Empty for scopes whose directory does not exist.
 */
export function claudeMarkdownFiles(ctx: Ctx, subdir: "agents" | "commands"): string[] {
  const dirs: string[] = ctx.projectRoots.map((root) => join(root, ".claude", subdir));
  if (ctx.options.claude.user) dirs.push(join(ctx.home, ".claude", subdir));
  const out: string[] = [];
  for (const dir of dirs) out.push(...listFiles(dir, [".md"]));
  return out;
}

/** `foo/bar/baz.md` -> `baz` (B2: subdirs are NOT part of a command's name). */
export function commandKeyFromFile(posixPath: string): string {
  const base = posixPath.split("/").pop() ?? posixPath;
  return base.replace(/\.md$/i, "");
}
