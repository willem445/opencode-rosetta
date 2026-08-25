/**
 * B5: Copilot instructions.
 *
 * - `.github/copilot-instructions.md` (S1's proof-of-life row): unconditional
 *   -> `cfg.instructions`.
 * - `.github/instructions/` tree (`*.instructions.md`): an `applyTo` of
 *   everything (`**`, `*`, or `**`-star-slash-star) is unconditional too; a
 *   narrower glob makes the file path-scoped
 *   -> `Fragment.pathScoped`, consumed by the C1 read hook
 *   (`src/hooks/apply-to.ts`), never written into `cfg.instructions`;
 *   no `applyTo` at all is dropped + `info` (Copilot only applies those when
 *   manually attached).
 * - `~/.copilot/instructions/**`: same rules, gated by `copilot.user`.
 *
 * The `copilot.applyTo` option selects what "path-scoped" means here:
 * `inject` (default, hook), `always` (treat as unconditional), `ignore`
 * (drop + info). This module stays a pure function of `Ctx`; it does not
 * know about sessions or reads -- that is entirely the hook's job.
 */
import { join } from "node:path";
import type { Ctx } from "../../context.js";
import { isFile, listFiles, readText, toPosix } from "../../fs.js";
import { parseFrontmatter, isFrontmatterError } from "../../frontmatter.js";
import { isUnconditional, splitApplyTo } from "../../glob.js";
import type { PathScopedInstruction } from "../types.js";
import { emptyFragment, type Fragment } from "../types.js";

const ROOT_INSTRUCTIONS = ".github/copilot-instructions.md";
const INSTRUCTIONS_DIR = ".github/instructions";
const USER_INSTRUCTIONS_DIR = ".copilot/instructions";

function classify(abs: string, ctx: Ctx, mode: Ctx["options"]["copilot"]["applyTo"]): {
  unconditional?: string;
  scoped?: PathScopedInstruction;
  diagnostics: Fragment["diagnostics"];
} {
  const diagnostics: Fragment["diagnostics"] = [];
  const text = readText(abs);
  if (text === undefined) return { diagnostics };

  const parsed = parseFrontmatter(text);
  if (isFrontmatterError(parsed)) {
    diagnostics.push({ level: "warn", source: "copilot.instructions", file: abs, reason: "unparseable" });
    return { diagnostics };
  }

  const rawApplyTo = typeof parsed.data.applyTo === "string" ? parsed.data.applyTo : undefined;
  if (rawApplyTo === undefined) {
    diagnostics.push({ level: "info", source: "copilot.instructions", file: abs, reason: "no-apply-to" });
    return { diagnostics };
  }

  const patterns = splitApplyTo(rawApplyTo);
  if (patterns.length === 0) {
    diagnostics.push({ level: "warn", source: "copilot.instructions", file: abs, field: "applyTo", reason: "empty-apply-to" });
    return { diagnostics };
  }

  if (mode === "always" || isUnconditional(patterns)) {
    return { unconditional: abs, diagnostics };
  }
  if (mode === "ignore") {
    diagnostics.push({ level: "info", source: "copilot.instructions", file: abs, field: "applyTo", reason: "applyTo-ignored" });
    return { diagnostics };
  }
  return {
    scoped: {
      file: abs,
      applyTo: rawApplyTo,
      patterns,
      // Body only -- the frontmatter is config, not prose for the model.
      content: parsed.content,
    },
    diagnostics,
  };
}

export function copilotInstructions(ctx: Ctx): Fragment {
  const fragment = emptyFragment();
  const instructions: string[] = [];
  const pathScoped: PathScopedInstruction[] = [];
  const seen = new Set<string>();
  const mode = ctx.options.copilot.applyTo;

  const collectRootFile = (abs: string): void => {
    const posix = toPosix(abs);
    if (!isFile(posix) || seen.has(posix)) return;
    seen.add(posix);
    instructions.push(posix);
  };

  const collectScopedFile = (abs: string): void => {
    const posix = toPosix(abs);
    if (seen.has(posix)) return;
    seen.add(posix);
    const result = classify(posix, ctx, mode);
    for (const d of result.diagnostics) fragment.diagnostics.push(d);
    if (result.unconditional !== undefined) instructions.push(result.unconditional);
    else if (result.scoped !== undefined) pathScoped.push(result.scoped);
  };

  for (const root of ctx.projectRoots) {
    collectRootFile(join(root, ROOT_INSTRUCTIONS));
    for (const abs of listFiles(join(root, INSTRUCTIONS_DIR), [".instructions.md"])) {
      collectScopedFile(abs);
    }
  }

  if (ctx.options.copilot.user) {
    for (const abs of listFiles(join(ctx.home, USER_INSTRUCTIONS_DIR), [".instructions.md"])) {
      collectScopedFile(abs);
    }
  }

  if (instructions.length > 0) fragment.instructions = instructions;
  if (pathScoped.length > 0) fragment.pathScoped = pathScoped;
  return fragment;
}
