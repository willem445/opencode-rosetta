import { describe, expect, test } from "bun:test";
import { isAmbientOpencodeVar, stripAmbientOpencodeEnv } from "./env-filter.js";

describe("ambient OPENCODE env filter (N1; leak class behind issue #12)", () => {
  test("strips every OPENCODE_* prefixed variable", () => {
    for (const key of ["OPENCODE_CONFIG_CONTENT", "OPENCODE_DB", "OPENCODE_DISABLE_AUTOUPDATE", "OPENCODE_PERMISSION"]) {
      expect(isAmbientOpencodeVar(key)).toBe(true);
    }
  });

  test("strips the bare name OPENCODE (no underscore) -- the case a /^OPENCODE_/ match lets escape", () => {
    expect(isAmbientOpencodeVar("OPENCODE")).toBe(true);
  });

  test("keeps variables that merely CONTAIN opencode or start with a longer name", () => {
    expect(isAmbientOpencodeVar("OPENCODEx")).toBe(false);
    expect(isAmbientOpencodeVar("MY_OPENCODE_VAR")).toBe(false);
    expect(isAmbientOpencodeVar("OPENCODE_EXTRA_SUFFIX")).toBe(true); // still prefixed form
    expect(isAmbientOpencodeVar("ROSETTA_INPUT_GITHUB_TOKEN")).toBe(false);
    expect(isAmbientOpencodeVar("HOME")).toBe(false);
  });

  test("stripAmbientOpencodeEnv removes only those keys and keeps everything else", () => {
    const out = stripAmbientOpencodeEnv({
      OPENCODE: "bare",
      OPENCODE_CONFIG_CONTENT: '{"agent":{}}',
      HOME: "/fixture/home",
      ROSETTA_INPUT_VIA_ROSETTA_INPUT: "from-rosetta-input-env",
      PATH: "C:\\bin",
    });
    expect(Object.keys(out).sort()).toEqual(["HOME", "PATH", "ROSETTA_INPUT_VIA_ROSETTA_INPUT"]);
  });
});
