import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { Hooks } from "@opencode-ai/plugin";
import { ApplyToHook, type ApplyToState } from "../../src/hooks/apply-to.js";
import type { PathScopedInstruction } from "../../src/sources/types.js";

function scoped(overrides: Partial<PathScopedInstruction> = {}): PathScopedInstruction {
  return {
    file: "/repo/.github/instructions/ts.instructions.md",
    applyTo: "**/*.ts",
    patterns: ["**/*.ts"],
    content: "Use `type` imports.",
    ...overrides,
  };
}

interface AfterInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: any;
}

type AfterOutput = { title: string; output: string; metadata: any };

async function callHook(
  hook: ApplyToHook,
  input: Partial<AfterInput>,
  output?: AfterOutput,
): Promise<AfterOutput> {
  const out: AfterOutput = output ?? { title: "src/a.ts", output: "ORIGINAL", metadata: {} };
  const handler = hook.handle as NonNullable<Hooks["tool.execute.after"]>;
  await handler(
    { tool: "read", sessionID: "s1", callID: "c1", args: { filePath: "/repo/src/a.ts" }, ...input },
    out,
  );
  return out;
}

function banner(state: { file: string; applyTo: string; content: string }): string {
  return `<system-reminder>\nInstructions from: ${state.file} (applyTo: ${state.applyTo})\n${state.content}\n</system-reminder>`;
}

describe("ApplyToHook (C1: tool.execute.after on read)", () => {
  test("a matching read appends the instruction once; an identical second read is not appended again", async () => {
    let state: ApplyToState | undefined = { worktree: "/repo", instructions: [scoped()] };
    const hook = new ApplyToHook(() => state);

    const first = await callHook(hook, {});
    expect(first.output).toBe(`ORIGINAL\n\n${banner({ ...scoped() })}`);

    // same session + same file again -> no second copy
    const second = await callHook(hook, { callID: "c2" });
    expect(second.output).toBe("ORIGINAL");
  });

  test("a different session gets its own injection (memory is keyed per session)", async () => {
    let state: ApplyToState | undefined = { worktree: "/repo", instructions: [scoped()] };
    const hook = new ApplyToHook(() => state);
    await callHook(hook, { sessionID: "s1" });
    const otherSession = await callHook(hook, { sessionID: "s2" });
    expect(otherSession.output).toBe(`ORIGINAL\n\n${banner({ ...scoped() })}`);
  });

  test("dispose clears the once-per-session memory", async () => {
    let state: ApplyToState | undefined = { worktree: "/repo", instructions: [scoped()] };
    const hook = new ApplyToHook(() => state);
    const first = await callHook(hook, {});
    expect(first.output.split("<system-reminder>").length - 1).toBe(1);
    const second = await callHook(hook, { callID: "c2" });
    expect(second.output).toBe("ORIGINAL"); // still exactly one copy in session
    hook.dispose();
    const third = await callHook(hook, { callID: "c3" });
    expect(third.output.split("<system-reminder>").length - 1).toBe(1); // appended again after dispose
  });

  test("a read of a file no pattern matches leaves the output untouched", async () => {
    let state: ApplyToState | undefined = { worktree: "/repo", instructions: [scoped()] };
    const hook = new ApplyToHook(() => state);
    const out = await callHook(hook, { args: { filePath: "/repo/README.md" } });
    expect(out.output).toBe("ORIGINAL");
  });

  test("several matching instructions are appended together, registry order kept", async () => {
    const ts = scoped();
    const style = scoped({
      file: "/repo/.github/instructions/style.instructions.md",
      applyTo: "src/**/*.ts",
      patterns: ["src/**/*.ts"],
      content: "No default exports.",
    });
    let state: ApplyToState | undefined = { worktree: "/repo", instructions: [ts, style] };
    const hook = new ApplyToHook(() => state);
    const out = await callHook(hook, {});
    expect(out.output).toBe(
      `ORIGINAL\n\n${banner({ ...ts })}\n\n${banner({ ...style })}`,
    );
  });

  test("non-read tools are ignored", async () => {
    let state: ApplyToState | undefined = { worktree: "/repo", instructions: [scoped()] };
    const hook = new ApplyToHook(() => state);
    const out = await callHook(hook, { tool: "bash" });
    expect(out.output).toBe("ORIGINAL");
  });

  test("a missing or non-string filePath is ignored without throwing", async () => {
    let state: ApplyToState | undefined = { worktree: "/repo", instructions: [scoped()] };
    const hook = new ApplyToHook(() => state);
    expect((await callHook(hook, { args: {} })).output).toBe("ORIGINAL");
    expect((await callHook(hook, { args: { filePath: 42 } })).output).toBe("ORIGINAL");
  });

  test("no state (mode ignore / nothing path-scoped / plugin disabled) means a no-op hook", async () => {
    let state: ApplyToState | undefined;
    const hook = new ApplyToHook(() => state);
    expect((await callHook(hook, {})).output).toBe("ORIGINAL");
    state = { worktree: "/repo", instructions: [] };
    expect((await callHook(hook, {})).output).toBe("ORIGINAL");
  });

  test("a Windows backslash filePath (as tool/read.ts can receive) matches a posix glob via native join on win32", async () => {
    const worktree = process.platform === "win32" ? "C:\\repo" : "/repo";
    const filePath = join(worktree, "src", "main.ts");
    let state: ApplyToState | undefined = {
      worktree,
      instructions: [scoped({ file: `${worktree}/.github/instructions/ts.instructions.md` })],
    };
    const hook = new ApplyToHook(() => state);
    const out = await callHook(hook, { args: { filePath } });
    if (process.platform !== "win32") return; // posix control: join yields forward slashes, same matcher
    expect(out.output.startsWith("ORIGINAL\n\n<system-reminder>")).toBe(true); // real backslashes matched the posix glob
  });
});
