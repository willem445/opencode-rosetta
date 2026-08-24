/**
 * opencode-rosetta -- translates Claude Code and GitHub Copilot artifacts
 * into opencode config, in memory, via the plugin `config` hook (F1-F4; see
 * `docs/design/0001-config-hook-translation.md`): the hook receives the
 * *live* config object (F3, no clone) and is awaited in bootstrap before
 * any consumer materializes (F4), so mutating it here is enough -- no files
 * are written, `client.config.update` is never called.
 *
 * Exactly one default export, `{ id, server }` -- no named alias (F11: a
 * default object plus a named alias registers a plugin twice on some
 * loader versions).
 */
import { homedir } from "node:os";
import type { Config, Hooks, Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { applyFragments } from "./apply.js";
import { buildContext } from "./context.js";
import { parseOptions } from "./options.js";
import { runSources } from "./sources/index.js";

const server: Plugin = async (input: PluginInput, options?: PluginOptions): Promise<Hooks> => {
  return {
    config: async (cfg: Config): Promise<void> => {
      const opts = parseOptions(options, process.env);
      if (!opts.enabled) return;

      const ctx = buildContext({
        directory: input.directory,
        worktree: input.worktree,
        home: homedir(),
        env: process.env,
        options: opts,
      });

      const results = runSources(ctx);
      // `cfg` is typed against opencode's *published* SDK schema; fields
      // this plugin writes (e.g. `skills.paths`, F9) are read by opencode's
      // own internals but are not all present in that published type at
      // 1.18.21 -- verified against source (F5-F9), not the SDK's `.d.ts`.
      applyFragments(cfg as unknown as Record<string, unknown>, results, ctx.diag);

      await ctx.diag.flush(input.client, opts.log);
    },
  };
};

export default { id: "opencode-rosetta", server };
