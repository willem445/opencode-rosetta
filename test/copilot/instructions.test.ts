import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { copilotInstructions } from "../../src/sources/copilot/instructions.js";
import { toPosix } from "../../src/fs.js";
import { makeCtx } from "../helpers.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "copilot", "instructions");

describe("copilotInstructions (B5 proof-of-life row: .github/copilot-instructions.md)", () => {
  test("root file present -> its absolute path lands in fragment.instructions", () => {
    const worktree = join(FIXTURES, "has-root-file");
    const ctx = makeCtx({ worktree });
    const fragment = copilotInstructions(ctx);
    expect(fragment.instructions).toEqual([toPosix(join(worktree, ".github/copilot-instructions.md"))]);
    expect(fragment.diagnostics).toEqual([]);
  });

  test("no root file -> fragment.instructions is omitted, not an empty array", () => {
    const worktree = join(FIXTURES, "no-root-file");
    const ctx = makeCtx({ worktree });
    const fragment = copilotInstructions(ctx);
    expect(fragment.instructions).toBeUndefined();
  });

  test("directory nested in worktree, both with their own file -> both included, nearest-to-directory first", () => {
    const worktree = join(FIXTURES, "nested-worktree");
    const directory = join(worktree, "directory");
    const ctx = makeCtx({ worktree, directory });
    const fragment = copilotInstructions(ctx);
    expect(fragment.instructions).toEqual([
      toPosix(join(directory, ".github/copilot-instructions.md")),
      toPosix(join(worktree, ".github/copilot-instructions.md")),
    ]);
  });

  test("directory === worktree -> that single root is not listed twice", () => {
    const worktree = join(FIXTURES, "has-root-file");
    const ctx = makeCtx({ worktree, directory: worktree });
    expect(ctx.projectRoots).toEqual([toPosix(worktree)]);
    const fragment = copilotInstructions(ctx);
    expect(fragment.instructions).toHaveLength(1);
  });

  test("copilot.instructions: false at the registry level means this source is never invoked (checked in sources/index.test-equivalent below via registry gating)", () => {
    // copilotInstructions itself has no internal gate -- gating is the
    // registry's job (sources/index.ts). This test documents that the
    // function is unconditional so a future refactor doesn't accidentally
    // duplicate the toggle check inside the source itself.
    const worktree = join(FIXTURES, "has-root-file");
    const ctx = makeCtx({ worktree, rawOptions: { copilot: { instructions: false } } });
    const fragment = copilotInstructions(ctx);
    expect(fragment.instructions).toHaveLength(1);
  });
});

describe("copilotInstructions (B5 rest: *.instructions.md, applyTo, user dir)", () => {
  const TREE = join(FIXTURES, "with-instructions");

  test("applyTo ** is unconditional -> cfg.instructions; narrower globs land in pathScoped; absent applyTo is dropped + info", () => {
    const ctx = makeCtx({ worktree: TREE });
    const fragment = copilotInstructions(ctx);

    expect(fragment.instructions).toEqual([
      toPosix(join(TREE, ".github/copilot-instructions.md")),
      toPosix(join(TREE, ".github/instructions/all.instructions.md")),
    ]);

    expect(fragment.pathScoped?.map((p) => p.file)).toEqual([
      toPosix(join(TREE, ".github/instructions/multi.instructions.md")),
      toPosix(join(TREE, ".github/instructions/ts.instructions.md")),
    ]);
    const tsScoped = fragment.pathScoped?.find((p) => p.file.endsWith("ts.instructions.md"));
    expect(tsScoped?.patterns).toEqual(["**/*.ts"]);
    expect(tsScoped?.applyTo).toBe("**/*.ts");
    expect(tsScoped?.content).toContain("type` imports");

    const multi = fragment.pathScoped?.find((p) => p.file.endsWith("multi.instructions.md"));
    expect(multi?.patterns).toEqual(["src/**/*.ts", "docs/**/*.md"]);

    const noApplyTo = fragment.diagnostics.find((d) => d.reason === "no-apply-to");
    expect(noApplyTo?.level).toBe("info");
    expect(noApplyTo?.file).toBe(toPosix(join(TREE, ".github/instructions/no-applyto.instructions.md")));
    expect(fragment.instructions?.some((p) => p.endsWith("no-applyto.instructions.md"))).toBe(false);
    expect(fragment.pathScoped?.some((p) => p.file.endsWith("no-applyto.instructions.md"))).toBe(false);
  });

  test("copilot.applyTo: always -> every scoped file becomes an unconditional instruction instead", () => {
    const ctx = makeCtx({ worktree: TREE, rawOptions: { copilot: { applyTo: "always" } } });
    const fragment = copilotInstructions(ctx);
    expect(fragment.pathScoped).toBeUndefined();
    expect(fragment.instructions?.some((p) => p.endsWith("ts.instructions.md"))).toBe(true);
    expect(fragment.instructions?.some((p) => p.endsWith("multi.instructions.md"))).toBe(true);
  });

  test("copilot.applyTo: ignore -> scoped files dropped with an info diagnostic", () => {
    const ctx = makeCtx({ worktree: TREE, rawOptions: { copilot: { applyTo: "ignore" } } });
    const fragment = copilotInstructions(ctx);
    expect(fragment.pathScoped).toBeUndefined();
    expect(fragment.instructions?.some((p) => p.endsWith("ts.instructions.md"))).toBe(false);
    expect(
      fragment.diagnostics.some(
        (d) => d.level === "info" && d.reason === "applyTo-ignored" && d.file?.endsWith("ts.instructions.md"),
      ),
    ).toBe(true);
  });

  test("unparseable frontmatter -> warn diagnostic, file excluded everywhere", () => {
    const broken = join(FIXTURES, "broken");
    const ctx = makeCtx({ worktree: broken });
    const fragment = copilotInstructions(ctx);
    expect(fragment.instructions).toBeUndefined();
    expect(fragment.pathScoped).toBeUndefined();
    const diag = fragment.diagnostics.find((d) => d.level === "warn" && d.reason === "unparseable");
    expect(diag?.file).toBe(toPosix(join(broken, ".github/instructions/bad.instructions.md")));
  });

  test("~/.copilot/instructions/** follows the same rules, gated by copilot.user", () => {
    const tree = join(FIXTURES, "with-user-home");
    const home = join(tree, "home");
    const on = makeCtx({ worktree: tree, home });
    const scopedOn = copilotInstructions(on).pathScoped;
    expect(scopedOn?.map((p) => p.file)).toEqual([toPosix(join(home, ".copilot/instructions/user-md.instructions.md"))]);

    const off = makeCtx({ worktree: tree, home, rawOptions: { copilot: { user: false } } });
    expect(copilotInstructions(off).pathScoped).toBeUndefined();
    expect(copilotInstructions(off).instructions).toBeUndefined();
  });
});
