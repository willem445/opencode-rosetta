import { describe, expect, test } from "bun:test";
import { expandString, rosettaInputEnvVar, type ExpandContext } from "../src/env.js";

function cx(overrides: Partial<ExpandContext> = {}): ExpandContext {
  return {
    worktree: "/repo/worktree",
    home: "/home/nobody",
    env: {},
    ...overrides,
  };
}

describe("expandString (B3/B9 variable expansion)", () => {
  test("${VAR} set -> expanded from env", () => {
    const out = expandString("node ${ECHO_BIN}", cx({ env: { ECHO_BIN: "/usr/bin/node" } }));
    expect(out.value).toBe("node /usr/bin/node");
    expect(out.unexpandedVars).toEqual([]);
    expect(out.unresolvedInputs).toEqual([]);
  });

  test("${VAR} unset -> left literal, variable NAME (never a value) recorded", () => {
    const out = expandString("${MISSING_TOKEN}/x", cx());
    expect(out.value).toBe("${MISSING_TOKEN}/x");
    expect(out.unexpandedVars).toEqual(["MISSING_TOKEN"]);
  });

  test("${VAR:-default} -> env value when set", () => {
    const out = expandString("${PORT:-8080}", cx({ env: { PORT: "3000" } }));
    expect(out.value).toBe("3000");
  });

  test("${VAR:-default} -> default when unset", () => {
    const out = expandString("${PORT:-8080}", cx());
    expect(out.value).toBe("8080");
    expect(out.unexpandedVars).toEqual([]);
  });

  test("${VAR:-default} -> default when set-but-empty (shell semantics)", () => {
    const out = expandString("${PORT:-8080}", cx({ env: { PORT: "" } }));
    expect(out.value).toBe("8080");
  });

  test("${env:VAR} -> expanded from env; missing -> literal + recorded", () => {
    const set = expandString("Bearer ${env:GH_TOKEN}", cx({ env: { GH_TOKEN: "sekret" } }));
    expect(set.value).toBe("Bearer sekret");
    const unset = expandString("Bearer ${env:GH_TOKEN}", cx());
    expect(unset.value).toBe("Bearer ${env:GH_TOKEN}");
    expect(unset.unexpandedVars).toEqual(["GH_TOKEN"]);
  });

  test("${workspaceFolder} -> ctx.worktree", () => {
    expect(expandString("${workspaceFolder}/bin", cx()).value).toBe("/repo/worktree/bin");
  });

  test("${userHome} -> ctx.home", () => {
    expect(expandString("${userHome}/.claude", cx()).value).toBe("/home/nobody/.claude");
  });

  test("${input:id} layer 1: plugin options.inputs wins", () => {
    const out = expandString(
      "${input:github-token}",
      cx({ inputs: { "github-token": "from-options" } }),
    );
    expect(out.value).toBe("from-options");
    expect(out.unresolvedInputs).toEqual([]);
  });

  test("${input:id} layer 1b: an options.inputs value may itself use {env:VAR}", () => {
    const out = expandString(
      "${input:github-token}",
      cx({ env: { GH_TOKEN: "env-value" }, inputs: { "github-token": "{env:GH_TOKEN}" } }),
    );
    expect(out.value).toBe("env-value");
  });

  test("${input:id} layer 2: ROSETTA_INPUT_<ID> env var (id upper-cased, non-alnum -> _)", () => {
    expect(rosettaInputEnvVar("github-token")).toBe("ROSETTA_INPUT_GITHUB_TOKEN");
    const out = expandString(
      "${input:github-token}",
      cx({ env: { ROSETTA_INPUT_GITHUB_TOKEN: "from-env" } }),
    );
    expect(out.value).toBe("from-env");
  });

  test("${input:id} layer 3: the mcp.json `inputs[].default` fallback", () => {
    const out = expandString(
      "${input:token}",
      cx({ inputDefaults: { token: "fallback-default" } }),
    );
    expect(out.value).toBe("fallback-default");
  });

  test("${input:id} unresolved everywhere -> left literal + id recorded", () => {
    const out = expandString("${input:nobody-knows}", cx());
    expect(out.value).toBe("${input:nobody-knows}");
    expect(out.unresolvedInputs).toEqual(["nobody-knows"]);
  });

  test("several expansions in one string, mixed forms", () => {
    const out = expandString(
      "${workspaceFolder}/run --home ${userHome} --token ${TOK:-none}",
      cx({ env: { TOK: "abc" } }),
    );
    expect(out.value).toBe("/repo/worktree/run --home /home/nobody --token abc");
  });

  test("a string with no references passes through untouched", () => {
    const out = expandString("plain command arg", cx());
    expect(out).toEqual({ value: "plain command arg", unexpandedVars: [], unresolvedInputs: [] });
  });

  test("malformed input never throws (N3): unmatched brace passes through", () => {
    expect(() => expandString("${", cx())).not.toThrow();
    expect(expandString("${", cx()).value).toBe("${");
    expect(() => expandString("cmd ${{", cx())).not.toThrow();
  });

  test("malformed input never throws (N3): a bare $ without braces is untouched, never expanded", () => {
    const out = expandString("echo $HOME", cx({ env: { HOME: "/should/not/appear" } }));
    expect(out.value).toBe("echo $HOME");
    expect(out.unexpandedVars).toEqual([]);
  });

  test("malformed input never throws (N3): nested ${A${B}} leaves the outer literal, expands only the innermost", () => {
    const unset = expandString("${A${B}}", cx());
    expect(unset.value).toBe("${A${B}}");
    const set = expandString("${A${B}}", cx({ env: { B: "bee" } }));
    expect(set.value).toBe("${Abee}");
  });
});
