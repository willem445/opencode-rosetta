import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { readText } from "../src/fs.js";

/**
 * Pins #8-finding-2: a non-ENOENT I/O error must NOT throw out of readText --
 * it returns undefined and fires the onError callback with a machine-stable
 * `could-not-read (<CODE>)` reason. The inducer below is real, not mocked:
 * a directory where the caller expects a file makes readFileSync fail with
 * EISDIR (POSIX) / EPERM-or-EISDIR (Windows) -- either way non-ENOENT.
 */
describe("readText non-ENOENT error handling", () => {
  const dir = mkdtempSync(join(tmpdir(), "rosetta-fs-"));

  test("missing file -> undefined, callback never fires", () => {
    let called = false;
    const text = readText(join(dir, "nope.md"), () => {
      called = true;
    });
    expect(text).toBeUndefined();
    expect(called).toBe(false);
  });

  test("existing file -> content", () => {
    const file = join(dir, "real.md");
    writeFileSync(file, "hello", "utf8");
    expect(readText(file)).toBe("hello");
  });

  test("directory passed as file -> undefined + onError('could-not-read (<non-ENOENT code>)')", () => {
    const asDir = join(dir, "actually-a-dir.md");
    mkdirSync(asDir);
    const reasons: string[] = [];
    let threw: unknown;
    try {
      const text = readText(asDir, (reason) => reasons.push(reason));
      expect(text).toBeUndefined();
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeUndefined();
    expect(reasons).toHaveLength(1);
    const reason = reasons[0] ?? "";
    expect(reason.startsWith("could-not-read (")).toBe(true);
    expect(reason.endsWith(")")).toBe(true);
    expect(reason.includes("ENOENT")).toBe(false);
  });

  test("without a callback the same error is swallowed (returns undefined, does not throw)", () => {
    const asDir = join(dir, "swallowed.md");
    mkdirSync(asDir);
    expect(() => readText(asDir)).not.toThrow();
    expect(readText(asDir)).toBeUndefined();
  });
});
