/**
 * Structured diagnostics collected while translating artifacts into
 * opencode config, flushed once (per `config` hook invocation) via
 * `client.app.log`. Never put a raw env/secret value in `reason`/`message`
 * -- file paths, key names, and canned reason codes only.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Public options knob; "off" additionally suppresses every level. */
export type LogThreshold = "off" | "warn" | "info" | "debug";

export interface Diagnostic {
  level: LogLevel;
  /** Which source produced this, e.g. "copilot.instructions". */
  source: string;
  /** Absolute or repo-relative path of the artifact this concerns, if any. */
  file?: string;
  /** Field within the artifact this concerns, if any (e.g. "tools"). */
  field?: string;
  /** Canned reason code or short human message. Never a secret value. */
  reason: string;
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const THRESHOLD_RANK: Record<Exclude<LogThreshold, "off">, number> = {
  debug: 0,
  info: 1,
  warn: 2,
};

/** Minimal shape of the SDK client we need -- avoids depending on the full SDK type in signatures. */
export interface LogClient {
  app: {
    log(opts: {
      body: { service: string; level: LogLevel; message: string; extra?: Record<string, unknown> };
    }): Promise<unknown>;
  };
}

export class Diagnostics {
  private readonly entries: Diagnostic[] = [];

  add(d: Diagnostic): void {
    this.entries.push(d);
  }

  all(): readonly Diagnostic[] {
    return this.entries;
  }

  /** One pass over the collected entries meeting `threshold`; call once, after `applyFragments`. */
  async flush(client: LogClient, threshold: LogThreshold, service = "opencode-rosetta"): Promise<void> {
    if (threshold === "off") return;
    const min = THRESHOLD_RANK[threshold];
    for (const entry of this.entries) {
      if (RANK[entry.level] < min) continue;
      const extra: Record<string, unknown> = {};
      if (entry.file !== undefined) extra.file = entry.file;
      if (entry.field !== undefined) extra.field = entry.field;
      await client.app.log({
        body: {
          service,
          level: entry.level,
          message: `[${entry.source}] ${entry.reason}`,
          extra: Object.keys(extra).length > 0 ? extra : undefined,
        },
      });
    }
  }
}
