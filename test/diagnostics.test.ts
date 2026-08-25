import { describe, expect, test } from "bun:test";
import { Diagnostics } from "../src/diagnostics.js";

describe("Diagnostics.flush", () => {
  test("a warn diagnostic reaches the client as level 'warn' with its field, never a secret value", async () => {
    const posted: Array<{ body: { service: string; level: string; message: string; extra?: Record<string, unknown> } }> = [];
    const client = { app: { log: async (opts: (typeof posted)[number]) => void posted.push(opts) } };
    const diag = new Diagnostics();
    // The kind of warn copilotMcp produces for an unresolved ${input:id}:
    // server name + canned reason only -- never the would-be token value.
    diag.add({ level: "warn", source: "copilot.mcp", field: "mcp.vscode-unresolved", reason: "unresolved-input" });
    await diag.flush(client, "warn");
    expect(posted).toHaveLength(1);
    const body = posted[0]!.body;
    expect(body.level).toBe("warn");
    expect(body.message).toBe("[copilot.mcp] unresolved-input");
    expect(body.extra).toEqual({ field: "mcp.vscode-unresolved" });
  });

  test("threshold filters: debug entries are suppressed at the default 'warn' threshold", async () => {
    const posted: unknown[] = [];
    const client = { app: { log: async (opts: unknown) => void posted.push(opts) } };
    const diag = new Diagnostics();
    diag.add({ level: "debug", source: "claude.mcp", reason: "translated" });
    diag.add({ level: "warn", source: "claude.mcp", reason: "unsupported-type" });
    await diag.flush(client, "warn");
    expect(posted).toHaveLength(1);
  });

  test("'off' suppresses everything", async () => {
    const posted: unknown[] = [];
    const client = { app: { log: async (opts: unknown) => void posted.push(opts) } };
    const diag = new Diagnostics();
    diag.add({ level: "error", source: "x", reason: "y" });
    await diag.flush(client, "off");
    expect(posted).toHaveLength(0);
  });
});
