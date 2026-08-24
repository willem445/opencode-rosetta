import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "bun:test";

/**
 * Proves `dist/index.js` is genuinely self-contained (`dependencies: {}`,
 * gray-matter bundled in -- F15/G3): build it into a *fresh* temp directory
 * that has no `node_modules` anywhere above it, then `import()` it from
 * there. If the build had left a bare `import "gray-matter"` (or anything
 * else non-`node:`) in, this import would fail to resolve.
 *
 * Runs its own build (via the Bun binary running this test) rather than
 * depending on `bun run build` having already produced `dist/` -- so
 * `bun test` alone proves self-containment, independent of step order.
 */
const repoRoot = join(import.meta.dir, "..");
const tmpDir = mkdtempSync(join(tmpdir(), "opencode-rosetta-dist-"));

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("dist self-containment", () => {
  test("bun build produces an index.js importable with no node_modules present", async () => {
    const build = Bun.spawnSync(
      [process.execPath, "build", "src/index.ts", "--outdir", tmpDir, "--target", "node", "--format", "esm"],
      { cwd: repoRoot },
    );
    expect(build.exitCode).toBe(0);

    const entry = join(tmpDir, "index.js");
    const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown };

    expect(Object.keys(mod)).toEqual(["default"]);
    const plugin = mod.default as { id?: unknown; server?: unknown };
    expect(plugin.id).toBe("opencode-rosetta");
    expect(typeof plugin.server).toBe("function");
  });
});
