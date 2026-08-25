import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { copilotPrompts } from "../../src/sources/copilot/prompts.js";
import { toPosix } from "../../src/fs.js";
import { makeCtx } from "../helpers.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "copilot", "prompts");
const MODELS = { "gpt-5": "openai/gpt-5", "Claude Opus 4": "anthropic/claude-opus-4" };

function commandOf(ctx: ReturnType<typeof makeCtx>): Record<string, any> {
  return copilotPrompts(ctx).command ?? {};
}

describe("copilotPrompts (B6: .github/prompts/**/*.prompt.md -> cfg.command[name])", () => {
  test("single ${input:x} -> $ARGUMENTS; agent plan kept; description mapped; key from basename", () => {
    const worktree = join(FIXTURES, "basic");
    const ctx = makeCtx({ worktree, rawOptions: { models: MODELS } });
    const plan = commandOf(ctx)["plan"];
    expect(plan).toBeDefined();
    expect(plan.template).toBe("Draft a plan for: $ARGUMENTS");
    expect(plan.agent).toBe("plan");
    expect(plan.description).toBe("Draft a plan");
  });

  test("several distinct ${input:x} -> $1..$N by first appearance; repeated id reuses its number", () => {
    const worktree = join(FIXTURES, "basic");
    const ctx = makeCtx({ worktree, rawOptions: { models: MODELS } });
    // full.prompt.md body: ${input:what} ... ${input:why}
    expect(commandOf(ctx)["full"].template).toContain("$1");
    expect(commandOf(ctx)["full"].template).toContain("$2");
    expect(commandOf(ctx)["full"].template).not.toContain("$ARGUMENTS");
  });

  test("${workspaceFolder} -> worktree; #file:path -> @path; description gains ' — args:' hint (as B2)", () => {
    const worktree = join(FIXTURES, "basic");
    const ctx = makeCtx({ worktree, rawOptions: { models: MODELS } });
    const full = commandOf(ctx)["full"];
    expect(full.template).toContain(toPosix(worktree));
    expect(full.template).toContain("@src/index.ts");
    expect(full.template).toContain("(selection: ${selection})"); // unmappable var left literal...
    expect(full.description).toBe("Exercises every mapped field — args: what why");
  });

  test("model array: first entry mappable via options.models wins; key comes from frontmatter name", () => {
    const worktree = join(FIXTURES, "basic");
    const ctx = makeCtx({ worktree, rawOptions: { models: MODELS } });
    expect(commandOf(ctx)["full"].model).toBe("anthropic/claude-opus-4");
  });

  test("unmapped model string is omitted + info diagnostic, never guessed", () => {
    const worktree = join(FIXTURES, "basic");
    const ctx = makeCtx({ worktree, rawOptions: { models: MODELS } });
    expect(commandOf(ctx)["unmapped-model"]).toBeDefined();
    expect(commandOf(ctx)["unmapped-model"].model).toBeUndefined();
    const diag = copilotPrompts(ctx).diagnostics;
    expect(
      diag.some((d) => d.level === "info" && d.file?.endsWith("unmapped-model.prompt.md") && d.field === "model"),
    ).toBe(true);
  });

  test("legacy mode: ask/edit/agent are dropped (agent omitted + info)", () => {
    const worktree = join(FIXTURES, "basic");
    const ctx = makeCtx({ worktree, rawOptions: { models: MODELS } });
    const legacy = commandOf(ctx)["legacy-mode"];
    expect(legacy).toBeDefined();
    expect(legacy.agent).toBeUndefined();
    const diag = copilotPrompts(ctx).diagnostics;
    expect(diag.some((d) => d.field === "agent" && d.file?.endsWith("legacy-mode.prompt.md"))).toBe(true);
  });

  test("tools frontmatter is dropped with an info diagnostic (comma-string and array alike)", () => {
    const worktree = join(FIXTURES, "basic");
    const ctx = makeCtx({ worktree, rawOptions: { models: MODELS } });
    const full = commandOf(ctx)["full"];
    expect(full.tools).toBeUndefined();
    expect(Object.keys(full)).toEqual(expect.arrayContaining(["template", "description", "agent", "model"]));
    const diag = copilotPrompts(ctx).diagnostics;
    expect(diag.some((d) => d.level === "info" && d.field === "tools" && d.file?.endsWith("full.prompt.md"))).toBe(
      true,
    );
  });

  test("same basename in two roots: nearest-to-directory root wins, farther one is a duplicate warn", () => {
    const worktree = join(FIXTURES, "collision");
    const directory = join(worktree, "directory");
    const ctx = makeCtx({ worktree, directory, rawOptions: { models: MODELS } });
    const dup = commandOf(ctx)["dup"];
    expect(dup.description).toBe("From the directory root (nearest wins)");
    const diag = copilotPrompts(ctx).diagnostics;
    expect(diag.some((d) => d.level === "warn" && d.reason === "duplicate" && d.file?.includes(".github"))).toBe(true);
  });

  test("no prompts directory -> fragment.command omitted entirely", () => {
    const ctx = makeCtx({ worktree: FIXTURES });
    expect(copilotPrompts(ctx).command).toBeUndefined();
  });
});
