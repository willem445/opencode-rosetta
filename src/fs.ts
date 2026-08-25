/**
 * Filesystem helpers used by every `sources/*` translator. `node:` builtins
 * only -- no `Bun.Glob`/`Bun.file` (F15: the host running this plugin is
 * not guaranteed to be Bun).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Read a text file; `undefined` if it does not exist. A non-ENOENT I/O error
 * (permission denied, locked file, path is a directory) does NOT throw:
 * it returns `undefined` and fires `onError` with a machine-stable reason of
 * the form `could-not-read (<CODE>)` so the caller can record a diagnostic
 * (#8 finding 2: a translator must degrade to a skip-with-reason, never leave
 * the config hook half-applied via an uncaught throw). With no `onError` the
 * error is swallowed -- callers that care pass the callback.
 */
export function readText(path: string, onError?: (reason: string) => void): string | undefined {
  let text: string;
  try {
    // existsSync first so the common "not there" case stays silent; the
    // try/catch also covers the TOCTOU window and any non-ENOENT open/read
    // failure (EACCES, EISDIR, EBUSY, ...).
    if (!existsSync(path)) return undefined;
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code =
      typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "UNKNOWN";
    if (code === "ENOENT") return undefined;
    onError?.(`could-not-read (${code})`);
    return undefined;
  }
  return text;
}

/**
 * Read + `JSON.parse` a file. `undefined` if it does not exist. Throws on
 * invalid JSON -- callers are per-source try/catch'd (see `sources/index.ts`)
 * and turn that into an `unparseable` diagnostic themselves, since only they
 * know the right `source`/`field` to attach.
 */
export function readJson(path: string): unknown | undefined {
  const text = readText(path);
  if (text === undefined) return undefined;
  return JSON.parse(text);
}

export function isDir(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

export function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** Backslashes -> forward slashes, for stable naming/matching on Windows. */
export function toPosix(path: string): string {
  return sep === "\\" ? path.split(sep).join("/") : path;
}

/**
 * Recursively list files under `dir` whose (posix) path ends with one of
 * `extensions` (e.g. `[".md"]`); absolute posix paths, sorted. `[]` if `dir`
 * does not exist. Symlinks are not followed (C6: never symlink into skill
 * discovery).
 */
export function listFiles(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const posix = toPosix(full);
        if (extensions.some((ext) => posix.endsWith(ext))) out.push(posix);
      }
    }
  };
  if (isDir(dir)) walk(dir);
  return out.sort();
}
