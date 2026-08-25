import { describe, expect, test } from "bun:test";
import { toolsToPermission } from "../src/permission.js";

const ARGS = { source: "claude.agents", file: "/repo/.claude/agents/a.md" };

describe("toolsToPermission (B1 tools/disallowedTools rows)", () => {
  test("no tools and no disallowedTools -> no permission object at all", () => {
    const result = toolsToPermission({ ...ARGS });
    expect(result.permission).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  test("allowlist -> { '*': 'deny', ...allows } (opencode's native explore shape)", () => {
    const result = toolsToPermission({ ...ARGS, tools: "Read, Grep" });
    expect(result.permission).toEqual({ "*": "deny", read: "allow", grep: "allow" });
  });

  test("array form works too", () => {
    const result = toolsToPermission({ ...ARGS, tools: ["Read", "Write"] });
    expect(result.permission).toEqual({ "*": "deny", read: "allow", edit: "allow" });
  });

  test("edit-family tools all collapse onto `edit`", () => {
    const result = toolsToPermission({ ...ARGS, tools: ["Edit", "MultiEdit", "Write", "NotebookEdit"] });
    expect(result.permission).toEqual({ "*": "deny", edit: "allow" });
  });

  test("Bash(git *) -> bash pattern allow under the deny-all umbrella", () => {
    const result = toolsToPermission({ ...ARGS, tools: "Read, Bash(git diff:*)" });
    expect(result.permission).toEqual({
      "*": "deny",
      read: "allow",
      bash: { "git diff:*": "allow" },
    });
  });

  test("Task(a, b) pins '*': 'deny' so unlisted subagent types stay denied (B1 row)", () => {
    const result = toolsToPermission({ ...ARGS, tools: ["Agent(a, b)"] });
    expect(result.permission).toEqual({ "*": "deny", task: { "*": "deny", a: "allow", b: "allow" } });
  });

  test("a plain Task allow followed by Task(spec) keeps the whole-tool allow via '*'", () => {
    const result = toolsToPermission({ ...ARGS, tools: ["Task", "Agent(a)"] });
    expect(result.permission).toEqual({ "*": "deny", task: { "*": "allow", a: "allow" } });
  });

  test("mcp__srv -> '<srv>_*': allow; mcp__srv__tool -> '<srv>_<tool>': allow", () => {
    const result = toolsToPermission({ ...ARGS, tools: "mcp__github, mcp__db__query" });
    expect(result.permission).toEqual({ "*": "deny", "github_*": "allow", db_query: "allow" });
  });

  test("MCP segments get opencode's own sanitization (non [a-zA-Z0-9_-] -> _)", () => {
    const result = toolsToPermission({ ...ARGS, tools: "mcp__My Server__tool.name" });
    expect(result.permission).toEqual({ "*": "deny", My_Server_tool_name: "allow" });
  });

  test("unknown tool -> dropped with a warn diagnostic, rest still translates", () => {
    const result = toolsToPermission({ ...ARGS, tools: "Read, FooBar" });
    expect(result.permission).toEqual({ "*": "deny", read: "allow" });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.level).toBe("warn");
    expect(result.diagnostics[0]?.reason).toMatch(/^unknown-tool: "FooBar"$/);
    expect(result.diagnostics[0]?.field).toBe("tools");
    expect(result.diagnostics[0]?.source).toBe("claude.agents");
  });

  test("disallowedTools appends denies after allows (later key write wins)", () => {
    const result = toolsToPermission({ ...ARGS, tools: "Bash(git *)", disallowedTools: "Bash(push*)" });
    expect(result.permission).toEqual({ "*": "deny", bash: { "git *": "allow", "push*": "deny" } });
  });

  test("disallowedTools alone -> only the denies, no blanket '*': 'deny'", () => {
    const result = toolsToPermission({ ...ARGS, disallowedTools: "WebFetch" });
    expect(result.permission).toEqual({ webfetch: "deny" });
  });

  test("specific MCP denies survive translation (review finding 1: access-widening regression pin)", () => {
    // "GitHub MCP, except repo deletion" must not come out as "all of GitHub".
    const result = toolsToPermission({ ...ARGS, tools: "mcp__db", disallowedTools: "mcp__db__query" });
    expect(result.permission).toEqual({ "*": "deny", "db_*": "allow", db_query: "deny" });
    expect(result.diagnostics).toEqual([]);
  });

  test("blanket mcp__* on the ALLOW side -> dropped + warn (mirror of the deny-side pin)", () => {
    // The deny side's regression was invisible because nothing pinned it;
    // this pins the symmetric path so it cannot quietly change either.
    const result = toolsToPermission({ ...ARGS, tools: "Read, mcp__*" });
    expect(result.permission).toEqual({ "*": "deny", read: "allow" });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.level).toBe("warn");
    expect(result.diagnostics[0]?.reason).toContain("all-MCP");
    expect(result.diagnostics[0]?.field).toBe("tools");
  });

  test("blanket mcp__* as the ONLY entry -> deny-all umbrella stays (fail-safe) + warn", () => {
    // Pinned ACTUAL behavior (round 3): when the only allowlist entry was
    // dropped as inexpressible, the `"*": "deny"` umbrella REMAINS -- the
    // agent ends up fully restricted rather than unrestricted. That is the
    // safe direction (an allowlist that translates partially must never
    // widen access), and it is loud (`warn`), so this is intentional,
    // not a silent drop. Flagged to the orchestrator in round 3.
    const result = toolsToPermission({ ...ARGS, tools: "mcp__*" });
    expect(result.permission).toEqual({ "*": "deny" });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.level).toBe("warn");
    expect(result.diagnostics[0]?.reason).toContain("all-MCP");
  });

  test("mcp__* in disallowedTools -> dropped + warn (no all-MCP rule exists)", () => {
    const result = toolsToPermission({ ...ARGS, disallowedTools: "mcp__*" });
    expect(result.permission).toBeUndefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.level).toBe("warn");
    expect(result.diagnostics[0]?.reason).toContain("all-MCP");
    expect(result.diagnostics[0]?.field).toBe("disallowedTools");
  });

  test("empty-string / empty-array tools behave like absent", () => {
    for (const tools of ["", " , ", []]) {
      const result = toolsToPermission({ ...ARGS, tools });
      expect(result.permission).toBeUndefined();
    }
  });
});
