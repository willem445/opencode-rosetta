import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { discoverClaudeCommands, translateBody } from "../../src/sources/claude/commands.js";
import { makeCtx } from "../helpers.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "claude", "commands");

describe("translateBody (B2 template rewrites, F12)", () => {
  const opts = { argumentNames: [] as string[], worktree: "/repo" };

  test("$0 -> $1 (Claude $N is 0-based; opencode's is 1-based)", () => {
    expect(translateBody("name it $0 please", { ...opts })).toBe("name it $1 please");
  });

  test("$ARGUMENTS[N] -> $<N+1>", () => {
    expect(translateBody("from $ARGUMENTS[2] to $ARGUMENTS[0]", { ...opts })).toBe("from $3 to $1");
  });

  test("a shifted placeholder is never shifted twice", () => {
    expect(translateBody("$1 and $0", { ...opts })).toBe("$2 and $1");
  });

  test("$ARGUMENTS passes through untouched", () => {
    expect(translateBody("all: $ARGUMENTS", { ...opts })).toBe("all: $ARGUMENTS");
  });

  test("\\$ escape becomes a literal $ AFTER the shift (not itself shifted)", () => {
    // actual input text: `cost \$5, arg $0 stays literal`
    expect(translateBody("cost \\$5, arg $0 stays literal", { ...opts })).toBe(
      "cost $5, arg $1 stays literal",
    );
  });

  test("${CLAUDE_PROJECT_DIR} -> worktree", () => {
    expect(translateBody("run in ${CLAUDE_PROJECT_DIR}/scripts", opts)).toBe("run in /repo/scripts");
  });

  test("named arguments map to their declared position", () => {
    expect(
      translateBody("$branch <- $issue", { argumentNames: ["issue", "branch"], worktree: "/repo" }),
    ).toBe("$2 <- $1");
  });

  test("named substitution is token-exact: `$branch` never matches inside `$branches` (review finding 3)", () => {
    expect(
      translateBody("$branch then $branches and $branchX", { argumentNames: ["branch"], worktree: "/repo" }),
    ).toBe("$1 then $branches and $branchX");
  });

  test("shell injection and @file references pass through unchanged", () => {
    const body = "!`git status` then @src/README.md with $0";
    expect(translateBody(body, opts)).toBe("!`git status` then @src/README.md with $1");
  });
});

describe("discoverClaudeCommands (B2)", () => {
  test("basename key (subdir not in the name), description + argument-hint, fork + known agent", () => {
    const ctx = makeCtx({ worktree: join(FIXTURES, "full") });
    const { commands } = discoverClaudeCommands(ctx);
    // subdir `frontend/` must NOT be part of the command name
    expect(Object.keys(commands)).toEqual(["component"]);
    expect(commands["component"]).toEqual({
      template: "Create a new component named $1 in src/components. Extra: $ARGUMENTS",
      description: "Scaffold a new frontend component — args: name",
      subtask: true,
      agent: "explore", // Explore -> opencode's built-in explore
    });
  });

  test("named arguments, $ARGUMENTS[N], \\$ escape, ${CLAUDE_PROJECT_DIR}", () => {
    const ctx = makeCtx({ worktree: join(FIXTURES, "args") });
    const { commands, diagnostics } = discoverClaudeCommands(ctx);
    const worktree = ctx.worktree;
    expect(commands["migrate"]?.template).toBe(
      // the `\$1` escape lands as a literal "$1" (documented limitation:
      // opencode has no template escape, so opencode itself will treat it
      // as positional reference #1 at invocation time)
      `Migrate $1 from $2, extra $3, literal $1. Run in ${worktree}.`,
    );
    expect(diagnostics).toEqual([]);
  });

  test("basename collision across two roots -> nearest wins + warn duplicate", () => {
    const worktree = join(FIXTURES, "collision");
    const directory = join(worktree, "directory");
    const { commands, diagnostics } = discoverClaudeCommands(makeCtx({ worktree, directory }));
    expect(commands["deploy"]?.description).toBe("Near");
    const dup = diagnostics.find((d) => d.reason === "duplicate");
    expect(dup?.level).toBe("warn");
    expect(dup?.field).toBe("command.deploy");
    // file paths are posix-normalized; the diagnostic names the LOSING
    // (farther-root) copy, since the nearest one is what won precedence
    expect(dup?.file?.endsWith("commands/collision/.claude/commands/deploy.md")).toBe(true);
    expect(dup?.file?.includes("/directory/")).toBe(false);
  });

  test("fork agent kept when it is a rosetta-translated Claude agent; unknown -> info + omit", () => {
    const { commands, diagnostics } = discoverClaudeCommands(makeCtx({ worktree: join(FIXTURES, "fork") }));

    expect(commands["a"]).toMatchObject({ subtask: true, agent: "helper" });

    expect("agent" in commands["b"]!).toBe(false);
    expect(commands["b"]).toMatchObject({ subtask: true });
    const unknown = diagnostics.find((d) => d.file?.endsWith("b.md"));
    expect(unknown?.level).toBe("info");
    expect(unknown?.reason).toMatch(/^unknown-fork-agent: "Mystery"/);

    expect(commands["c"]).toEqual({ template: "Fork without an agent.", subtask: true }); // fork, no agent
  });

  test("fork agents are only consulted when claude.agents is enabled", () => {
    const { commands } = discoverClaudeCommands(
      makeCtx({ worktree: join(FIXTURES, "fork"), rawOptions: { claude: { agents: false } } }),
    );
    // helper is no longer a recognized name -> omitted + info, not resolved
    expect("agent" in commands["a"]!).toBe(false);
  });
});
