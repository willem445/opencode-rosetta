#!/usr/bin/env node
/**
 * Minimal MCP stdio echo server used by the e2e fixture (`.mcp.json` ->
 * `{"command": "node", "args": ["./mcp-echo.mjs"]}`). Proves that rosetta's
 * translated `command: [command, ...args]` array actually spawns and
 * connects: `opencode mcp list` must report this server as connected.
 *
 * Built on `@modelcontextprotocol/sdk`, a DEV-dependency only -- it is
 * needed to run this fixture, never by the plugin bundle (see the PR body).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "echo", version: "0.1.0" });

server.registerTool(
  "echo",
  {
    description: "Echoes back its input message; also reports the TOKEN env var's length, never its value.",
    inputSchema: undefined,
  },
  async ({ message }) => {
    const tokenLength = typeof process.env.TOKEN === "string" ? process.env.TOKEN.length : 0;
    return {
      content: [{ type: "text", text: `${message ?? "(no message)"} (token-length=${tokenLength})` }],
    };
  },
);

await server.connect(new StdioServerTransport());
