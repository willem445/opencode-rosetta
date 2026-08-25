import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { claudeAgents, discoverClaudeAgents } from "../../src/sources/claude/agents.js";
import { makeCtx } from "../helpers.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "claude", "agents");

describe("discoverClaudeAgents (B1)", () => {
  test("full mapping table: tools -> permission (never `tools`), permissionMode, color, maxTurns", () => {
    const worktree = join(FIXTURES, "full");
    const ctx = makeCtx({ worktree });
    const { agents, diagnostics } = discoverClaudeAgents(ctx);

    expect(agents["reviewer"]).toEqual({
      description: "Reviews code changes for correctness and style.",
      prompt: "You are a careful reviewer.",
      mode: "subagent",
      permission: {
        "*": "deny",
        read: "allow",
        grep: "allow",
        bash: { "git diff:*": "allow" },
        task: { "*": "deny", a: "allow", b: "allow" },
        "github_*": "allow",
        db_query: "allow",
        // permissionMode: plan applied after the tools allowlist
        edit: "deny",
      },
      color: "primary",
      steps: 8,
    });
    expect(Object.keys(agents)).toEqual(["reviewer"]);
    expect(JSON.stringify(agents["reviewer"])).not.toContain('"tools"'); // F5, belt and braces
    expect(diagnostics).toEqual([]);
  });

  test("skipped files: no name is silent; name-without-description info; invalid name warn", () => {
    const ctx = makeCtx({ worktree: join(FIXTURES, "skipped") });
    const { agents, diagnostics } = discoverClaudeAgents(ctx);
    expect(agents).toEqual({});

    const noName = diagnostics.filter((d) => d.file?.endsWith("no-name.md"));
    expect(noName).toEqual([]); // docs file -- skipped silently

    const missingDesc = diagnostics.find((d) => d.file?.endsWith("missing-description.md"));
    expect(missingDesc?.level).toBe("info");
    expect(missingDesc?.reason).toMatch(/^missing-description/);

    const invalidName = diagnostics.find((d) => d.file?.endsWith("invalid-name.md"));
    expect(invalidName?.level).toBe("warn");
    expect(invalidName?.reason).toContain('"-weird"');
  });

  test("model/color/maxTurns edge cases + dropped-field diagnostics", () => {
    const ctx = makeCtx({ worktree: join(FIXTURES, "fields") });
    const { agents, diagnostics } = discoverClaudeAgents(ctx);
    const field = (name: string) => diagnostics.filter((d) => d.file?.endsWith(`${name}.md`));

    expect("model" in agents["inherit"]!).toBe(false); // inherit -> omitted, no diagnostic
    expect(field("inherit")).toEqual([]);

    expect("model" in agents["alias-unmapped"]!).toBe(false);
    expect(field("alias-unmapped")[0]?.reason).toMatch(/^unmapped-model-alias: "haiku"/);
    expect(field("alias-unmapped")[0]?.level).toBe("info");

    expect(agents["claude-id"]?.model).toBe("anthropic/claude-sonnet-4-5");
    expect(field("claude-id")).toEqual([]);

    expect("color" in agents["unmapped-color"]!).toBe(false);
    expect(field("unmapped-color")[0]?.reason).toMatch(/^unmapped-color: "mauve"/);

    expect(field("dropped")[0]?.reason).toMatch(/^dropped-fields: skills, memory$/);
  });

  test("user-provided model alias maps through options.models", () => {
    const ctx = makeCtx({
      worktree: join(FIXTURES, "fields"),
      rawOptions: { models: { haiku: "github-copilot/claude-haiku-4" } },
    });
    const { agents } = discoverClaudeAgents(ctx);
    expect(agents["alias-unmapped"]?.model).toBe("github-copilot/claude-haiku-4");
  });

  test("truly broken frontmatter -> warn unparseable, file skipped", () => {
    const ctx = makeCtx({ worktree: join(FIXTURES, "unparseable") });
    const { agents, diagnostics } = discoverClaudeAgents(ctx);
    expect(agents).toEqual({});
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.level).toBe("warn");
    expect(diagnostics[0]?.reason).toBe("unparseable");
    expect(diagnostics[0]?.file?.endsWith("broken.md")).toBe(true);
  });

  test("nearest root wins a name collision; user-scope gated by claude.user", () => {
    const worktree = join(FIXTURES, "nested-user");
    const directory = join(worktree, "directory");
    const home = join(worktree, "home");

    const on = discoverClaudeAgents(makeCtx({ worktree, directory, home }));
    expect(on.agents["shared"]?.description).toBe("Nearest root wins.");
    expect(on.diagnostics.some((d) => d.reason === "duplicate")).toBe(true);
    expect(on.agents["user-agent"]?.permission).toEqual({ "*": "deny", read: "allow", grep: "allow" });

    const off = discoverClaudeAgents(
      makeCtx({ worktree, directory, home, rawOptions: { claude: { user: false } } }),
    );
    expect(off.agents["user-agent"]).toBeUndefined();
    expect(Object.keys(off.agents)).toEqual(["shared"]);
  });
});

describe("claudeAgents fragment wiring", () => {
  test("diagnostics land both on the fragment and on ctx.diag; agent omitted when empty", () => {
    const empty = claudeAgents(makeCtx({ worktree: join(FIXTURES, "skipped") }));
    expect(empty.agent).toBeUndefined();
    expect(empty.diagnostics.length).toBeGreaterThan(0);
    expect(empty.diagnostics.length).toBe(2);

    const full = claudeAgents(makeCtx({ worktree: join(FIXTURES, "full") }));
    expect(full.agent && Object.keys(full.agent)).toEqual(["reviewer"]);
    expect(full.diagnostics).toEqual([]);
  });
});
