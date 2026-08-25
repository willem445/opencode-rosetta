/**
 * B8: `.github/skills`, `~/.copilot/skills` -> `cfg.skills.paths`.
 *
 * opencode's skill scanner (`discoverSkills`, F9) loads every SKILL.md at
 * any depth under each path in `cfg.skills.paths`, into a Set of absolute
 * paths, so injecting *directories* reuses the whole native mechanism --
 * registration of `/name` commands, read whitelisting, dedup -- with no
 * symlink (C6) and no second parser. `.github/skills` and
 * `~/.copilot/skills` are not native scan roots, which is exactly why this
 * source exists.
 */
import { join } from "node:path";
import type { Ctx } from "../../context.js";
import { isDir, toPosix } from "../../fs.js";
import { emptyFragment, type Fragment } from "../types.js";

const PROJECT_SKILLS = ".github/skills";
const USER_SKILLS = ".copilot/skills";

export function copilotSkills(ctx: Ctx): Fragment {
  const fragment = emptyFragment();
  const paths: string[] = [];
  const seen = new Set<string>();

  const collect = (dir: string): void => {
    const posix = toPosix(dir);
    if (!isDir(posix) || seen.has(posix)) return;
    seen.add(posix);
    paths.push(posix);
  };

  for (const root of ctx.projectRoots) {
    collect(join(root, PROJECT_SKILLS));
  }
  if (ctx.options.copilot.user) {
    collect(join(ctx.home, USER_SKILLS));
  }

  if (paths.length > 0) fragment.skillPaths = paths;
  return fragment;
}
