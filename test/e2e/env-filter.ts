/**
 * Ambient-environment filter for the e2e harness (N1 + round-3 finding,
 * PR #11 review): every `OPENCODE`-named variable in the surrounding shell
 * is stripped from spawned `opencode` children. Running `bun run e2e`
 * inside an opencode-managed session otherwise inherits e.g.
 * `OPENCODE_CONFIG_CONTENT` / `OPENCODE_DB` / `OPENCODE_PERMISSION`, which
 * override or contaminate the fixture config the harness means to test.
 *
 * This leak is load-bearing history: its absence caused the false
 * "plugin does not load on 1.18.22" investigation (#12). A bare
 * `OPENCODE` (no underscore) escapes a `/^OPENCODE_/` match, so the test
 * pins BOTH forms -- do not narrow this pattern.
 */

/** True for `OPENCODE` itself and every `OPENCODE_*` variable; false otherwise. */
export function isAmbientOpencodeVar(key: string): boolean {
  return /^OPENCODE(_|$)/.test(key);
}

/** Copy of `env` with every ambient opencode variable removed. */
export function stripAmbientOpencodeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isAmbientOpencodeVar(key)) continue;
    out[key] = value;
  }
  return out;
}
