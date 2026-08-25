import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { copilotSkills } from "../../src/sources/copilot/skills.js";
import { toPosix } from "../../src/fs.js";
import { makeCtx } from "../helpers.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "copilot", "skills");

describe("copilotSkills (B8: .github/skills, ~/.copilot/skills -> cfg.skills.paths)", () => {
  test("an existing .github/skills directory is pushed as an absolute posix path", () => {
    const worktree = join(FIXTURES, "basic");
    const ctx = makeCtx({ worktree });
    expect(copilotSkills(ctx).skillPaths).toEqual([toPosix(join(worktree, ".github", "skills"))]);
    expect(copilotSkills(ctx).diagnostics).toEqual([]);
  });

  test("no .github/skills -> skillPaths omitted, not an empty array", () => {
    const ctx = makeCtx({ worktree: FIXTURES });
    expect(copilotSkills(ctx).skillPaths).toBeUndefined();
  });

  test("~/.copilot/skills is appended after project roots when the user toggle is on (default)", () => {
    const worktree = join(FIXTURES, "with-home");
    const home = join(worktree, "home");
    const ctx = makeCtx({ worktree: join(worktree, "empty"), home });
    expect(copilotSkills(ctx).skillPaths).toEqual([toPosix(join(home, ".copilot", "skills"))]);
  });

  test("copilot.user: false drops the user-scope directory", () => {
    const worktree = join(FIXTURES, "with-home");
    const home = join(worktree, "home");
    const ctx = makeCtx({
      worktree: join(worktree, "empty"),
      home,
      rawOptions: { copilot: { user: false } },
    });
    expect(copilotSkills(ctx).skillPaths).toBeUndefined();
  });

  test("project and user dirs together: project first (registry precedence rule 2)", () => {
    const worktree = join(FIXTURES, "with-home");
    const home = join(worktree, "home");
    const ctx = makeCtx({ worktree, home });
    expect(copilotSkills(ctx).skillPaths).toEqual([
      toPosix(join(worktree, ".github", "skills")),
      toPosix(join(home, ".copilot", "skills")),
    ]);
  });
});
