/**
 * B5 (partial, S1 proof-of-life row only): `.github/copilot-instructions.md`
 * -> `cfg.instructions`.
 *
 * The rest of B5 -- `.github/instructions/**\/*.instructions.md`, `applyTo`
 * path-scoping (C1), the `~/.copilot/instructions/**` user tree -- is S4's;
 * this file is exactly where S4 extends, per the plan's stub-per-source
 * registry (`sources/index.ts` never needs another edit).
 */
import { join } from "node:path";
import type { Ctx } from "../../context.js";
import { isFile, toPosix } from "../../fs.js";
import { emptyFragment, type Fragment } from "../types.js";

const ROOT_INSTRUCTIONS = ".github/copilot-instructions.md";

export function copilotInstructions(ctx: Ctx): Fragment {
  const fragment = emptyFragment();
  const instructions: string[] = [];
  const seen = new Set<string>();

  for (const root of ctx.projectRoots) {
    const abs = toPosix(join(root, ROOT_INSTRUCTIONS));
    if (!isFile(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    instructions.push(abs);
  }

  if (instructions.length > 0) fragment.instructions = instructions;
  return fragment;
}
