import { describe, expect, test } from "bun:test";
import { parseOptions } from "../src/options.js";

const noEnv: Record<string, string | undefined> = {};

describe("parseOptions", () => {
  test("no options (bare string plugin spec) -> all-enabled defaults", () => {
    const opts = parseOptions(undefined, noEnv);
    expect(opts.enabled).toBe(true);
    expect(opts.claude).toEqual({ agents: true, commands: true, mcp: true, user: true });
    expect(opts.copilot).toEqual({
      instructions: true,
      prompts: true,
      agents: true,
      skills: true,
      mcp: true,
      user: true,
      applyTo: "inject",
    });
    expect(opts.models).toEqual({});
    expect(opts.inputs).toEqual({});
    expect(opts.log).toBe("warn");
  });

  test("claude: false disables every claude sub-toggle", () => {
    const opts = parseOptions({ claude: false }, noEnv);
    expect(opts.claude).toEqual({ agents: false, commands: false, mcp: false, user: false });
  });

  test("claude: { agents: false } only turns off agents, other sub-toggles keep their default", () => {
    const opts = parseOptions({ claude: { agents: false } }, noEnv);
    expect(opts.claude).toEqual({ agents: false, commands: true, mcp: true, user: true });
  });

  test("copilot: false disables every copilot sub-toggle, applyTo keeps its default", () => {
    const opts = parseOptions({ copilot: false }, noEnv);
    expect(opts.copilot).toEqual({
      instructions: false,
      prompts: false,
      agents: false,
      skills: false,
      mcp: false,
      user: false,
      applyTo: "inject",
    });
  });

  test("copilot: { applyTo: 'always' } is accepted; an invalid value falls back to the default", () => {
    expect(parseOptions({ copilot: { applyTo: "always" } }, noEnv).copilot.applyTo).toBe("always");
    expect(parseOptions({ copilot: { applyTo: "bogus" } }, noEnv).copilot.applyTo).toBe("inject");
  });

  test("models/inputs pass through string values, drop non-string values", () => {
    const opts = parseOptions(
      { models: { sonnet: "anthropic/claude-sonnet-4-5", bad: 42 }, inputs: { "github-token": "{env:GITHUB_TOKEN}" } },
      noEnv,
    );
    expect(opts.models).toEqual({ sonnet: "anthropic/claude-sonnet-4-5" });
    expect(opts.inputs).toEqual({ "github-token": "{env:GITHUB_TOKEN}" });
  });

  test("log accepts off/warn/info/debug, anything else falls back to warn", () => {
    expect(parseOptions({ log: "debug" }, noEnv).log).toBe("debug");
    expect(parseOptions({ log: "off" }, noEnv).log).toBe("off");
    expect(parseOptions({ log: "loud" }, noEnv).log).toBe("warn");
  });

  test("OPENCODE_ROSETTA=off disables the plugin regardless of options", () => {
    const opts = parseOptions({ claude: true, copilot: true }, { OPENCODE_ROSETTA: "off" });
    expect(opts.enabled).toBe(false);
  });

  test("a non-object raw options value (e.g. from a malformed config) falls back to defaults", () => {
    const opts = parseOptions("not-an-object", noEnv);
    expect(opts.claude.agents).toBe(true);
  });
});
