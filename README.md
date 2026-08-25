# opencode-rosetta

An [opencode](https://opencode.ai) plugin that translates the Claude Code and GitHub Copilot
artifacts you already maintain — subagents, commands/prompts, MCP servers, instructions,
skills — into opencode config, **in memory**, via the plugin `config` hook. Nothing is written
to your repo; nothing is written to disk at all. See
[`docs/design/0001-config-hook-translation.md`](docs/design/0001-config-hook-translation.md)
for how and why.

> **Status:** slices S1 (scaffold + CI; `.github/copilot-instructions.md`), S2 (Claude
> subagents + commands, tables B1/B2) and S4 (Copilot instructions with `applyTo`, prompts,
> skills) are shipped. Every other row below is a stub today and lands in S3/S5
> (tracked on [#1](https://github.com/willem445/opencode-rosetta/issues/1)).

## Install

```jsonc
// opencode.json
{
  "plugin": ["opencode-rosetta"] // string form: every default on
}
```

```jsonc
// opencode.json — tuple form, with options
{
  "plugin": [["opencode-rosetta", { "log": "info" }]]
}
```

Or, without publishing to npm, as a local re-export (path plugins must export an `id`, which
`dist/index.js` already does):

```ts
// .opencode/plugins/rosetta.ts
export { default } from "opencode-rosetta";
```

List `opencode-rosetta` **first** in `plugin:` if you use other plugins that call `client.*`
during their own `server()` — see "Ordering" under Limitations.

## What gets translated

| From | To | Slice |
|---|---|---|
| `.claude/agents/**/*.md`, `~/.claude/agents/**/*.md` | `cfg.agent[name]` | **S2** |
| `.claude/commands/**/*.md`, `~/.claude/commands/**/*.md` | `cfg.command[name]` | **S2** |
| `.mcp.json`, `~/.claude.json` | `cfg.mcp[name]` | S3 |
| `.claude/skills/**`, `CLAUDE.md`, `AGENTS.md` | **native to opencode already — untouched** | — |
| `.github/copilot-instructions.md` | `cfg.instructions[]` | **S1** |
| `.github/instructions/**/*.instructions.md` (+ `applyTo`), `~/.copilot/instructions/**` | `cfg.instructions[]` or path-scoped injection | **S4** |
| `.github/prompts/**/*.prompt.md` | `cfg.command[name]` | **S4** |
| `.github/agents/**/*.agent.md` (+ `*.chatmode.md`), `~/.copilot/agents` | `cfg.agent[name]` | S5 |
| `.github/skills`, `~/.copilot/skills` | `cfg.skills.paths[]` | **S4** |
| `.vscode/mcp.json` | `cfg.mcp[name]` | S3 |

**Out of scope for v1** (see the design note): Cursor/Windsurf/Gemini, Claude hooks/settings,
`.claude/rules`, `.claude/CLAUDE.md`/`CLAUDE.local.md`, writing files, `envFile`, Copilot
per-agent `mcp-servers`, VS Code user-profile `mcp.json`.

## Options

```jsonc
"plugin": [["opencode-rosetta", {
  "claude":  true,   // or { "agents": true, "commands": true, "mcp": true, "user": true }
  "copilot": true,   // or { "instructions": true, "prompts": true, "agents": true, "skills": true, "mcp": true, "user": true, "applyTo": "inject" }
  "models":  { "sonnet": "anthropic/claude-sonnet-4-5", "Claude Sonnet 4": "github-copilot/claude-sonnet-4" },
  "inputs":  { "github-token": "{env:GITHUB_TOKEN}" },
  "log":     "warn"  // off | warn | info | debug
}]]
```

- `claude`/`copilot`: `true`/`false` for the whole tool, or an object turning individual
  artifact types (and the `user`-scope/home-directory variant) on or off.
- `copilot.applyTo`: `"inject"` (default — a matching file read gets the scoped instructions
  appended, S4), `"always"` (treat every scoped instructions file as unconditional), or
  `"ignore"` (drop them).
- `models`: maps a Claude model alias (`sonnet`/`opus`/`haiku`/`fable`) or a Copilot model
  string to an opencode `provider/model` id. Unmapped aliases are omitted, not guessed.
- `inputs`: resolves VS Code `${input:id}` references in `.vscode/mcp.json` (S3).
- `log`: diagnostics threshold for what gets sent to `client.app.log`; `off` disables logging
  entirely (translation still runs).

Kill switch: set `OPENCODE_ROSETTA=off` in the environment to disable the plugin outright.

## Precedence

1. **A key already present in your config is never touched.** This includes your own
   `opencode.json`/`.opencode/**`, remote/managed config, and any plugin listed before this
   one. `instructions` and `skills.paths` are appended instead (and deduped).
2. Among rosetta's own sources: Claude before Copilot; within one source, the root nearest to
   where you ran opencode before a further-out one, then (if enabled) your home-directory
   (`~/...`) copy.
3. Every skip is logged with a reason (`exists-in-config`, `duplicate`, `disabled`,
   `unparseable`, `unmappable`) at the configured `log` level — nothing is silently dropped.

Full detail, including why this is *the* mechanism opencode-rosetta uses (never generated
files, never `client.config.update`): [`docs/design/0001-config-hook-translation.md`](docs/design/0001-config-hook-translation.md).

## Mapping tables

Each table below documents one row of "What gets translated" field-by-field: what's read,
what it becomes, and what's dropped (with why). Filled in as each slice ships.

### B1. Claude subagents (**S2, shipped**)

`.claude/agents/**/*.md` and `~/.claude/agents/**/*.md` → `cfg.agent[name]`, `mode: "subagent"`.
Searched nearest-to-where-you-ran-opencode first, then your home directory (disable the latter
with `"claude": { "user": false }`).

| Claude | opencode | Notes |
|---|---|---|
| `name` | key | No `name` → skipped silently (Claude treats it as a docs file). `name` without `description` → skipped + logged (`info`). A `name` containing `:` or starting with `-` → skipped + logged (`warn`). Unparseable frontmatter → skipped + logged (`warn`, `unparseable`). |
| `description` / body | `description` / `prompt` | |
| — | `mode: "subagent"` | Claude subagents are subagents; keeps your primary picker clean. |
| `tools` (comma list) | `permission = { "*": "deny", …allows }` | Allowlist semantics — the same shape as opencode's native `explore` agent. Emitted as **`permission`, never `tools`** (hook-injected agents bypass opencode's schema decoder, which is the only place that converts `tools`; see the design note, F5). `Read→read`, `Write/Edit/MultiEdit/NotebookEdit→edit`, `Bash→bash`, `Glob→glob`, `Grep→grep`, `LS→list`, `WebFetch→webfetch`, `WebSearch→websearch`, `Task/Agent→task`, `TodoWrite→todowrite`, `Skill→skill`, `AskUserQuestion→question`. `Bash(git *)` → `bash: {"git *": "allow"}`; `Agent(a, b)` → `task: {"*":"deny", a:"allow", b:"allow"}`; `mcp__srv` → `"srv_*": "allow"`, `mcp__srv__tool` → `"srv_tool": "allow"` (opencode MCP tool ids are `<server>_<tool>` — verified in `McpCatalog.toolName`, `mcp/catalog.ts` at v1.18.21). Unknown tool names are dropped + logged (`warn`). |
| `disallowedTools` | same keys with `"deny"`, applied after allows | Specific denies translate exactly as allows do — including per-tool MCP denies (`mcp__db__query` → `"db_query": "deny"`), so "server X except tool Y" stays server-X-except-tool-Y. Only the blanket form `mcp__*` is inexpressible (opencode has no all-MCP key) → dropped + logged (`warn`). |
| `model` | `model` | `inherit`/absent → omitted. `sonnet/opus/haiku/fable` → your `models` option mapping, else omitted + logged (`info`). A full `claude-*` id → `anthropic/<id>` (overridable via `models`). Anything else → omitted + logged (`info`) — an unresolvable `provider/model` fails at prompt time, so rosetta never guesses. |
| `permissionMode` | merged into `permission` | `plan` → `edit: "deny"`; `acceptEdits` → `edit: "allow"`; `default/manual/auto/dontAsk/bypassPermissions` → no rule + logged (`info`) — in particular `bypassPermissions` is deliberately *not* mapped to `"*": "allow"`. |
| `color` | `color` | `red→error`, `blue→primary`, `green→success`, `yellow→warning`, `purple→secondary`, `orange/pink→accent`, `cyan→info`; anything else dropped + logged (`info`). |
| `maxTurns` | `steps` | Non-numeric values dropped + logged (`info`). |
| `skills`, `mcpServers`, `hooks`, `memory`, `background`, `effort`, `isolation`, `initialPrompt` | dropped | Logged once per file (`info`, naming the fields). Inline per-agent `mcpServers` is a follow-up. |

### B2. Claude commands (**S2, shipped**)

`.claude/commands/**/*.md` and `~/.claude/commands/**/*.md` → `cfg.command[name]`. The command
name is the file basename without extension — subdirectories are **not** part of the name
(Claude's rule), so `.claude/commands/frontend/component.md` is `/component`. A name collision
across scopes resolves nearest-first, and the loser is logged (`warn`, `duplicate`).

| Claude | opencode | Notes |
|---|---|---|
| file basename | key | See above. |
| body | `template` | `$ARGUMENTS` unchanged. `$ARGUMENTS[N]` and bare `$N` are shifted **+1**: Claude counts positions from 0 (`$0` is the first argument — verified against the current Claude Code skills doc, "Available string substitutions"), opencode from 1. Named `arguments:` entries map to their declared position (`$issue` with `arguments: [issue, branch]` → `$1`). `${CLAUDE_PROJECT_DIR}` → your worktree root. `` !`cmd` `` shell injection and `@file` references pass through unchanged (identical syntax in opencode). |
| `description` (+ `argument-hint`) | `description` | Hint appended as `"<description> — args: <hint>"`. |
| `model` | `model` | Exactly as B1. |
| `context: fork` (+ `agent`) | `subtask: true` (+ `agent`) | The agent is kept when it maps to a built-in (`Explore→explore`, `Plan→plan`, `general-purpose→general`) or names an agent this plugin translated from `.claude/agents` in the same run; otherwise omitted + logged (`info`, `unknown-fork-agent`). |
| `allowed-tools`, `disallowed-tools`, `disable-model-invocation`, `user-invocable`, `hooks`, `paths`, `effort`, `when_to_use`, `background` | dropped | Commands have no per-command tool scope in opencode. Logged once per file (`info`). |

Known template limitation: Claude's `\$` escape becomes a literal `$` after the shift, but
opencode has no template escape of its own — its argument substitution runs over the whole
template — so an escaped `$1` still reads as "argument 1" to opencode at invocation time.
Avoid escaping positional-looking placeholders inside templates you want taken literally.

### B3. Claude MCP (S3)

### B4. Claude skills / `CLAUDE.md` (native — verified by the e2e negative control, no translation)

### B5. Copilot instructions

| Copilot | opencode | Notes |
|---|---|---|
| `.github/copilot-instructions.md` | `cfg.instructions[]` (absolute path) | Always-on; searched nearest-to-cwd first (**S1**, shipped). |
| `.github/instructions/**/*.instructions.md` with `applyTo: "**"` / `*` / `**/*` | `cfg.instructions[]` | A glob that matches everything means "always apply" — same as the root file. |
| … with any other `applyTo` glob (comma-separated lists supported) | **path-scoped injection**: a matching `read` tool call gets the instructions appended to its output, once per session per file | Default mode `inject`; see below. Matching normalizes Windows backslashes to posix before comparing, so `src/**/*.ts` matches on every platform. |
| … with no `applyTo` at all | dropped + `info` diagnostic | Copilot only applies these when a user manually attaches them; there is no always-on equivalent. |
| `~/.copilot/instructions/**` | same rules as above | Gated by `"copilot": { "user": false }`. |
| `name`, `description`, `excludeAgent` frontmatter | dropped | No opencode equivalent for per-file metadata. |

The injected text mirrors what opencode itself does for nested `AGENTS.md`
files: a `<system-reminder>` block appended to the read tool's output:

```
<system-reminder>
Instructions from: /repo/.github/instructions/ts.instructions.md (applyTo: **/*.ts)
Use `type` imports for type-only symbols.
</system-reminder>
```

Each `(session, file)` pair is injected at most once per session, so
re-reading a file never duplicates the reminder.

**The `copilot.applyTo` option** chooses how non-universal `applyTo` files are
treated: `"inject"` (default — the read hook above), `"always"` (treat every
scoped file as unconditional and put it in `cfg.instructions`), or `"ignore"`
(drop them with an `info` diagnostic).

### B6. Copilot prompts (shipped in S4)

`.github/prompts/**/*.prompt.md` → `cfg.command[name]`:

| Copilot | opencode | Notes |
|---|---|---|
| `name` frontmatter, or the file basename minus `.prompt` | command key | Subdirectories are not part of the name. A collision between two roots: nearest-to-cwd wins, farther one logged as a `duplicate` warning. |
| `description` (+ `argument-hint`) | `description` | The hint is appended: `"Draft a plan — args: topic"`. |
| `agent`, or legacy `mode` | `agent` | `plan` → `plan`; `ask`/`edit`/`agent` (legacy Copilot modes) and any other unknown agent are dropped with an `info` diagnostic rather than producing a command that references an agent that does not exist. |
| `model` | `model` | Mapped through this plugin's `models` option by exact string; for a list, the first mappable entry wins; otherwise omitted + `info` — never guessed. |
| `tools` | dropped + `info` | opencode commands have no per-command tool scope. |
| body | `template` | One distinct `${input:x}` → `$ARGUMENTS`; several → `$1..$N` by first appearance (repeats reuse their number); `${workspaceFolder}` → your worktree path; `#file:path` → `@path`. VS Code-only references (`${file}`, `${selection}`, `#tool:x`, …) are left literal + a `warn` so a prompt you tested in Copilot cannot silently change meaning. |

### B7. Copilot agents (S5)

### B8. Copilot skills (shipped in S4)

`.github/skills` and `~/.copilot/skills` → `cfg.skills.paths[]`: the directory's
absolute path is appended (user scope gated by `"copilot": { "user": false }`),
and opencode's own skill scanner does everything else — it loads every
`SKILL.md` under the path, registers the skill as a `/name` command, and
whitelists reads inside it. Nothing is symlinked and no second parser is
involved; because the consumer dedupes by absolute path, a directory opencode
someday scans natively simply stops being re-added. Verify with
`opencode debug skill`.

### B9. Copilot MCP / VS Code `mcp.json` (S3)

## Limitations

- Every "drop" in the tables above (once filled in) is intentional and documented there — not
  a bug. `models`/`inputs` unresolved references are omitted rather than guessed.
- An artifact file that exists but cannot be read (permissions, locked by another process) is
  skipped with a logged `could-not-read (<errno>)` warning — it never blocks startup.
- **Ordering matters** if another plugin listed before `opencode-rosetta` in `plugin:` calls
  `client.*` inside its own `server()` in a way that materializes Agent/Command/Skill state
  early — list `opencode-rosetta` first.
- Secrets (`~/.claude.json`, `.mcp.json`/`mcp.json` environment values) are read in memory
  only and never appear in a diagnostic or log line.
- Nothing here re-validates a `model` string against the provider you actually have configured
  — an unresolvable `provider/model` fails at prompt time, the same as if you had typed it by
  hand.

## Troubleshooting

- `opencode debug config` — prints the fully-resolved, post-hook config as JSON; the fastest
  way to see exactly what rosetta added.
- `opencode debug info` — lists loaded plugins, to confirm `opencode-rosetta` is one of them.
- `--pure` (or `OPENCODE_PURE=1`) — runs opencode with every external plugin disabled; a quick
  A/B against `opencode debug config` shows exactly what this plugin contributed.
- `"log": "debug"` in this plugin's options — every translated key and every skip, with a
  reason.
- `OPENCODE_ROSETTA=off` — disable just this plugin without removing it from `plugin:`.
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` — skip the project's local `opencode.json`/plugin list
  entirely and start from global config only, if a broken project config won't let opencode
  start at all.

## Development

```sh
bun install
bun run typecheck
bun test
bun run build
bun run e2e     # needs a real `opencode` binary on PATH (npm i -g opencode-ai@1.18.21)
```

See [`docs/design/0001-config-hook-translation.md`](docs/design/0001-config-hook-translation.md)
for the architecture, and issue [#1](https://github.com/willem445/opencode-rosetta/issues/1)
for the full slice-by-slice plan.

## License

MIT — see [`LICENSE`](LICENSE).
