/**
 * Parser for `opencode mcp list` output (N2, PR #11 review): lets the e2e
 * harness assert that a SPECIFIC server is listed and connected, instead of
 * the old whole-output `/connected|✓|ok/i` regex that passed whenever ANY
 * server connected -- an assertion that could not distinguish success from
 * failure. Pure string handling; no opencode dependency, so it is unit
 * tested in `mcp-list.test.ts` against captured real output.
 */

/** Remove ANSI SGR escape sequences (`\x1b[...m`) from CLI output. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

export interface McpListEntry {
  name: string;
  status: string;
}

const STATUS = /\b(connected|failed|disabled|pending|connecting)\b/i;

/**
 * Extract `{name, status}` per server from `opencode mcp list` stdout.
 * A status line looks like `<glyphs> <name> <STATUS>`; detail lines
 * underneath (URLs, command lines -- which may themselves contain words
 * like "echo") belong to the entry above and are never mistaken for one.
 */
export function parseMcpList(stdout: string): McpListEntry[] {
  const entries: McpListEntry[] = [];
  for (const line of stripAnsi(stdout).split(/\r?\n/)) {
    const match = line.match(STATUS);
    if (!match || match.index === undefined) continue;
    const name = line
      .slice(0, match.index)
      .trim()
      .replace(/^[\W_]+/, "")
      .trim();
    if (name === "") continue;
    const status = match[1];
    entries.push({ name, status: (status ?? "").toLowerCase() });
  }
  return entries;
}
