import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { copilotAgents, discoverCopilotAgents } from "../../src/sources/copilot/agents.js";
import { makeCtx } from "../helpers.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "copilot", "agents");

function fullCtx(rawOptions?: Record<string, unknown>) {
  return makeCtx({
    worktree: join(FIXTURES, "full"),
    rawOptions: {
      models: {
        "Claude Sonnet 4": "github-copilot/claude-sonnet-4",
        "Claude Haiku": "github-copilot/claude-haiku-4",
      },
      ...rawOptions,
    },
  });
}

describe("discoverCopilotAgents (B7)", () => {
  test("full mapping table: tools allowlist -> permission (never `tools`), agents rule, model via options.models", () => {
    const { agents, diagnostics } = discoverCopilotAgents(fullCtx());

    expect(agents["planner"]).toEqual({
      description: "Plans multi-step work before any code is written.",
      prompt: "You are a planning agent. Read the codebase, then produce a step-by-step plan.",
      mode: "all", // B7 default: user-invocable AND model-invocable
      permission: {
        "*": "deny",
        read: "allow",
        // search family -> grep + glob + list
        grep: "allow",
        glob: "allow",
        list: "allow",
        edit: "allow", // edit/* -> edit
        task: { "*": "deny", "researcher-agent": "allow" }, // agents: [researcher-agent]
      },
      model: "github-copilot/claude-sonnet-4",
    });
    expect(JSON.stringify(agents["planner"])).not.toContain('"tools"'); // F5

    const plannerDiags = diagnostics.filter((d) => d.file?.endsWith("planner.agent.md"));
    const droppedTools = plannerDiags.find((d) => d.reason.startsWith("dropped-tools"));
    expect(droppedTools?.level).toBe("info");
    expect(droppedTools?.reason).toBe("dropped-tools: githubRepo");
    const droppedFields = plannerDiags.find((d) => d.reason.startsWith("dropped-fields"));
    expect(droppedFields?.level).toBe("info");
    expect(droppedFields?.reason).toBe("dropped-fields: mcp-servers, target, infer");

    // chatmode file, disable-model-invocation -> primary; web family -> webfetch + websearch
    expect(agents["ask"]).toEqual({
      description: "Answer questions about the codebase without editing anything.",
      prompt: "Answer the user's questions. You cannot invoke other agents.",
      mode: "primary",
      permission: { "*": "deny", read: "allow", webfetch: "allow", websearch: "allow" },
    });

    // user-invocable: false -> subagent; frontmatter name wins over basename
    expect(agents["researcher-agent"]?.mode).toBe("subagent");

    // model array: first mappable candidate wins
    expect(agents["model-array"]?.model).toBe("github-copilot/claude-haiku-4");
  });

  test("tools edge cases: '*' and absent emit no rule; MCP ids sanitized; unknown tools dropped", () => {
    const ctx = makeCtx({ worktree: join(FIXTURES, "tools") });
    const { agents, diagnostics } = discoverCopilotAgents(ctx);

    expect(agents["star"]?.permission).toBeUndefined(); // tools: "*" -> no rule
    expect(agents["mcp"]?.permission).toEqual({
      "*": "deny",
      docs_query: "allow", // docs/query -> <server>_<tool>, sanitized
      "docs_*": "allow", // docs/* -> whole-server wildcard
      question: "allow", // vscode/askQuestions
      task: "deny", // agents: [] -- explicit deny even under an allowlist
    });

    const mcpDiags = diagnostics.filter((d) => d.file?.endsWith("mcp.agent.md"));
    const dropped = mcpDiags.find((d) => d.reason.startsWith("dropped-tools"));
    expect(dropped?.reason).toBe("dropped-tools: browser");
  });

  test("skipped files: missing description info; unparseable warn", () => {
    const ctx = makeCtx({ worktree: join(FIXTURES, "skipped") });
    const { agents, diagnostics } = discoverCopilotAgents(ctx);
    expect(agents).toEqual({});

    const missingDesc = diagnostics.find((d) => d.file?.endsWith("missing-description.agent.md"));
    expect(missingDesc?.level).toBe("info");
    expect(missingDesc?.reason).toBe("missing-description");

    const broken = diagnostics.find((d) => d.file?.endsWith("broken.agent.md"));
    expect(broken?.level).toBe("warn");
    expect(broken?.reason).toBe("unparseable");
  });

  test("unmapped model string/array -> omitted + one info per file", () => {
    const ctx = makeCtx({
      worktree: join(FIXTURES, "full"),
      rawOptions: {}, // no models map at all
    });
    const { agents, diagnostics } = discoverCopilotAgents(ctx);
    expect("model" in agents["planner"]!).toBe(false);
    expect("model" in agents["model-array"]!).toBe(false);
    const unmapped = diagnostics.filter((d) => d.field === "model" && d.reason.startsWith("unmapped-model"));
    expect(unmapped).toHaveLength(2); // planner + model-array, one each
    for (const d of unmapped) {
      expect(d.level).toBe("info");
      expect(d.source).toBe("copilot.agents");
    }
  });

  test("nearest root wins a collision; user scope gated by copilot.user", () => {
    const worktree = join(FIXTURES, "collision");
    const directory = join(worktree, "directory");
    const home = join(worktree, "home");

    const on = discoverCopilotAgents(makeCtx({ worktree, directory, home }));
    expect(on.agents["shared"]?.description).toBe("Nearest project root wins.");
    expect(on.diagnostics.some((d) => d.reason === "duplicate")).toBe(true);
    expect(on.agents["user-copilot-agent"]?.description).toBe("User-scope copy, farther away.");

    const off = discoverCopilotAgents(
      makeCtx({ worktree, directory, home, rawOptions: { copilot: { user: false } } }),
    );
    expect(off.agents["user-copilot-agent"]).toBeUndefined();
    expect(off.agents["shared"]?.description).toBe("Nearest project root wins.");
  });
});

describe("copilotAgents fragment wiring", () => {
  test("diagnostics land both on the fragment and on ctx.diag; agent omitted when empty", () => {
    const empty = copilotAgents(makeCtx({ worktree: join(FIXTURES, "skipped") }));
    expect(empty.agent).toBeUndefined();
    expect(empty.diagnostics.length).toBeGreaterThan(0);
    expect(empty.diagnostics.length).toBe(2);

    const ctx = fullCtx();
    const full = copilotAgents(ctx);
    expect(full.agent && Object.keys(full.agent)).toEqual([
      "model-array",
      "planner",
      "researcher-agent",
      "ask",
    ]);
    expect(full.diagnostics.length).toBeGreaterThan(0);
    expect(ctx.diag.all().length).toBeGreaterThan(0);
  });
});
