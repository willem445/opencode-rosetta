# 0001 — Translate via the `config` hook, in memory, never on disk

Status: accepted. Owner: S1 (`feat/scaffold-plugin-skeleton`, issue #2, part of #1).

## Context

opencode-rosetta lets a team that maintains Claude Code and/or GitHub Copilot artifacts
(subagents, commands/prompts, MCP servers, instructions, skills) get them recognized by
opencode without duplicating those files into opencode's own conventions. The mechanism has
to hold for every artifact type across five slices (S1-S5), so it is fixed here, once, rather
than re-decided per slice.

## Decision: one `config` hook, mutating the live config object in place

opencode's plugin `Hooks` type exposes `config?: (input: Config) => Promise<void>`. Verified
against the installed `opencode-ai@1.18.21` binary and `@opencode-ai/plugin@1.18.21`'s
published types:

- **F2** — the hook fires once per plugin, in config order, after every plugin's `server()`
  has run: `packages/opencode` calls `const cfg = yield* config.get(); ...; hook.config?.(cfg)`.
  A throwing hook is caught, logged, and ignored — it does not abort startup.
- **F3** — `config.get()` returns the *live* state object (`InstanceState.use(state, s =>
  s.config)`), not a clone. Mutating the object the hook receives is mutating the one every
  later `config.get()` call sees. There is nothing to "commit" or "flush" — the mutation
  itself is the whole effect.
- **F4** — bootstrap calls `config.get()` and then `plugin.init()` — explicitly commented
  "Plugin can mutate config so it has to be initialized before anything else" — *before*
  lsp/share/format/vcs/snapshot/project initialize. Concretely, this means the hook is
  guaranteed to run, and to finish, before `Agent.state`, `Command.discover`, `MCP`'s server
  list, `Instruction.systemPaths()`, and `discoverSkills` first read `cfg` (verified against
  each consumer directly: `agent/agent.ts`, `command/index.ts`, `mcp/index.ts`,
  `session/instruction.ts`, `skill/index.ts` — F5-F9). No second hook is needed to catch a
  consumer that already materialized.

`index.ts` therefore does exactly this, once, per invocation of the hook:

```
config: async (cfg) => {
  if (!options.enabled) return;               // OPENCODE_ROSETTA=off
  const ctx = buildContext(...);
  const results = runSources(ctx);             // sources/index.ts — pure functions of ctx
  applyFragments(cfg, results, ctx.diag);       // apply.ts — mutates cfg in place
  await ctx.diag.flush(client, options.log);    // client.app.log, once, after apply
}
```

### Rejected alternatives

- **Generating files under `.opencode/**`.** Writes into the user's repo (needs `.gitignore`
  entries, survives accidental commits, races opencode's own native loaders that scan those
  same directories, and re-implements opencode's markdown/frontmatter parsing a second time
  just to produce output it will immediately re-parse). Every failure mode below the `config`
  hook line is strictly worse than "the hook throws and rosetta contributes nothing this run."
- **`client.config.update`.** Confirmed by reading `Config.update` (and by the one piece of
  prior art that uses it, `opencode-claude-commands`, **F17**): it persists to
  `<dir>/config.json` on disk. That is a second, silent config-writing mechanism outside the
  user's own files — worse than generating files, since it is not even visible in the repo.
  Never called.
- **`tool`/`experimental.*` hooks.** These can rewrite a tool call's arguments/output or a
  chat message, but cannot register an agent, a command, or an MCP server — the actual
  surface this plugin translates onto. Not viable as the primary mechanism (one of them,
  `tool.execute.after`, is used for a narrow secondary purpose — see below).

### C1 (S4): `tool.execute.after` for Copilot path-scoped instructions

Copilot's `applyTo`-scoped instructions files (`.github/instructions/**/*.instructions.md`
with a glob narrower than `**`) are not a config-time concept in opencode — nothing reads
"instructions scoped to files matching X" from `cfg`. The closest opencode equivalent is what
it already does for nested `AGENTS.md` on a file read. S4 mirrors that: a `tool.execute.after`
hook on `tool === "read"` matches the read path against the glob (picomatch, F16) and appends
the instructions text to that tool call's output, once per `(sessionID, file)`. This is a
narrow, additive hook — it never mutates `cfg` and never runs before the `config` hook.

Implementation notes (all verified against `opencode-ai@1.18.21`, not assumed):

- **The read tool's argument is `filePath`.** `packages/opencode/src/tool/read.ts` at tag
  `v1.18.21` declares `Parameters = Schema.Struct({ filePath: ... })`; anything else
  (`path`, `file`) would silently never match.
- **Output shape mirrors opencode's own nested-`AGENTS.md` behaviour.** `tool/read.ts`
  appends `<system-reminder>` blocks containing resolved instruction content; this hook
  appends one block per matching file: `Instructions from: <abs path> (applyTo: <original
  glob>)` followed by the body (frontmatter stripped — it is config, not prose). Multiple
  matches join with a blank line, registry order kept.
- **Once per `(sessionID, read-path)`, with a hard bound.** A `Set` keyed by session +
  worktree-relative posix path gates appends, so re-reading a file in one session never
  duplicates an injection while two sessions stay independent. The Set is FIFO-bounded
  (oldest key evicted at 4096 entries), so memory stays O(cap) for the plugin's lifetime
  even if a long-lived process reads unbounded distinct matched files. `Hooks.dispose`
  clears it entirely — opencode calls `dispose` when the plugin instance is torn down, so
  the memory cannot leak across plugin lifecycles.
- **Path handling mirrors `tool/read.ts` end to end.** An absolute `filePath` is used as-is;
  a relative one is resolved against the instance *directory*
  (`path.resolve(instance.directory, filepath)` in `tool/read.ts`), not the worktree — the
  two differ when a session is launched from a subdirectory. The result is made
  worktree-relative and posix-normalized before matching. Only file reads inject: the read
  tool also lists directories, and Copilot `applyTo` targets files, so a matching directory
  path is skipped.
- **Windows paths.** `applyTo` globs are authored posix-style but `args.filePath` and
  `path.relative()` carry backslashes on win32. Matching normalizes both separators
  unconditionally (`glob.toPosixSlashes`) rather than going through `fs.toPosix`, which only
  converts the *native* separator and would leave a backslash path unmatched on POSIX CI
  runners. Pinned by a cross-platform unit test that feeds a literal-backslash path through
  the matcher, plus a hook-level test using native `join` asserted on both platforms (real
  backslashes on win32, the posix flow elsewhere).
- **State flows through a holder, not a constructor argument.** opencode calls `server()`
  once and may fire either hook first; the config pass fills in the instruction list and
  worktree after translation, and the read hook reads through that indirection. When the
  mode is not `"inject"`, or nothing is path-scoped, or the plugin is disabled
  (`OPENCODE_ROSETTA=off`), the holder stays empty and the hook is a no-op — it is still
  registered unconditionally because registration happens at `server()` time, before the
  options-driven decision can be made.
- **Mode selection lives in the source, not the hook.** `copilot/instructions.ts` decides
  per file whether `copilot.applyTo: "always"` promotes it into `cfg.instructions` or
  `"ignore"` drops it with an info diagnostic; the hook only ever sees files meant for
  injection. The hook therefore stays a pure consumer of `PathScopedInstruction`s —
  the shape S1 declared in `sources/types.ts` for exactly this purpose.

## Precedence

Rule, in order, held by every slice:

1. **A key already present in `cfg` before this plugin's `config` hook mutates it is never
   touched.** This covers the user's own `opencode.json`/`.opencode/**`, remote/managed
   config, and any earlier plugin in `plugin:` order. `instructions` and `skills.paths` are
   the two exceptions — arrays, not single-key maps, so they are *appended* to instead
   (`apply.ts`'s `appendDeduped`); every consumer that reads them already dedupes (F8/F9), so
   appending is safe even against an entry the user already listed.

   This rule is also the entire answer to "detect what opencode already loads natively and
   skip it" (opencode#35341's underlying concern, part 1/8 prior-art survey): rosetta never
   asks opencode what it loaded — it only ever *adds* a key that is not already there. If a
   future opencode version starts natively reading `.claude/agents`, those agent names would
   already be in `cfg.agent` (populated by opencode's own native loader) before this plugin's
   `config` hook runs (plugin hooks fire after a project's native config is loaded), so this
   plugin's Claude-agent source silently stops contributing anything for that project — no
   version check, no feature flag, no code change required on either side.

2. **Among rosetta's own sources, registry order wins** (`src/sources/index.ts`): Claude
   sources before Copilot sources, and — within one source module — its own project root(s)
   searched nearest-to-`directory` first, then (if the module's `user` toggle is on) the
   user-scope root. This is this plugin's concrete reading of "project Claude → project
   Copilot → user Claude → user Copilot": it is **source-module-grained**, not a strict global
   pass (all project entries of *either* tool before *any* user entry). A collision between,
   say, a project-Copilot agent and a user-Claude agent resolves by which module's `Fragment`
   reached `apply.ts` first in registry order, not by a separate project/user pass across
   modules. Making the stricter global version work would require every source to split its
   own project and user entries into two separately-orderable `Fragment`s instead of one — a
   real design option, but one with no observable difference until S2+ ship sources that can
   actually collide on a name; if a later slice hits a case where the source-module-grained
   reading gives the wrong answer, split it then, in the slice that has the concrete
   collision to test against.

3. **Every skip is a diagnostic**, never a silent drop: `exists-in-config` (collided with
   pre-existing `cfg`) or `duplicate` (collided with an earlier rosetta source this same run).
   `apply.ts` also runs a small structural validator before writing any `agent`/`command`/`mcp`
   entry (see "emit `permission`, never `tools`" below) — a validation failure is its own
   diagnostic reason (`invalid-shape`, `missing-template`, `missing-type`,
   `emits-tools-not-permission`).

## Options contract

```jsonc
"plugin": [["opencode-rosetta", {
  "claude":  true,   // or { "agents": true, "commands": true, "mcp": true, "user": true }
  "copilot": true,   // or { "instructions": true, "prompts": true, "agents": true, "skills": true, "mcp": true, "user": true, "applyTo": "inject" }
  "models":  { "sonnet": "anthropic/claude-sonnet-4-5" },
  "inputs":  { "github-token": "{env:GITHUB_TOKEN}" },
  "log":     "warn"   // off | warn | info | debug
}]]
```

A bare `"opencode-rosetta"` string (no tuple) means "every default" — opencode passes
`options: undefined` to `server()` in that case (F11), and `parseOptions(undefined, env)`
returns the same defaults as `{}`. `claude`/`copilot` accept either a boolean (on/off for the
whole tool) or a per-artifact-type object; a boolean and an omitted sub-key both resolve to
that sub-key's default (`true`, except `applyTo` which defaults to `"inject"`). `models` and
`inputs` are plain string maps; non-string values are dropped rather than rejected outright,
since a hook throwing on a typo in someone else's config is a worse failure mode than ignoring
that one bad entry (a `warn` diagnostic path for this is a natural follow-up once a slice
actually consumes `models`/`inputs`).

Kill switch: `OPENCODE_ROSETTA=off` in the process environment disables the plugin regardless
of `options` — `index.ts` returns from the `config` hook before running any source.

## "Emit `permission`, never `tools`" (F5)

`Agent.state` reads `cfg.agent[name].permission` directly, but the *conversion* from a Claude
`tools:`/Copilot `tools:` allowlist into opencode's `permission` ruleset happens only inside
`packages/core/src/v1/config/agent.ts`'s `normalize()` — the schema decoder that runs over
config loaded from **files** (`.opencode/agent/*.md`, `opencode.json`). A hook-injected
`cfg.agent[name]` object bypasses that decoder entirely: `normalize()` never sees it, so a
translator that wrote `tools: {...}` (matching what a human would type in an opencode agent
file) would silently have that key ignored by `Agent.state`, producing an agent with **no**
tool restriction at all — the opposite of what an allowlist-only agent's author intended, and
a defect that would not surface as an error anywhere.

Every source that emits an agent (Claude subagents B1, Copilot agents B7) therefore does the
tools→permission conversion itself and writes `permission` directly. `apply.ts` enforces this
as a hard rule, not just a convention: an agent fragment whose value object contains a `tools`
key is rejected before it is ever written to `cfg`, with an `emits-tools-not-permission`
diagnostic — a translator bug here fails loud (a `warn` in the log, the key simply not
applied) instead of shipping a silently-over-permissive agent.

## Two things learned by verifying the plan's facts against the running binary (F1-F17 held; two implementation-detail notes)

1. **`cfg.skills` is not part of `@opencode-ai/plugin@1.18.21`'s published `Config` type.**
   `Instruction`/`Skill` consumer behavior for `skills.paths` (F9) was verified against
   `opencode debug config`'s actual JSON output and against the `customize-opencode` built-in
   skill's own schema documentation (`opencode debug skill`, e2e step 4 output,
   `test/e2e/out/debug-skill.txt`), both of which show `skills: { paths: [...], urls: [...] }`
   as real, live config — it is simply undeclared in the OpenAPI-generated SDK types this
   plugin's dev-only `@opencode-ai/plugin` dependency ships. `apply.ts`/`index.ts` therefore
   treat the whole config object as `Record<string, unknown>` for writes (`cfg as unknown as
   Record<string, unknown>` at the one cast site in `index.ts`) rather than relying on the
   published `Config` type surface for anything this plugin writes.
2. **`gray-matter`'s cross-call cache can poison the sanitize-and-retry path.** `gray-matter`
   caches its parsed result keyed by the *exact input string*, written **before** the YAML
   engine runs and only when `matter()` is called with no `options` argument — so a call that
   throws still leaves a "no frontmatter, `data: {}`" placeholder cached under that content
   key. `frontmatter.ts`'s sanitize-and-retry (F10) can legitimately produce a string
   byte-identical to the one that just failed (when no line needed re-quoting) — retrying with
   that identical string would silently read back the poisoned placeholder instead of
   re-throwing the real parse error. Fixed by always calling `matter(text, {})` (any truthy
   `options` argument opts a call out of the cache per `gray-matter`'s own source comment);
   `test/frontmatter.test.ts`'s "truly broken" case pins this.

## Diagnostics

`{level, source, file?, field?, reason}`, collected on a per-run `Diagnostics` instance
(`ctx.diag`) and flushed once, after `applyFragments`, via `client.app.log({service:
"opencode-rosetta", ...})` (F13). Never a raw env/secret value — `reason` is always a canned
code or a short message about *shape*, never content. No toasts: the TUI is not up during
bootstrap (F4 runs before `project` initializes). `off` suppresses every level; `warn` (the
default) surfaces skips and structural rejections; `info` adds `exists-in-config` and
"translated but omitted a field" notes; `debug` is exhaustive.

## Registry: a stub per source, so S2-S5 never touch it

`src/sources/index.ts` lists all eight source modules — three real-content ones added across
S2-S5, one real-content one shipped now (`copilot/instructions.ts`, the `.github/copilot-
instructions.md` row only), and the rest genuine stub files (`emptyFragment()`), one per
mapping-table row group (B1-B3, B6-B9). Every source is a pure function of `Ctx` (deterministic
given the paths/options/env it's handed, no SDK client, no other ambient global) called inside
a per-source `try`/`catch` — one bad source degrades to an empty `Fragment` plus a `warn`
diagnostic, every other source still runs (opencode itself only guards the whole hook, F2; a
mid-way throw inside our own hook would otherwise leave a partial injection). S2-S5 each
replace exactly one stub file's *content* and add their own `TODO(Sx)` assert block in
`test/e2e/run.ts` — this file's own line count is untouched by every later slice.
