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
