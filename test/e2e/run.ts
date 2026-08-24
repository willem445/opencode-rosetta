#!/usr/bin/env bun
/**
 * End-to-end harness: builds `dist/index.js`, points a *real* opencode
 * 1.18.21 binary at the fixture repo below (with global config isolated
 * into `fixture/home`, so the machine's own `~/.config/opencode` is never
 * touched), and asserts on `opencode debug config` / `agent list` / `debug
 * skill` / `mcp list` output plus a negative control (`--pure`, which
 * disables every external plugin -- opencode's own documented mechanism,
 * simpler than maintaining a second copy of the whole fixture tree).
 *
 * One assert block per artifact, `TODO(Sx)` where the translating source is
 * still a stub (S1 ships every fixture *file*; each later slice only adds
 * its own assert block here, never touches the fixture tree).
 *
 * Every `opencode` invocation's stdout+stderr is saved under `out/*.txt` --
 * uploaded as a CI artifact and pasted into the PR.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const fixtureDir = join(repoRoot, "test", "e2e", "fixture");
const homeDir = join(fixtureDir, "home");
const outDir = join(repoRoot, "test", "e2e", "out");

function log(message: string): void {
  console.log(`[e2e] ${message}`);
}

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    log(`OK   ${message}`);
  } else {
    failures += 1;
    log(`FAIL ${message}`);
  }
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): RunResult {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    env: opts.env ?? process.env,
    encoding: "utf8",
    shell: true,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function save(name: string, result: RunResult): void {
  writeFileSync(join(outDir, name), `$ (exit ${result.status})\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`);
}

/** Global config isolated into fixture/home -- S1 confirmed this via `opencode debug paths`, pasted in the PR. */
function isolatedEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
  };
}

function posix(p: string): string {
  return p.replaceAll("\\", "/");
}

function main(): void {
  mkdirSync(outDir, { recursive: true });

  log("building dist/index.js (self-sufficient: does not depend on `bun run build` having run already)");
  const build = run(process.execPath, ["build", "src/index.ts", "--outdir", "dist", "--target", "node", "--format", "esm"]);
  save("build.txt", build);
  if (build.status !== 0) throw new Error(`build failed, see ${join(outDir, "build.txt")}`);

  const env = isolatedEnv();

  // --- environment oracles (acceptance criterion c) ---
  save("opencode-version.txt", run("opencode", ["--version"]));
  save("opencode-debug-help.txt", run("opencode", ["debug", "--help"]));
  save("opencode-debug-paths.txt", run("opencode", ["debug", "paths"], { env }));

  // --- step 1: opencode debug config, plugin active ---
  const withPlugin = run("opencode", ["debug", "config"], { cwd: fixtureDir, env });
  save("debug-config.with-plugin.txt", withPlugin);
  check(withPlugin.status === 0, "opencode debug config (plugin active) exits 0");

  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(withPlugin.stdout) as Record<string, unknown>;
  } catch (err) {
    failures += 1;
    log(`FAIL could not parse debug config JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const instructions = Array.isArray(cfg.instructions) ? (cfg.instructions as unknown[]) : [];
  check(
    instructions.some((p) => typeof p === "string" && posix(p).endsWith(".github/copilot-instructions.md")),
    "cfg.instructions contains the absolute path of .github/copilot-instructions.md (S1 proof-of-life, B5)",
  );

  const agents = (cfg.agent ?? {}) as Record<string, { description?: unknown }>;
  check(
    typeof agents["keep-me"]?.description === "string" &&
      (agents["keep-me"].description as string).includes("never overwrites"),
    "agent.keep-me (defined directly in opencode.json) survives untouched -- precedence rule 1",
  );

  // TODO(S2): agent.reviewer.mode === "subagent"; agent.reviewer.permission["*"] === "deny"; agent["user-agent"] present.
  // TODO(S2): command.component.template contains "$1" (Claude $0 -> opencode $1, F12); command["user-cmd"] present.
  // TODO(S3): mcp.echo.type === "local"; mcp["remote-example"].url has ${REMOTE_MCP_URL:-...} expanded; vscode-echo server has `environment`.
  // TODO(S4): command.plan present (Copilot prompt); cfg.skills.paths contains an absolute path ending .github/skills.
  // TODO(S5): agent.planner present, mode === "all".

  // --- step 2: opencode agent list ---
  save("agent-list.txt", run("opencode", ["agent", "list"], { cwd: fixtureDir, env }));
  // TODO(S2): assert "reviewer" listed as a subagent.
  // TODO(S5): assert "planner" listed with mode "all".

  // --- step 3: opencode debug agent reviewer ---
  // TODO(S2): assert tools.edit === false, tools.read === true (acceptance criterion for S1's own DoD, verified by S2).

  // --- step 4: opencode debug skill ---
  const skillList = run("opencode", ["debug", "skill"], { cwd: fixtureDir, env });
  save("debug-skill.txt", skillList);
  check(skillList.stdout.includes("native-skill"), "debug skill lists native-skill (native control -- F9, no rosetta involved)");
  // TODO(S4): assert copilot-skill also appears once copilot.skills stops being a stub.

  // --- step 5: opencode mcp list ---
  save("mcp-list.txt", run("opencode", ["mcp", "list"], { cwd: fixtureDir, env }));
  // TODO(S3): assert "echo" connected (proves the command array); unresolved ${input:} server absent + warn logged.

  // --- step 6: negative control -- --pure disables every external plugin (documented CLI flag, F14) ---
  const negative = run("opencode", ["debug", "config", "--pure"], { cwd: fixtureDir, env });
  save("debug-config.negative-control.txt", negative);
  check(negative.status === 0, "opencode debug config --pure (plugin disabled) exits 0");
  let negCfg: Record<string, unknown> = {};
  try {
    negCfg = JSON.parse(negative.stdout) as Record<string, unknown>;
  } catch {
    // captured in the saved output either way
  }
  const negInstructions = Array.isArray(negCfg.instructions) ? (negCfg.instructions as unknown[]) : [];
  check(
    !negInstructions.some((p) => typeof p === "string" && posix(p).endsWith(".github/copilot-instructions.md")),
    "negative control (--pure): .github/copilot-instructions.md is NOT in cfg.instructions",
  );
  const negAgents = (negCfg.agent ?? {}) as Record<string, unknown>;
  check("keep-me" in negAgents, "negative control (--pure): agent.keep-me (native opencode.json config) still present");

  log(`${failures === 0 ? "PASS" : "FAIL"} -- ${failures} failing check(s). Full output saved under test/e2e/out/.`);
  if (failures > 0) process.exit(1);
}

main();
