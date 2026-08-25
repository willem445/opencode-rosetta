import { describe, expect, test } from "bun:test";
import { isUnconditional, matchAny, splitApplyTo, toPosixSlashes } from "../src/glob.js";

describe("toPosixSlashes", () => {
  test("converts backslashes to forward slashes on every platform", () => {
    expect(toPosixSlashes("a\\b\\c.ts")).toBe("a/b/c.ts");
    expect(toPosixSlashes("a/b/c.ts")).toBe("a/b/c.ts");
  });
});

describe("splitApplyTo", () => {
  test("comma-separated list is split and trimmed", () => {
    expect(splitApplyTo("src/**/*.ts, docs/**/*.md")).toEqual(["src/**/*.ts", "docs/**/*.md"]);
  });

  test("empty segments are dropped", () => {
    expect(splitApplyTo(" a.ts ,, ,b.ts ")).toEqual(["a.ts", "b.ts"]);
  });
});

describe("matchAny (posix globs against possibly-backslash paths)", () => {
  test("THE Windows case: a backslash path matches a posix applyTo glob", () => {
    expect(matchAny("src\\lib\\a.ts", ["src/**/*.ts"])).toBe(true);
    expect(matchAny("C:\\repo\\src\\a.ts", ["**/*.ts"])).toBe(true);
  });

  test("**/*.ts matches top-level and nested .ts files only", () => {
    expect(matchAny("main.ts", ["**/*.ts"])).toBe(true);
    expect(matchAny("src/deep/a.ts", ["**/*.ts"])).toBe(true);
    expect(matchAny("README.md", ["**/*.ts"])).toBe(false);
  });

  test("non-matching pattern returns false for every pattern", () => {
    expect(matchAny("docs/guide.md", ["src/**/*.ts", "test/**/*.ts"])).toBe(false);
  });

  test("matching one of several patterns returns true", () => {
    expect(matchAny("docs/guide.md", ["src/**/*.ts", "docs/**/*.md"])).toBe(true);
  });

  test("dot-directories match with the dot option on", () => {
    expect(matchAny(".github/instructions/x.md", ["**/*.md"])).toBe(true);
  });
});

describe("isUnconditional (B5: applyTo \"**\" / \"*\" / \"**/*\" means always-on)", () => {
  test("matches-everything globs are unconditional", () => {
    expect(isUnconditional(["**"])).toBe(true);
    expect(isUnconditional(["*"])).toBe(true);
    expect(isUnconditional(["**/*"])).toBe(true);
  });

  test("a real glob is not unconditional", () => {
    expect(isUnconditional(["src/**/*.ts"])).toBe(false);
  });

  test("an everything-glob inside a comma list still reads as unconditional", () => {
    expect(isUnconditional(["src/**/*.ts", "**"])).toBe(true);
  });
});
