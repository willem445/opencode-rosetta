/**
 * Frontmatter parsing shared by every markdown-artifact translator. Uses
 * `gray-matter` -- the same parser opencode ships (F10) -- with a
 * `sanitize()` retry on a failed parse: an unquoted scalar containing a
 * second top-level `: ` (e.g. `description: Use when: doing X`) is re-quoted
 * before retrying ("other coding agents ... allow invalid yaml in their
 * frontmatter", F10). opencode's own `sanitize()` is internal to its
 * binary-only npm distribution (no source access) -- this is a from-scratch
 * reimplementation of the documented behaviour, pinned by
 * `test/frontmatter.test.ts`, not a byte-identical copy.
 */
import matter from "gray-matter";

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  content: string;
}

export interface FrontmatterError {
  error: string;
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
const BOM = "﻿";

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

function splitFrontmatter(text: string): { body: string; rest: string } | undefined {
  const match = text.match(FRONTMATTER_RE);
  if (!match) return undefined;
  return { body: match[1] ?? "", rest: text.slice(match[0].length) };
}

/**
 * Re-quote a top-level `key: value` line whose value is unquoted, is not a
 * flow/block scalar (`"`, `'`, `[`, `{`, `|`, `>`), and contains a second
 * `: ` (or a trailing `:`) that would otherwise make YAML see an ambiguous
 * nested mapping.
 */
function sanitizeLine(line: string): string {
  const m = line.match(/^([A-Za-z0-9_-]+):[ \t]+(.*)$/);
  if (!m) return line;
  const key = m[1] as string;
  const value = m[2] as string;
  if (value === "") return line;
  const first = value[0];
  if (first === '"' || first === "'" || first === "[" || first === "{" || first === "|" || first === ">") {
    return line;
  }
  if (!value.includes(": ") && !value.endsWith(":")) return line;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${key}: "${escaped}"`;
}

function sanitize(text: string): string | undefined {
  const split = splitFrontmatter(text);
  if (!split) return undefined;
  const lines = split.body.split(/\r?\n/).map(sanitizeLine);
  return `---\n${lines.join("\n")}\n---\n${split.rest}`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseOnce(text: string): ParsedFrontmatter {
  // gray-matter caches by exact content string when called with no
  // `options`, *before* the YAML engine runs -- so a throw leaves a
  // poisoned "no frontmatter" placeholder cached under that key, and our
  // sanitize() retry can produce a string byte-identical to the one that
  // just failed. `{}` opts out of the cache (see the design note).
  const parsed = matter(text, {});
  const data = (parsed.data ?? {}) as Record<string, unknown>;
  return { data, content: parsed.content };
}

export function parseFrontmatter(text: string): ParsedFrontmatter | FrontmatterError {
  const clean = stripBom(text);
  try {
    return parseOnce(clean);
  } catch (err) {
    const sanitized = sanitize(clean);
    if (sanitized === undefined) return { error: describeError(err) };
    try {
      return parseOnce(sanitized);
    } catch (err2) {
      return { error: describeError(err2) };
    }
  }
}

export function isFrontmatterError(v: ParsedFrontmatter | FrontmatterError): v is FrontmatterError {
  return "error" in v;
}
