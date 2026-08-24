# opencode-rosetta

An [opencode](https://opencode.ai) plugin that translates the Claude Code and GitHub Copilot
artifacts you already maintain — subagents, commands/prompts, MCP servers, instructions,
skills — into opencode config, **in memory**, via the plugin `config` hook. Nothing is written
to your repo; nothing is written to disk at all. See
[`docs/design/0001-config-hook-translation.md`](docs/design/0001-config-hook-translation.md)
for how and why.

> **Status:** slice S1 (scaffold + CI + one proof-of-life row: `.github/copilot-instructions.md`).
> Every other row below is a stub today and lands in S2-S5 (tracked on
> [#1](https://github.com/willem445/opencode-rosetta/issues/1)).

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
| `.claude/agents/**/*.md`, `~/.claude/agents/**/*.md` | `cfg.agent[name]` | S2 |
| `.claude/commands/**/*.md`, `~/.claude/commands/**/*.md` | `cfg.command[name]` | S2 |
| `.mcp.json`, `~/.claude.json` | `cfg.mcp[name]` | S3 |
| `.claude/skills/**`, `CLAUDE.md`, `AGENTS.md` | **native to opencode already — untouched** | — |
| `.github/copilot-instructions.md` | `cfg.instructions[]` | **S1** |
| `.github/instructions/**/*.instructions.md` (+ `applyTo`), `~/.copilot/instructions/**` | `cfg.instructions[]` or path-scoped injection | S4 |
| `.github/prompts/**/*.prompt.md` | `cfg.command[name]` | S4 |
| `.github/agents/**/*.agent.md` (+ `*.chatmode.md`), `~/.copilot/agents` | `cfg.agent[name]` | S5 |
| `.github/skills`, `~/.copilot/skills` | `cfg.skills.paths[]` | S4 |
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

### B1. Claude subagents (S2)

### B2. Claude commands (S2)

### B3. Claude MCP (S3)

### B4. Claude skills / `CLAUDE.md` (native — verified by the e2e negative control, no translation)

### B5. Copilot instructions

`.github/copilot-instructions.md` → `cfg.instructions[]` (**S1, shipped**): if the file exists
at your project root (or a root above where you ran opencode, nearest first), its absolute
path is appended to `cfg.instructions`. Nothing else in this table exists yet — the rest
(`.github/instructions/**/*.instructions.md`, `applyTo` path-scoping, the
`~/.copilot/instructions/**` user tree) is S4.

### B6. Copilot prompts (S4)

### B7. Copilot agents (S5)

### B8. Copilot skills (S4)

### B9. Copilot MCP / VS Code `mcp.json` (S3)

## Limitations

- Every "drop" in the tables above (once filled in) is intentional and documented there — not
  a bug. `models`/`inputs` unresolved references are omitted rather than guessed.
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
