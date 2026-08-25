import { describe, expect, test } from "bun:test";
import { applyFragments } from "../src/apply.js";
import { Diagnostics } from "../src/diagnostics.js";
import type { SourceResult } from "../src/sources/index.js";
import type { Fragment } from "../src/sources/types.js";

function result(key: string, fragment: Partial<Fragment>): SourceResult {
  return { key, fragment: { diagnostics: [], ...fragment } };
}

describe("applyFragments", () => {
  test("a key already present in cfg is never touched", () => {
    const cfg: Record<string, unknown> = { agent: { "keep-me": { model: "anthropic/claude-opus-4-1" } } };
    const diag = new Diagnostics();
    applyFragments(
      cfg,
      [result("claude.agents", { agent: { "keep-me": { model: "should-not-win" }, reviewer: { description: "x", prompt: "y" } } })],
      diag,
    );
    expect((cfg.agent as Record<string, unknown>)["keep-me"]).toEqual({ model: "anthropic/claude-opus-4-1" });
    expect((cfg.agent as Record<string, unknown>).reviewer).toEqual({ description: "x", prompt: "y" });
    expect(diag.all().some((d) => d.reason === "exists-in-config" && d.field === "agent.keep-me")).toBe(true);
  });

  test("cfg.command and cfg.mcp follow the same never-overwrite rule", () => {
    const cfg: Record<string, unknown> = {
      command: { deploy: { template: "user's own template" } },
      mcp: { echo: { type: "local", command: ["node", "echo.js"] } },
    };
    const diag = new Diagnostics();
    applyFragments(
      cfg,
      [
        result("claude.commands", { command: { deploy: { template: "rosetta template" } } }),
        result("copilot.mcp", { mcp: { echo: { type: "remote", url: "https://example.com" } } }),
      ],
      diag,
    );
    expect((cfg.command as Record<string, unknown>).deploy).toEqual({ template: "user's own template" });
    expect((cfg.mcp as Record<string, unknown>).echo).toEqual({ type: "local", command: ["node", "echo.js"] });
  });

  test("instructions are appended and deduped, existing entries kept first", () => {
    const cfg: Record<string, unknown> = { instructions: ["/repo/AGENTS.md"] };
    const diag = new Diagnostics();
    applyFragments(
      cfg,
      [
        result("copilot.instructions", { instructions: ["/repo/.github/copilot-instructions.md", "/repo/AGENTS.md"] }),
        result("claude.mcp", { instructions: ["/repo/.github/copilot-instructions.md"] }),
      ],
      diag,
    );
    expect(cfg.instructions).toEqual(["/repo/AGENTS.md", "/repo/.github/copilot-instructions.md"]);
  });

  test("skills.paths is appended and deduped under an initially-absent cfg.skills", () => {
    const cfg: Record<string, unknown> = {};
    const diag = new Diagnostics();
    applyFragments(cfg, [result("copilot.skills", { skillPaths: ["/repo/.github/skills"] })], diag);
    expect(cfg.skills).toEqual({ paths: ["/repo/.github/skills"] });
  });

  test("two rosetta sources contributing the same new key: first wins, second is a 'duplicate' diagnostic", () => {
    const cfg: Record<string, unknown> = {};
    const diag = new Diagnostics();
    applyFragments(
      cfg,
      [
        result("claude.agents", { agent: { shared: { description: "from claude", prompt: "a" } } }),
        result("copilot.agents", { agent: { shared: { description: "from copilot", prompt: "b" } } }),
      ],
      diag,
    );
    expect((cfg.agent as Record<string, unknown>).shared).toEqual({ description: "from claude", prompt: "a" });
    expect(diag.all().some((d) => d.reason === "duplicate" && d.field === "agent.shared")).toBe(true);
  });

  test("an agent fragment that emits 'tools' instead of 'permission' is rejected (F5)", () => {
    const cfg: Record<string, unknown> = {};
    const diag = new Diagnostics();
    applyFragments(
      cfg,
      [result("claude.agents", { agent: { reviewer: { description: "x", prompt: "y", tools: { read: true } } } })],
      diag,
    );
    expect(cfg.agent).toEqual({});
    expect(diag.all().some((d) => d.reason === "emits-tools-not-permission")).toBe(true);
  });

  test("a command fragment missing 'template' is rejected", () => {
    const cfg: Record<string, unknown> = {};
    const diag = new Diagnostics();
    applyFragments(cfg, [result("copilot.prompts", { command: { plan: { description: "no template" } } })], diag);
    expect(cfg.command).toEqual({});
    expect(diag.all().some((d) => d.reason === "missing-template")).toBe(true);
  });

  test("an mcp fragment missing a valid 'type' is rejected", () => {
    const cfg: Record<string, unknown> = {};
    const diag = new Diagnostics();
    applyFragments(cfg, [result("claude.mcp", { mcp: { echo: { command: ["node", "echo.js"] } } })], diag);
    expect(cfg.mcp).toEqual({});
    expect(diag.all().some((d) => d.reason === "missing-type")).toBe(true);
  });

  test("an mcp fragment with type present-but-unrecognized ('sse') is rejected as 'invalid-type', NOT 'missing-type'", () => {
    const cfg: Record<string, unknown> = {};
    const diag = new Diagnostics();
    applyFragments(
      cfg,
      [result("claude.mcp", { mcp: { stale: { type: "sse", url: "https://example.invalid/sse" } } })],
      diag,
    );
    expect(cfg.mcp).toEqual({});
    expect(diag.all().some((d) => d.reason === "invalid-type" && d.field === "mcp.stale")).toBe(true);
    expect(diag.all().some((d) => d.reason === "missing-type")).toBe(false);
  });

  test("an mcp entry with no 'type' key at all is still reported as 'missing-type'", () => {
    const cfg: Record<string, unknown> = {};
    const diag = new Diagnostics();
    applyFragments(cfg, [result("copilot.mcp", { mcp: { bare: { url: "https://example.invalid/x" } } })], diag);
    expect(cfg.mcp).toEqual({});
    expect(diag.all().some((d) => d.reason === "missing-type" && d.field === "mcp.bare")).toBe(true);
  });

  test("applying twice against the same cfg is idempotent (deep-equal, no new diagnostics on the second pass)", () => {
    const cfg: Record<string, unknown> = {};
    const diag = new Diagnostics();
    const results: SourceResult[] = [
      result("claude.agents", { agent: { reviewer: { description: "x", prompt: "y" } } }),
      result("copilot.instructions", { instructions: ["/repo/.github/copilot-instructions.md"] }),
      result("copilot.skills", { skillPaths: ["/repo/.github/skills"] }),
    ];
    applyFragments(cfg, results, diag);
    const after1 = JSON.parse(JSON.stringify(cfg));
    applyFragments(cfg, results, diag);
    const after2 = JSON.parse(JSON.stringify(cfg));
    expect(after2).toEqual(after1);
  });

  test("disabled sources contribute nothing: an empty sourceResults array leaves cfg untouched", () => {
    const cfg: Record<string, unknown> = { model: "anthropic/claude-opus-4-1" };
    const diag = new Diagnostics();
    applyFragments(cfg, [], diag);
    expect(cfg).toEqual({ model: "anthropic/claude-opus-4-1" });
  });
});
