import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { copilotMcp } from "../../src/sources/copilot/mcp.js";
import { toPosix } from "../../src/fs.js";
import { makeCtx } from "../helpers.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "copilot", "mcp");
const WORKTREE = join(FIXTURES, "servers");

describe("copilotMcp (B9: .vscode/mcp.json -> cfg.mcp)", () => {
  test("stdio -> local (env/cwd kept); http/sse -> remote; envFile/dev/sandboxEnabled/oauth dropped with info", () => {
    const fragment = copilotMcp(
      makeCtx({ worktree: WORKTREE, env: { SERVER_BIN: "/opt/srv", GH_TOKEN: "gh-sekret" }, rawOptions: { inputs: { "github-token": "{env:GH_TOKEN}" } } }),
    );
    const mcp = fragment.mcp ?? {};
    expect(mcp["stdio-server"]).toMatchObject({
      type: "local",
      command: ["/opt/srv", "--folder", toPosix(WORKTREE), "--home", "/home/nobody"],
      environment: { TOKEN: "gh-sekret" },
      cwd: ".",
    });
    expect(mcp["remote-http"]).toEqual({
      type: "remote",
      url: "https://example.invalid/mcp",
      headers: { Authorization: "Bearer gh-sekret" },
    });
    expect(mcp["legacy-sse"]).toEqual({ type: "remote", url: "https://example.invalid/sse" });

    const infos = fragment.diagnostics.filter((d) => d.level === "info");
    const dropped = infos.filter((d) => d.reason === "unsupported-field-dropped").map((d) => d.field);
    expect(dropped).toContain("mcp.stdio-server.envFile");
    expect(dropped).toContain("mcp.stdio-server.dev");
    expect(dropped).toContain("mcp.remote-http.sandboxEnabled");
    expect(dropped).toContain("mcp.legacy-sse.oauth");
  });

  test("${input:id} resolved through plugin options.inputs ({env:VAR} form), ROSETTA_INPUT_<ID>, then inputs[].default; unresolved server skipped + warn", () => {
    // layer 1: options.inputs via {env:VAR}
    const viaOptions = copilotMcp(
      makeCtx({ worktree: WORKTREE, env: { GH_TOKEN: "gh-sekret" }, rawOptions: { inputs: { "github-token": "{env:GH_TOKEN}" } } }),
    );
    expect(((viaOptions.mcp ?? {})["stdio-server"] as Record<string, unknown>).environment).toEqual({ TOKEN: "gh-sekret" });

    // layer 2: ROSETTA_INPUT_GITHUB_TOKEN
    const viaEnv = copilotMcp(makeCtx({ worktree: WORKTREE, env: { ROSETTA_INPUT_GITHUB_TOKEN: "from-env-var" } }));
    expect(((viaEnv.mcp ?? {})["stdio-server"] as Record<string, unknown>).environment).toEqual({ TOKEN: "from-env-var" });

    // layer 3: inputs[].default
    const viaDefault = copilotMcp(makeCtx({ worktree: WORKTREE, env: {} }));
    expect(((viaDefault.mcp ?? {})["defaulted-input"] as Record<string, unknown>).environment).toEqual({
      TOKEN: "fallback-default-value",
    });
    // ...and with NO resolution anywhere, stdio-server (github-token) is skipped + warn; defaulted one still lands.
    const unresolved = copilotMcp(makeCtx({ worktree: WORKTREE, env: {} }));
    const mcp = unresolved.mcp ?? {};
    expect("stdio-server" in mcp).toBe(false);
    expect("defaulted-input" in mcp).toBe(true);
    expect(unresolved.diagnostics.some((d) => d.reason === "unresolved-input" && d.field === "mcp.stdio-server")).toBe(true);
  });

  test("unsupported type and missing command are skipped with warns; diagnostics never carry env values", () => {
    const fragment = copilotMcp(
      makeCtx({ worktree: WORKTREE, env: { SERVER_BIN: "x", GH_TOKEN: "sekret-value" } }),
    );
    const mcp = fragment.mcp ?? {};
    expect("weird-type" in mcp).toBe(false);
    expect("no-command" in mcp).toBe(false);
    expect(fragment.diagnostics.map((d) => d.reason)).toContain("unsupported-type");
    expect(fragment.diagnostics.map((d) => d.reason)).toContain("missing-command");
    for (const d of fragment.diagnostics) {
      expect(JSON.stringify(d)).not.toContain("sekret-value");
    }
  });

  test("no .vscode/mcp.json -> empty fragment, no diagnostics", () => {
    const absent = copilotMcp(makeCtx({ worktree: join(FIXTURES, "does-not-exist") }));
    expect(absent.mcp).toBeUndefined();
    expect(absent.diagnostics).toEqual([]);
  });
});
