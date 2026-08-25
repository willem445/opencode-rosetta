import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import type { Hooks } from "@opencode-ai/plugin";
import { ApplyToHook, type ApplyToHookOptions, type ApplyToState } from "../../src/hooks/apply-to.js";
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

function makeState(overrides: Partial<ApplyToState> = {}): ApplyToState {
  return { worktree: "/repo", directory: "/repo", instructions: [scoped()], ...overrides };
}

/**
 * Unit-testable hook: the file-existence check defaults to real fs in
 * production but stubs to "everything is a file" here, so fixtures can use
 * paths that do not exist on disk. Tests that specifically pin the
 * directory/file distinction pass a real `isTargetFile`.
 */
function makeHook(
  state: ApplyToState | undefined,
  opts: Omit<ApplyToHookOptions, "isTargetFile"> & { isTargetFile?: ApplyToHookOptions["isTargetFile"] } = {},
): ApplyToHook {
  const { isTargetFile = () => true, ...rest } = opts;
  return new ApplyToHook(() => state, { isTargetFile, ...rest });
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
): Promise<AfterOutput> {
  const out: AfterOutput = { title: "src/a.ts", output: "ORIGINAL", metadata: {} };
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
    let state: ApplyToState | undefined = makeState();
    const hook = makeHook(state);

    const first = await callHook(hook, {});
    expect(first.output).toBe(`ORIGINAL\n\n${banner({ ...scoped() })}`);

    // same session + same file again -> no second copy
    const second = await callHook(hook, { callID: "c2" });
    expect(second.output).toBe("ORIGINAL");
  });

  test("a different session gets its own injection (memory is keyed per session)", async () => {
    let state: ApplyToState | undefined = makeState();
    const hook = makeHook(state);
    await callHook(hook, { sessionID: "s1" });
    const otherSession = await callHook(hook, { sessionID: "s2" });
    expect(otherSession.output).toBe(`ORIGINAL\n\n${banner({ ...scoped() })}`);
  });

  test("dispose clears the once-per-session memory", async () => {
    let state: ApplyToState | undefined = makeState();
    const hook = makeHook(state);
    const first = await callHook(hook, {});
    expect(first.output.split("<system-reminder>").length - 1).toBe(1);
    const second = await callHook(hook, { callID: "c2" });
    expect(second.output).toBe("ORIGINAL"); // still exactly one copy in session
    hook.dispose();
    const third = await callHook(hook, { callID: "c3" });
    expect(third.output.split("<system-reminder>").length - 1).toBe(1); // appended again after dispose
  });

  test("a read of a file no pattern matches leaves the output untouched", async () => {
    let state: ApplyToState | undefined = makeState();
    const hook = makeHook(state);
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
    let state: ApplyToState | undefined = makeState({ instructions: [ts, style] });
    const hook = makeHook(state);
    const out = await callHook(hook, {});
    expect(out.output).toBe(
      `ORIGINAL\n\n${banner({ ...ts })}\n\n${banner({ ...style })}`,
    );
  });

  test("non-read tools are ignored", async () => {
    let state: ApplyToState | undefined = makeState();
    const hook = makeHook(state);
    const out = await callHook(hook, { tool: "bash" });
    expect(out.output).toBe("ORIGINAL");
  });

  test("a missing or non-string filePath is ignored without throwing", async () => {
    let state: ApplyToState | undefined = makeState();
    const hook = makeHook(state);
    expect((await callHook(hook, { args: {} })).output).toBe("ORIGINAL");
    expect((await callHook(hook, { args: { filePath: 42 } })).output).toBe("ORIGINAL");
  });

  test("no state (mode ignore / nothing path-scoped / plugin disabled) means a no-op hook", async () => {
    let state: ApplyToState | undefined;
    const hook = makeHook(state);
    expect((await callHook(hook, {})).output).toBe("ORIGINAL");
    state = makeState({ instructions: [] });
    expect((await callHook(hook, {})).output).toBe("ORIGINAL");
  });

  test("relative filePaths resolve against the instance directory like tool/read.ts does (directory != worktree)", async () => {
    // read.ts @ v1.18.21: path.resolve(instance.directory, filepath)
    let state: ApplyToState | undefined = makeState({
      worktree: "/repo",
      directory: "/repo/packages/app",
      instructions: [scoped({ patterns: ["packages/app/**/*.ts"], applyTo: "packages/app/**/*.ts" })],
    });
    const hook = makeHook(state);
    // resolves to /repo/packages/app/src/main.ts -> worktree-relative packages/app/src/main.ts -> match
    const out = await callHook(hook, { args: { filePath: "src/main.ts" } });
    expect(out.output.startsWith("ORIGINAL\n\n<system-reminder>")).toBe(true);
  });

  test("a relative read launched from a subdir does NOT match a glob written against the wrong base", async () => {
    let state: ApplyToState | undefined = makeState({
      worktree: "/repo",
      directory: "/repo/packages/app",
      instructions: [scoped({ patterns: ["src/**/*.ts"] })],
    });
    const hook = makeHook(state);
    // OLD behaviour treated "src/main.ts" as worktree-relative -> src/main.ts -> wrongly matched.
    // Correct: it resolves to packages/app/src/main.ts -> no match.
    const out = await callHook(hook, { args: { filePath: "src/main.ts" } });
    expect(out.output).toBe("ORIGINAL");
  });

  describe("only file reads inject (Copilot applyTo targets files)", () => {
    const root = mkdtempSync(join(tmpdir(), "opencode-rosetta-hook-"));
    const dirPath = join(root, "adir");
    const filePath = join(root, "main.ts");

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    test("a matching directory path gets no injection; a matching file does", async () => {
      mkdirSync(dirPath, { recursive: true });
      writeFileSync(filePath, "export {};");
      let state: ApplyToState | undefined = makeState({
        worktree: root,
        directory: root,
        instructions: [scoped({ patterns: ["**/*"], applyTo: "**/*" })],
      });
      // production default file check (real fs) -- constructed directly
      const hook = new ApplyToHook(() => state);
      const dirOut = await callHook(hook, { args: { filePath: dirPath } });
      expect(dirOut.output).toBe("ORIGINAL"); // directory listing: not injected

      const otherSession = await callHook(hook, { sessionID: "s-other", args: { filePath: filePath } });
      expect(otherSession.output.startsWith("ORIGINAL\n\n<system-reminder>")).toBe(true); // file read: injected
    });
  });

  test("the dedup memory is bounded: at the cap the oldest key is evicted and its file can inject again", async () => {
    let state: ApplyToState | undefined = makeState();
    const hook = makeHook(state, { maxTracked: 2 });
    await callHook(hook, { args: { filePath: "/repo/a.ts" } }); // key A
    await callHook(hook, { args: { filePath: "/repo/b.ts" } }); // key B -> memory [A,B]
    await callHook(hook, { args: { filePath: "/repo/c.ts" } }); // evicts A -> [B,C]
    const reReadA = await callHook(hook, { args: { filePath: "/repo/a.ts" } }); // A was evicted -> injects
    expect(reReadA.output.split("<system-reminder>").length - 1).toBe(1);
  });

  test("a natively-joined filePath matches the posix glob on BOTH platforms (real backslashes on win32)", async () => {
    const worktree = process.platform === "win32" ? "C:\\repo" : "/repo";
    const filePath = join(worktree, "src", "main.ts");
    let state: ApplyToState | undefined = makeState({
      worktree,
      directory: worktree,
      instructions: [scoped({ file: `${worktree}/.github/instructions/ts.instructions.md` })],
    });
    const hook = makeHook(state);
    const out = await callHook(hook, { args: { filePath } });
    // Asserted unconditionally: on win32 this drives real backslashes through the matcher;
    // on linux it pins the posix flow. Either platform failing normalization fails here.
    expect(out.output.startsWith("ORIGINAL\n\n<system-reminder>")).toBe(true);
  });
});
