import { describe, expect, test } from "bun:test";
import { isFrontmatterError, parseFrontmatter } from "../src/frontmatter.js";

describe("parseFrontmatter", () => {
  test("no frontmatter delimiters -> empty data, content unchanged", () => {
    const result = parseFrontmatter("# just a heading\n\nbody text\n");
    expect(isFrontmatterError(result)).toBe(false);
    if (!isFrontmatterError(result)) {
      expect(result.data).toEqual({});
      expect(result.content).toContain("just a heading");
    }
  });

  test("clean frontmatter parses directly", () => {
    const result = parseFrontmatter('---\nname: reviewer\ndescription: reviews code\n---\nBody.\n');
    expect(isFrontmatterError(result)).toBe(false);
    if (!isFrontmatterError(result)) {
      expect(result.data).toEqual({ name: "reviewer", description: "reviews code" });
      expect(result.content.trim()).toBe("Body.");
    }
  });

  test("sanitize-fixable: unquoted value with an extra top-level colon", () => {
    const text = "---\ndescription: Use when: doing X\n---\nBody.\n";
    const result = parseFrontmatter(text);
    expect(isFrontmatterError(result)).toBe(false);
    if (!isFrontmatterError(result)) {
      expect(result.data.description).toBe("Use when: doing X");
    }
  });

  test("truly broken frontmatter still fails after sanitize", () => {
    const text = '---\ndescription: "unterminated quote\n---\nBody.\n';
    const result = parseFrontmatter(text);
    expect(isFrontmatterError(result)).toBe(true);
    if (isFrontmatterError(result)) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  test("CRLF line endings parse like LF", () => {
    const text = "---\r\nname: reviewer\r\ndescription: reviews code\r\n---\r\nBody.\r\n";
    const result = parseFrontmatter(text);
    expect(isFrontmatterError(result)).toBe(false);
    if (!isFrontmatterError(result)) {
      expect(result.data).toEqual({ name: "reviewer", description: "reviews code" });
    }
  });

  test("BOM at start of file does not break parsing", () => {
    const text = "﻿---\nname: reviewer\n---\nBody.\n";
    const result = parseFrontmatter(text);
    expect(isFrontmatterError(result)).toBe(false);
    if (!isFrontmatterError(result)) {
      expect(result.data).toEqual({ name: "reviewer" });
    }
  });

  test("CRLF + sanitize-fixable value together", () => {
    const text = "---\r\ndescription: Use when: doing X\r\n---\r\nBody.\r\n";
    const result = parseFrontmatter(text);
    expect(isFrontmatterError(result)).toBe(false);
    if (!isFrontmatterError(result)) {
      expect(result.data.description).toBe("Use when: doing X");
    }
  });

  test("already-quoted value is left alone", () => {
    const text = '---\ndescription: "Use when: doing X"\n---\nBody.\n';
    const result = parseFrontmatter(text);
    expect(isFrontmatterError(result)).toBe(false);
    if (!isFrontmatterError(result)) {
      expect(result.data.description).toBe("Use when: doing X");
    }
  });

  test("YAML list value is left alone (not mistaken for a colon value)", () => {
    const text = "---\nskills:\n  - one\n  - two\n---\nBody.\n";
    const result = parseFrontmatter(text);
    expect(isFrontmatterError(result)).toBe(false);
    if (!isFrontmatterError(result)) {
      expect(result.data.skills).toEqual(["one", "two"]);
    }
  });
});
