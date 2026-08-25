import { describe, expect, test } from "bun:test";
import { parseMcpList } from "./mcp-list.js";

/**
 * Faithful (ANSI-stripped) copy of real `opencode mcp list` output captured
 * from this harness at 1.18.x (see out/mcp-list.txt). One paragraph per
 * server: `<glyphs> <name> <status>` then indented detail lines.
 */
const SAMPLE = [
  "  MCP Servers",
  "?  ? orrerix connected",
  "      http://127.0.0.1:51162/mcp",
  "",
  "?  ? echo connected",
  "      node ./mcp-echo.mjs",
  "",
  "?  ? remote-example failed",
  "      SSE error: Was there a typo in the url or port?",
  "      https://example.invalid/mcp",
  "",
  "?  ? vscode-defaulted connected",
  "      node ./mcp-echo.mjs",
  "",
  "  6 server(s)",
].join("\n");

/** Same output but with the echo server entirely ABSENT -- every other server connects. */
const POLLUTED = [
  "  MCP Servers",
  "?  ? orrerix connected",
  "      http://127.0.0.1:51162/mcp",
  "",
  "?  ? remote-example failed",
  "      SSE error: Was there a typo in the url or port?",
  "",
  "?  ? vscode-defaulted connected",
  "      node ./mcp-echo.mjs",
  "",
  "  5 server(s)",
].join("\n");

describe("parseMcpList (N2: step-5 must pin *echo* specifically)", () => {
  test("extracts every server with its status from real output", () => {
    const entries = parseMcpList(SAMPLE);
    expect(entries.map((e) => `${e.name}=${e.status}`)).toEqual([
      "orrerix=connected",
      "echo=connected",
      "remote-example=failed",
      "vscode-defaulted=connected",
    ]);
  });

  test("the OLD whole-output regex launders the polluted case; the parsed check does not", () => {
    // This is the reviewer's finding demonstrated as executable fact: the
    // pre-fix assertion passes while echo is completely absent...
    expect(/connected|✓|ok/i.test(POLLUTED)).toBe(true);
    // ...whereas scoping to the echo entry makes the harness check fail:
    const echo = parseMcpList(POLLUTED).find((e) => e.name === "echo");
    const harnessPasses = echo !== undefined && echo.status === "connected";
    expect(harnessPasses).toBe(false);
  });

  test("'./mcp-echo.mjs' on another server's detail line never satisfies an echo check", () => {
    // vscode-defaulted's COMMAND LINE contains 'echo' -- the reason a naive
    // substring search cannot be trusted even within one block.
    const echo = parseMcpList(SAMPLE).find((e) => e.name === "echo");
    expect(echo?.status).toBe("connected");
    const defaultedOnly = parseMcpList(POLLUTED);
    expect(defaultedOnly.some((e) => e.name.includes("echo"))).toBe(false);
  });

  test("raw ANSI-decorated output parses identically", () => {
    const raw = "\x1b[90m?\x1b[39m  \x1b[34m?\x1b[39m  ? echo \x1b[90mconnected\x1b[39m\n      \x1b[90mnode ./mcp-echo.mjs\x1b[39m";
    expect(parseMcpList(raw)).toEqual([{ name: "echo", status: "connected" }]);
  });
});
