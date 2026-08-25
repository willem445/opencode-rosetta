import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { claudeMcp } from "../../src/sources/claude/mcp.js";
import { toPosix } from "../../src/fs.js";
import { makeCtx } from "../helpers.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "claude", "mcp");

describe("claudeMcp (B3: .mcp.json + ~/.claude.json -> cfg.mcp)", () => {
  test("stdio (type absent), http/sse/streamable-http -> local/remote; ws and url-without-type skipped with warns", () => {
    const worktree = join(FIXTURES, "stdio-and-remote");
    const fragment = claudeMcp(makeCtx({ worktree }));
    const mcp = fragment.mcp ?? {};

    expect(mcp["echo"]).toEqual({
      type: "local",
      command: ["node", "srv.js", "--verbose"],
      environment: { FOO: "bar" },
      cwd: ".",
      timeout: 5000,
    });
    expect(mcp["remote-http"]).toEqual({
      type: "remote",
      url: "https://example.invalid/mcp",
      headers: { Authorization: "Bearer x" },
    });
    expect(mcp["legacy-sse"]).toEqual({ type: "remote", url: "https://example.invalid/sse" });
    expect(mcp["streamable-alias"]).toEqual({ type: "remote", url: "https://example.invalid/streamable", timeout: 10000 });

    // ws: dropped + warn; url without type: skipped + warn (Claude rejects it too); no command: warn.
    expect("ws-server" in mcp).toBe(false);
    expect("no-type-url" in mcp).toBe(false);
    expect("no-command" in mcp).toBe(false);
    const reasons = fragment.diagnostics.map((d) => d.reason);
    expect(reasons).toContain("unsupported-type");
    expect(reasons).toContain("url-without-type");
    expect(reasons).toContain("missing-command");
  });

  test("${VAR} / ${VAR:-default} / ${env:VAR} / ${workspaceFolder} / ${userHome} expansion; missing var left literal + warn naming only the NAME", () => {
    const worktree = join(FIXTURES, "env-expansion");
    const fragment = claudeMcp(
      makeCtx({
        worktree,
        env: { SET_VAR: "/opt/node", SECRET_VAR: "sekret-value", REMOTE_URL: "https://set.example/mcp", GH_TOKEN: "gh-sekret" },
      }),
    );
    const mcp = fragment.mcp ?? {};

    expect(mcp["expand-local"]).toMatchObject({
      type: "local",
      command: ["/opt/node", "--root", toPosix(worktree), "--home", "/home/nobody"],
      environment: { TOKEN: "sekret-value" },
    });
    expect(mcp["expand-defaults"]).toMatchObject({
      type: "local",
      command: ["node", "fallback-one"],
      environment: { EMPTY_DEFAULTED: "empty-fallback" },
    });
    expect(mcp["expand-remote"]).toEqual({
      type: "remote",
      url: "https://set.example/mcp",
      headers: { Authorization: "Bearer gh-sekret" },
    });
  });

  test("missing env var without default stays LITERAL in the emitted value and the warn carries the name, never the value", () => {
    const worktree = join(FIXTURES, "env-expansion");
    const fragment = claudeMcp(makeCtx({ worktree, env: {} }));
    const mcp = fragment.mcp ?? {};
    // expand-local: ${SET_VAR} unset -> literal; expand-remote falls back to its default URL but
    // its header uses ${env:GH_TOKEN} unset -> literal.
    expect((mcp["expand-local"] as Record<string, unknown>).command).toEqual([
      "${SET_VAR}",
      "--root",
      toPosix(worktree),
      "--home",
      "/home/nobody",
    ]);
    const unexpanded = fragment.diagnostics.filter((d) => d.reason === "unexpanded-env-var");
    expect(unexpanded.map((d) => d.field)).toContain("mcp.expand-local.command[0]");
    for (const d of fragment.diagnostics) {
      expect(JSON.stringify(d)).not.toContain("sekret-value");
      expect(JSON.stringify(d)).not.toContain("gh-sekret");
    }
  });

  test("names listed in .claude/settings*.json disabledMcpjsonServers are skipped with an info", () => {
    const worktree = join(FIXTURES, "disabled-servers");
    const fragment = claudeMcp(makeCtx({ worktree }));
    const mcp = fragment.mcp ?? {};
    expect("kept" in mcp).toBe(true);
    expect("off-one" in mcp).toBe(false);
    expect(fragment.diagnostics.some((d) => d.reason === "disabled-mcpjson-server" && d.level === "info")).toBe(true);
  });

  test("unparseable .mcp.json -> 'unparseable' warn, no entries from that file", () => {
    const worktree = join(FIXTURES, "unparseable");
    const fragment = claudeMcp(makeCtx({ worktree }));
    expect(fragment.mcp).toBeUndefined();
    expect(fragment.diagnostics.some((d) => d.reason === "unparseable")).toBe(true);
  });

  test("~/.claude.json: projects[<worktree>] (local scope) first, then top-level mcpServers (user scope); user toggle off drops both", () => {
    const home = mkdtempSync(join(tmpdir(), "rosetta-claude-json-"));
    const worktree = mkdtempSync(join(tmpdir(), "rosetta-claude-wt-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { "user-remote": { type: "sse", url: "https://user.example/sse" }, clash: { command: "from-user-scope" } },
        projects: { [toPosix(worktree)]: { mcpServers: { "local-proj": { command: "proj-node" }, clash: { command: "from-local-scope" } } } },
      }),
    );
    try {
      const withUser = claudeMcp(makeCtx({ worktree, home }));
      const mcp = withUser.mcp ?? {};
      expect(mcp["local-proj"]).toMatchObject({ type: "local", command: ["proj-node"] });
      expect(mcp["user-remote"]).toMatchObject({ type: "remote", url: "https://user.example/sse" });
      expect((mcp["clash"] as Record<string, unknown>).command).toEqual(["from-local-scope"]);
      expect(withUser.diagnostics.some((d) => d.reason === "duplicate")).toBe(true);

      const withoutUser = claudeMcp(makeCtx({ worktree, home, rawOptions: { claude: { user: false } } }));
      const mcp2 = withoutUser.mcp ?? {};
      expect("local-proj" in mcp2).toBe(false);
      expect("user-remote" in mcp2).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(worktree, { recursive: true, force: true });
    }
  });
});
