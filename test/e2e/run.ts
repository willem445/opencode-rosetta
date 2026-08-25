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
import { stripAmbientOpencodeEnv } from "./env-filter.js";
import { parseMcpList } from "./mcp-list.js";

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

/**
 * Global config isolated into fixture/home -- S1 confirmed this via `opencode debug paths`, pasted in the PR.
 *
 * Every ambient `OPENCODE`-named variable (prefixed or the bare name) is
 * STRIPPED from the child environment: running `bun run e2e` from inside an
 * opencode-managed session otherwise inherits things like
 * OPENCODE_DISABLE_PROJECT_CONFIG / OPENCODE_CONFIG_CONTENT and every
 * project-config assert fails against an invisible config override. The
 * harness must depend only on the repo, not on the developer's env.
 */
function isolatedEnv(): NodeJS.ProcessEnv {
  // Exactly one strip implementation (reconciled between S2's and S3's N1
  // fixes); the pattern itself is unit-tested in env-filter.test.ts so a
  // future edit cannot silently narrow it back to the bare-OPENCODE leak.
  return {
    ...stripAmbientOpencodeEnv(process.env),
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: join(homeDir, ".config"),
    // Resolves ${input:via-rosetta-input} in .vscode/mcp.json (B9 layer 2).
    ROSETTA_INPUT_VIA_ROSETTA_INPUT: "from-rosetta-input-env",
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

  const agents = (cfg.agent ?? {}) as Record<string, Record<string, unknown>>;
  check(
    typeof agents["keep-me"]?.description === "string" &&
      (agents["keep-me"].description as string).includes("never overwrites"),
    "agent.keep-me (defined directly in opencode.json) survives untouched -- precedence rule 1",
  );

  // --- S2: B1 claude/agents ---
  const reviewer = agents["reviewer"];
  check(reviewer !== undefined, "agent.reviewer present (.claude/agents/reviewer.md -> B1)");
  check(reviewer?.mode === "subagent", "agent.reviewer.mode === 'subagent' (B1: Claude subagents stay subagents)");
  const reviewerPermission = reviewer?.permission as Record<string, unknown> | undefined;
  check(
    reviewerPermission?.["*"] === "deny",
    "agent.reviewer.permission['*'] === 'deny' (tools allowlist -> deny-all + allows, F5)",
  );
  check(
    reviewerPermission?.read === "allow" && reviewerPermission?.grep === "allow",
    "agent.reviewer.permission allows read + grep",
  );
  check(
    JSON.stringify(reviewerPermission?.bash) === JSON.stringify({ "git *": "allow" }),
    "agent.reviewer.permission.bash === { 'git *': 'allow' } (Claude Bash(git *))",
  );
  check(
    reviewerPermission?.edit === "deny",
    "agent.reviewer.permission.edit === 'deny' (permissionMode: plan)",
  );
  check(
    reviewer !== undefined && !("model" in reviewer),
    "agent.reviewer has NO model key (model: sonnet unmapped by fixture options -> omitted, C2)",
  );
  check(agents["user-agent"] !== undefined, "agent['user-agent'] present (~/.claude/agents, B1 user scope)");

  // --- S2: B2 claude/commands ---
  const commands = (cfg.command ?? {}) as Record<string, Record<string, unknown>>;
  check(
    typeof commands["component"]?.template === "string" &&
      (commands["component"].template as string).includes("$1"),
    "command.component.template contains '$1' (Claude $0 -> opencode $1, F12 0-based -> 1-based shift)",
  );
  check(
    commands["component"]?.subtask === true && commands["component"]?.agent === "explore",
    "command.component.subtask === true with agent 'explore' (context: fork + agent: Explore)",
  );
  check(
    typeof commands["component"]?.description === "string" &&
      (commands["component"].description as string).includes("args: name"),
    "command.component.description appends the argument-hint",
  );
  check(
    commands["user-cmd"] !== undefined &&
      (commands["user-cmd"].template as string | undefined)?.includes("$ARGUMENTS") === true,
    "command['user-cmd'] present with $ARGUMENTS untouched (~/.claude/commands, B2 user scope)",
  );

  // --- S3 (B3/B9): MCP fragments in the post-hook config ---
  const mcpCfg = (cfg.mcp ?? {}) as Record<string, Record<string, unknown>>;
  check(mcpCfg["echo"]?.type === "local", "mcp.echo.type === 'local' (Claude stdio, B3)");
  check(
    mcpCfg["remote-example"]?.url === "https://example.invalid/mcp",
    `mcp['remote-example'].url has \${REMOTE_MCP_URL:-...} expanded (got: ${JSON.stringify(mcpCfg["remote-example"]?.url)})`,
  );
  check(
    mcpCfg["remote-example"]?.headers !== undefined &&
      (mcpCfg["remote-example"].headers as Record<string, string>).Authorization === "Bearer unset",
    "mcp['remote-example'].headers.Authorization default-expanded (Bearer unset)",
  );
  check(
    mcpCfg["user-scope-remote"]?.type === "remote",
    "mcp['user-scope-remote'] present from ~/.claude.json top-level (user scope, B3)",
  );
  const missingVarCommand = mcpCfg["missing-var-example"]?.command as string[] | undefined;
  check(
    Array.isArray(missingVarCommand) && missingVarCommand.includes("${ROSETTA_MISSING_VAR}"),
    `missing-var-example keeps \${ROSETTA_MISSING_VAR} LITERAL in cfg (B3: missing var, no default; got: ${JSON.stringify(missingVarCommand)})`,
  );
  check(
    !("vscode-unresolved" in mcpCfg),
    "vscode-unresolved (\${input:github-token}, unresolvable) is ABSENT from cfg.mcp (acceptance)",
  );
  check(
    (mcpCfg["vscode-defaulted"]?.environment as Record<string, string> | undefined)?.TOKEN === "fallback-value",
    "vscode-defaulted resolved via .vscode/mcp.json inputs[].default (B9 layer 3)",
  );
  check(
    (mcpCfg["vscode-env-input"]?.environment as Record<string, string> | undefined)?.TOKEN === "from-rosetta-input-env",
    "vscode-env-input resolved via ROSETTA_INPUT_VIA_ROSETTA_INPUT (B9 layer 2)",
  );

  // --- S5: B7 copilot agent file -> agent.planner ---
  const planner = agents["planner"];
  check(planner !== undefined, "agent.planner present (.github/agents/planner.agent.md -> B7)");
  check(planner?.mode === "all", "agent.planner.mode === 'all' (B7 default: user-invocable AND model-invocable)");
  const plannerPermission = planner?.permission as Record<string, unknown> | undefined;
  check(
    plannerPermission?.["*"] === "deny" &&
      plannerPermission?.read === "allow" &&
      plannerPermission?.grep === "allow" &&
      plannerPermission?.glob === "allow" &&
      plannerPermission?.list === "allow" &&
      plannerPermission?.edit === "allow",
    "agent.planner.permission denies-all then allows read + search family (grep/glob/list) + edit/* (B7 tools row)",
  );
  check(
    typeof planner?.description === "string" &&
      (planner.description as string).includes("Plans multi-step work"),
    "agent.planner.description carried over from frontmatter",
  );
  check(agents["user-copilot-agent"] !== undefined, "agent['user-copilot-agent'] present (~/.copilot/agents, B7 user scope)");
>>>>>>> ce22907 (feat: B7 Copilot agents translator (.agent.md/.chatmode.md, ~/.copilot/agents) + tests + e2e asserts (#6))

  // --- S4: B6 copilot prompt file -> command.plan ---
  check(
    typeof commands["plan"]?.template === "string" && (commands["plan"].template as string).includes("$ARGUMENTS"),
    "command.plan present with $ARGUMENTS substituted for its single ${input:topic} (Copilot prompt file, B6)",
  );

  const skillPaths = ((cfg.skills ?? {}) as { paths?: unknown }).paths;
  check(
    Array.isArray(skillPaths) &&
      skillPaths.some((p) => typeof p === "string" && posix(p).endsWith(".github/skills")),
    "cfg.skills.paths contains the absolute path of .github/skills (Copilot skills, B8)",
  );

  // --- step 2: opencode agent list ---
  const agentList = run("opencode", ["agent", "list"], { cwd: fixtureDir, env });
  save("agent-list.txt", agentList);
  check(
    /^reviewer \(subagent\)\s*$/m.test(agentList.stdout),
    "agent list shows reviewer as a subagent (B1; anchored to line start so a foreign 'x-reviewer' agent cannot satisfy it)",
  );
  check(
    /^planner \(all\)\s*$/m.test(agentList.stdout),
    "agent list shows planner with mode 'all' (B7; anchored to line start like the reviewer assert above)",
  );

  // --- step 3: opencode debug agent reviewer ---
  const debugReviewer = run("opencode", ["debug", "agent", "reviewer"], { cwd: fixtureDir, env });
  save("debug-agent-reviewer.txt", debugReviewer);
  let reviewerTools: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(debugReviewer.stdout) as { tools?: Record<string, unknown> };
    reviewerTools = parsed.tools ?? {};
  } catch {
    // captured in the saved output either way; the checks below fail loud
  }
  check(reviewerTools["edit"] === false, "debug agent reviewer -> tools.edit === false (edit denied)");
  check(reviewerTools["read"] === true, "debug agent reviewer -> tools.read === true (read allowed)");
  check(reviewerTools["bash"] === true, "debug agent reviewer -> tools.bash === true (available for 'git *' only)");
  check(reviewerTools["write"] === false && reviewerTools["webfetch"] === false, "debug agent reviewer -> unlisted tools denied");

  // --- step 4: opencode debug skill ---
  const skillList = run("opencode", ["debug", "skill"], { cwd: fixtureDir, env });
  save("debug-skill.txt", skillList);
  check(skillList.stdout.includes("native-skill"), "debug skill lists native-skill (native control -- F9, no rosetta involved)");
  check(
    skillList.stdout.includes("copilot-skill"),
    "debug skill lists copilot-skill (injected via cfg.skills.paths, B8 -- S4 acceptance)",
  );

  // --- step 5: opencode mcp list ---
  const mcpList = run("opencode", ["mcp", "list"], { cwd: fixtureDir, env });
  save("mcp-list.txt", mcpList);
  check(mcpList.status === 0, "opencode mcp list exits 0");
  // N2 (PR #11 review): pin *echo* specifically. The previous
  // `/connected|✓|ok/i` check over the whole stdout passed whenever ANY
  // server connected -- it could not distinguish success from failure.
  const entries = parseMcpList(mcpList.stdout);
  const echoEntry = entries.find((entry) => entry.name === "echo");
  check(echoEntry !== undefined, "mcp list lists the echo server");
  check(
    echoEntry?.status === "connected",
    `echo is connected (got: ${echoEntry?.status ?? "absent"}) -- proves the command array spawns`,
  );
  check(!entries.some((entry) => entry.name === "vscode-unresolved"), "vscode-unresolved absent from mcp list");
  check(
    entries.find((entry) => entry.name === "missing-var-example")?.status === "connected",
    "missing-var-example listed (its unresolved ${ROSETTA_MISSING_VAR} stays literal; the echo script tolerates the extra arg)",
  );

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
  check(
    !("reviewer" in negAgents) && !("user-agent" in negAgents),
    "negative control (--pure): rosetta-translated Claude agents absent",
  );
  check(
    !("planner" in negAgents) && !("user-copilot-agent" in negAgents),
    "negative control (--pure): rosetta-translated Copilot agents absent",
  );
  const negCommands = (negCfg.command ?? {}) as Record<string, unknown>;
  check(
    !("component" in negCommands) && !("user-cmd" in negCommands),
    "negative control (--pure): rosetta-translated Claude commands absent",
  );
  check(
    !("plan" in negCommands),
    "negative control (--pure): command.plan (Copilot prompt translation) is NOT present",
  );
  const negSkillPaths = ((negCfg.skills ?? {}) as { paths?: unknown }).paths;
  check(
    !Array.isArray(negSkillPaths) ||
      !negSkillPaths.some((p) => typeof p === "string" && posix(p).endsWith(".github/skills")),
    "negative control (--pure): .github/skills is NOT in cfg.skills.paths",
  );
  const negMcp = (negCfg.mcp ?? {}) as Record<string, unknown>;
  check(!("echo" in negMcp), "negative control (--pure): mcp.echo NOT injected");

  log(`${failures === 0 ? "PASS" : "FAIL"} -- ${failures} failing check(s). Full output saved under test/e2e/out/.`);
  if (failures > 0) process.exit(1);
}

main();
