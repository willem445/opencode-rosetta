/**
 * Glob matching for Copilot `applyTo` values (B5) and the C1 read hook.
 *
 * picomatch, bundled (see the design note's dependency argument): `applyTo`
 * needs comma lists, `**`, and brace expansion; `Bun.Glob` is rejected (F15:
 * the host is not guaranteed to be Bun); a hand-rolled matcher was rejected
 * for exactly those first three reasons.
 *
 * Windows hazard: `path.relative()` yields backslashes on win32 while
 * `applyTo` globs are posix (`src`-tree style, forward slashes). Matching
 * therefore normalizes BOTH separators unconditionally -- not via
 * `fs.toPosix`, which converts only the native separator and would leave a
 * literal-backslash path unmatched on POSIX CI runners.
 */
import pm from "picomatch";

/** Backslashes -> forward slashes, unconditionally on every platform (matching only). */
export function toPosixSlashes(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Split an `applyTo` value ("a, b") into trimmed, non-empty patterns. */
export function splitApplyTo(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

const MATCHES_EVERYTHING = new Set(["**", "*", "**/*"]);

/**
 * B5: an `applyTo` that matches everything (doublestar, single star, or
 * doublestar-slash-star) means Copilot applies the file unconditionally ->
 * it belongs in `cfg.instructions`, not in the read hook.
 */
export function isUnconditional(patterns: readonly string[]): boolean {
  return patterns.some((p) => MATCHES_EVERYTHING.has(p));
}

/** True if `path` (either separator style) matches any of the posix globs. */
export function matchAny(path: string, patterns: readonly string[]): boolean {
  const posixPath = toPosixSlashes(path);
  return patterns.some((pattern) =>
    pm.isMatch(posixPath, toPosixSlashes(pattern), { dot: true }),
  );
}
