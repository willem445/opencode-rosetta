# opencode-rosetta

An [opencode](https://opencode.ai) plugin that lets you use your existing Claude Code and
GitHub Copilot configuration — agents, commands/prompts, MCP servers, instructions, and
skills — from opencode, translated in memory at startup. No files are generated or modified,
on disk or anywhere else.

## Install & enable

Add the plugin to your `opencode.json`:

```jsonc
// opencode.json
{
  "plugin": ["opencode-rosetta"]
}
```

Or pass options with the tuple form:

```jsonc
// opencode.json
{
  "plugin": [["opencode-rosetta", { "log": "info" }]]
}
```

Pin a version if you want upgrades to be explicit:

```jsonc
// opencode.json
{
  "plugin": ["opencode-rosetta@0.1.0"]
}
```

Without installing from npm, you can re-export the package locally (path plugins must export
an `id`, which `dist/index.js` already does):

```ts
// .opencode/plugins/rosetta.ts
export { default } from "opencode-rosetta";
```

Requires opencode 1.18.0 or newer; tested against opencode 1.18.21 and the current release.
List `opencode-rosetta` **first** in `plugin:` if you use other plugins that call `client.*`
during their own setup — see [Limitations](#limitations--troubleshooting).

## What gets translated

Everything below is discovered automatically at startup — there is nothing to run or sync.

### Claude Code

| Source file / location | Becomes in opencode | Notes |
|---|---|---|
| `.claude/agents/**/*.md`, `~/.claude/agents/**/*.md` | subagents (`mode: "subagent"`) | Tools allowlist becomes a permission ruleset; `model`, `color`, `maxTurns` mapped. See [Subagents](#subagents-claudeagentsmd). |
| `.claude/commands/**/*.md`, `~/.claude/commands/**/*.md` | slash commands | Argument placeholders shifted from Claude's 0-based `$N` to opencode's 1-based. See [Commands](#commands-claudecommandsmd). |
| `.mcp.json`, `~/.claude.json` | `mcp` server entries | stdio → local, http/streamable-http/sse → remote; `${VAR}` expansion. See [MCP servers](#mcp-servers). |
| `.claude/settings.json` / `.claude/settings.local.json` | respected, not translated | Servers listed in `disabledMcpjsonServers` are left out of the translation. |

### GitHub Copilot

| Source file / location | Becomes in opencode | Notes |
|---|---|---|
| `.github/copilot-instructions.md` | `instructions` entry | Always applied. |
| `.github/instructions/**/*.instructions.md`, `~/.copilot/instructions/**` | `instructions` entry, or path-scoped injection when the file has an `applyTo` glob | See [`applyTo` instructions](#applyto-instructions-path-scoped). |
| `.github/prompts/**/*.prompt.md` | slash commands | `${input:x}`, `${workspaceFolder}`, `#file:path` translated. See [Prompt files](#prompt-files-githubprompts). |
| `.github/agents/**/*.agent.md`, `.github/chatmodes/*.chatmode.md`, `~/.copilot/agents/**` | agents (invocable by you *and* by the model, by default) | Tool families become permission rules. See [Copilot agents](#copilot-agents-githubagents). |
| `.github/skills`, `~/.copilot/skills` | added to `skills.paths` | opencode's own skill scanner loads everything under them. Verify with `opencode debug skill`. |
| `.vscode/mcp.json` | `mcp` server entries | Including `${input:id}` resolution. See [MCP servers](#mcp-servers). |

### What is *not* translated

- **Handled by opencode natively already:** `.claude/skills/**`, `CLAUDE.md`, and `AGENTS.md`
  (including nested ones). opencode reads these itself; this plugin leaves them alone.
- **Out of scope for v0.1:** Cursor/Windsurf/Gemini configs, Claude hooks and other settings
  fields, `.claude/rules`, `.claude/CLAUDE.md` / `CLAUDE.local.md`, Copilot per-agent
  `mcp-servers` (cloud-only), the VS Code user-profile `mcp.json`, and `envFile`.
- **Fields with no opencode equivalent** inside otherwise-translated files (e.g. a Copilot
  agent's `handoffs`, a Claude agent's `mcpServers`): dropped and logged — never silently.

## Options

Every option is optional; the plain string form turns everything on with defaults.

```jsonc
"plugin": [["opencode-rosetta", {
  "claude":  true,   // or { "agents": true, "commands": true, "mcp": true, "user": true }
  "copilot": true,   // or { "instructions": true, "prompts": true, "agents": true, "skills": true, "mcp": true, "user": true, "applyTo": "inject" }
  "models":  { "sonnet": "anthropic/claude-sonnet-4-5", "Claude Sonnet 4": "github-copilot/claude-sonnet-4" },
  "inputs":  { "github-token": "{env:GITHUB_TOKEN}" },
  "log":     "warn"  // "off" | "warn" | "info" | "debug"
}]]
```

| Option | Default | What it does |
|---|---|---|
| `claude` | `true` | Master switch for all Claude Code sources. As an object: `agents`, `commands`, `mcp` toggle each artifact type; `user` toggles the home-directory variants (`~/.claude/...`, `~/.claude.json`). |
| `copilot` | `true` | Master switch for all Copilot sources. As an object: `instructions`, `prompts`, `agents`, `skills`, `mcp` toggle each artifact type; `user` toggles the home-directory variants (`~/.copilot/...`); `applyTo` selects how scoped instruction files are handled (see below). |
| `models` | `{}` | Maps a Claude model alias (`sonnet`/`opus`/`haiku`/`fable`) or an exact Copilot model string to an opencode `provider/model` id. Anything unmapped is omitted rather than guessed. |
| `inputs` | `{}` | Resolves VS Code `${input:id}` references in `.vscode/mcp.json`. Values may themselves reference the environment, e.g. `{env:GITHUB_TOKEN}`. |
| `log` | `"warn"` | Log threshold for diagnostics sent through opencode's log. `"off"` disables logging entirely (translation still runs). |

Kill switch: set `OPENCODE_ROSETTA=off` in the environment to disable the plugin outright,
without removing it from `plugin:`.

## Behaviour worth knowing

### Precedence

1. **A key already present in your opencode config is never overwritten** — including keys
   from your own `opencode.json` / `.opencode/**`, managed config, or any plugin loaded
   before this one. `instructions` and `skills.paths` are appended instead (and deduped).
2. Among rosetta's own translations: Claude sources before Copilot; within one source, the
   project root nearest to where you started opencode wins, then the further-out root, then
   (if enabled) your home-directory copy. A losing duplicate is logged as a warning.
3. Nothing is silently dropped: every skip carries a reason
   (`exists-in-config`, `duplicate`, `disabled`, `unparseable`, …) at the configured `log`
   level.

### `applyTo` instructions (path-scoped)

Copilot supports instructions that only apply to files matching a glob:

```markdown
---
applyTo: "**/*.ts"
---
Use `type` imports for type-only symbols.
```

opencode has no config-time equivalent, so rosetta implements it at runtime: when the model
reads a matching file, the instructions are appended to the read tool's output inside a
`<system-reminder>` block, mirroring what opencode itself does for nested `AGENTS.md` files:

```
<system-reminder>
Instructions from: /repo/.github/instructions/ts.instructions.md (applyTo: **/*.ts)
Use `type` imports for type-only symbols.
</system-reminder>
```

Each `(session, file)` pair is injected at most once per session, so re-reading a file never
duplicates the reminder. An `applyTo` glob that matches everything (`**`, `*`, `**/*`) is
treated as unconditional instead, like the root `copilot-instructions.md`; a file with no
`applyTo` at all is skipped (Copilot only applies those when manually attached).

The `copilot.applyTo` option chooses how non-universal `applyTo` files are treated:

- `"inject"` (**default**) — the runtime hook described above.
- `"always"` — treat every scoped file as unconditional and put it in `instructions`.
- `"ignore"` — drop them (logged).

Set `"copilot": { "applyTo": "ignore" }` to turn the read-output modification off entirely.

### Warnings, not failures

Translation never blocks startup. A file that cannot be parsed or read is skipped with a
logged warning; an unexpected error in one source disables just that source. Unresolvable
things are omitted rather than guessed — a `model:` value rosetta cannot map is left out
(your agent inherits the session model) instead of emitting an id that would fail later.
Secrets (environment values, `~/.claude.json`, MCP env values) are read in memory only and
never appear in a diagnostic or log line — warnings carry variable *names*, never values.

## Field-by-field detail

### Subagents (`.claude/agents/**/*.md`)

| Claude field | opencode | Notes |
|---|---|---|
| `name` / `description` / body | agent key / `description` / `prompt` | No usable `name` → the file is treated as a plain doc and ignored. `name` without `description` → skipped + logged. A `name` containing `:` or starting with `-` → skipped + warned. |
| `tools` (comma list) | `permission = { "*": "deny", …allows }` | Allowlist semantics — same shape as opencode's native `explore` agent. `Read→read`, `Write/Edit/MultiEdit/NotebookEdit→edit`, `Bash→bash`, `Glob→glob`, `Grep→grep`, `LS→list`, `WebFetch→webfetch`, `WebSearch→websearch`, `Task/Agent→task`, `TodoWrite→todowrite`, `Skill→skill`, `AskUserQuestion→question`. Narrow forms translate too: `Bash(git *)` → `bash: {"git *": "allow"}`; `Agent(a, b)` → `task: {"*":"deny", a:"allow", b:"allow"}`; `mcp__srv` → `"srv_*": "allow"`, `mcp__srv__tool` → `"srv_tool": "allow"`. Unknown tool names are dropped + warned. |
| `disallowedTools` | same keys with `"deny"`, applied after allows | Per-server MCP denies translate exactly (`mcp__db__query` → `"db_query": "deny"`), so "server X except tool Y" survives. Only the blanket form `mcp__*` is inexpressible (opencode has no all-MCP rule) → dropped + warned. |
| `model` | `model` | Absent/`inherit` → omitted. `sonnet`/`opus`/`haiku`/`fable` → your `models` mapping, else omitted + logged. A full `claude-*` id → `anthropic/<id>` (your `models` mapping overrides). Anything else → omitted + logged. |
| `permissionMode` | folded into `permission` | `plan` → `edit: "deny"`; `acceptEdits` → `edit: "allow"`; `default`/`manual`/`auto`/`dontAsk`/`bypassPermissions` → no rule + logged — in particular `bypassPermissions` is deliberately *not* mapped to `"*": "allow"`. |
| `color` | `color` | `red→error`, `blue→primary`, `green→success`, `yellow→warning`, `purple→secondary`, `orange/pink→accent`, `cyan→info`; anything else dropped + logged. |
| `maxTurns` | `steps` | Non-numeric values dropped + logged. |
| `skills`, `mcpServers`, `hooks`, `memory`, `background`, `effort`, `isolation`, `initialPrompt` | dropped | Logged once per file, naming the fields. |

### Commands (`.claude/commands/**/*.md`)

The command name is the file basename without extension — subdirectories are **not** part of
the name (Claude's rule), so `.claude/commands/frontend/component.md` becomes `/component`.

| Claude field | opencode | Notes |
|---|---|---|
| file basename | command key | A collision across scopes resolves nearest-first; the loser is logged. |
| body | `template` | `$ARGUMENTS` passes through unchanged. `$ARGUMENTS[N]` and bare `$N` are shifted **+1**: Claude counts positions from 0, opencode from 1. Named `arguments:` entries map to their declared position (`$issue` with `arguments: [issue, branch]` → `$1`). `${CLAUDE_PROJECT_DIR}` → your worktree root. `` !`cmd` `` shell injection and `@file` references pass through unchanged (identical syntax in opencode). |
| `description` (+ `argument-hint`) | `description` | Hint appended as `"<description> — args: <hint>"`. |
| `model` | `model` | Same rules as subagents above. |
| `context: fork` (+ `agent`) | `subtask: true` (+ `agent`) | The agent is kept when it maps to an opencode built-in (`Explore→explore`, `Plan→plan`, `general-purpose→general`) or names a subagent translated from `.claude/agents` in the same run; otherwise omitted + logged. |
| `allowed-tools`, `disallowed-tools`, `disable-model-invocation`, `user-invocable`, `hooks`, `paths`, `effort`, `when_to_use`, `background` | dropped | opencode commands have no per-command tool scope. Logged once per file. |

Known template limitation: Claude's `\$` escape becomes a literal `$` after the shift, but
opencode has no template escape of its own — its argument substitution runs over the whole
template — so an escaped `$1` still reads as "argument 1" to opencode at invocation time.

### MCP servers

Sources, in precedence order (first hit wins; a name seen again in a further scope is
skipped with a `duplicate` warning):

1. `<root>/.mcp.json` for every project root, nearest to where you started opencode first;
2. `~/.claude.json` → `projects[<worktree>].mcpServers` (Claude's "local" scope);
3. `~/.claude.json` top-level `mcpServers` (user scope);
4. `<root>/.vscode/mcp.json` → `servers`.

Both home-file scopes are gated by the `claude.user` option. Server names listed in
`disabledMcpjsonServers` (`.claude/settings.json` or `.claude/settings.local.json`, project
or home) are skipped.

| Input field | opencode | Notes |
|---|---|---|
| `type: "stdio"` (or absent) + `command`, `args`, `env`, `cwd` | `{type:"local", command:[command,...args], environment, cwd}` | `command` occupies index 0 of opencode's array. |
| `type: "http"` \| `"streamable-http"` \| `"sse"` + `url`, `headers` | `{type:"remote", url, headers}` | opencode tries StreamableHTTP then SSE itself. |
| `timeout` | `timeout` | Passed through when present. |
| `url` without `type` | skipped + warned | Claude rejects this too. |
| any other `type` (e.g. `ws`) | skipped + warned | No opencode equivalent for WebSocket servers yet. |
| `oauth` | dropped | Shapes differ from opencode's; leave opencode's own auto-detection on. |
| `${VAR}`, `${VAR:-default}`, `${env:VAR}` in `command`/`args`/`env`/`cwd`/`url`/`headers` | expanded from the process environment | A missing variable with no default is **left literal** + warned (naming only the variable NAME — values may be credentials). A variable that is **set but empty** behaves like an unset one: with a `:-default` the default is used (shell semantics), without one it is left literal + warned. Malformed references (unmatched `${`, bare `$VAR`, nested braces) pass through untouched — expansion never throws. |
| `${workspaceFolder}` / `${userHome}` (`.vscode/mcp.json`) | your worktree root / home directory | |
| `${input:id}` (`.vscode/mcp.json`) | resolved in order: (1) the `inputs` option — itself `{env:VAR}`-expandable; (2) env var `ROSETTA_INPUT_<ID>` (id upper-cased, non-alphanumeric → `_`); (3) the file's own `inputs[].default` | **Unresolved everywhere → the whole server is skipped with a warning.** VS Code would prompt interactively; a startup-time plugin cannot, so the server is dropped rather than injected broken. |

`${input:}` example — given this `.vscode/mcp.json`:

```jsonc
{
  "inputs": [
    { "id": "github-token", "type": "promptString" },              // no default
    { "id": "region", "type": "promptString", "default": "eu" }    // fallback default
  ],
  "servers": {
    "gh": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${input:github-token}", "REGION": "${input:region}" }
    }
  }
}
```

…resolve the token without VS Code's prompt box:

```jsonc
{
  "plugin": [["opencode-rosetta", {
    "inputs": { "github-token": "{env:GITHUB_TOKEN}" }
  }]]
}
```

With neither the `inputs` option, nor `ROSETTA_INPUT_GITHUB_TOKEN` set, nor a default, the
whole `gh` server stays out of your config and a warning names it. `envFile`, `dev`,
`sandboxEnabled`, and `oauth` fields in `.vscode/mcp.json` have no equivalent here and are
dropped + logged.

### Prompt files (`.github/prompts/`)

| Copilot field | opencode | Notes |
|---|---|---|
| `name` frontmatter, or the file basename minus `.prompt` | command key | Subdirectories are not part of the name. A collision between two roots: nearest-to-cwd wins, farther one logged as a `duplicate` warning. |
| `description` (+ `argument-hint`) | `description` | The hint is appended: `"Draft a plan — args: topic"`. |
| `agent`, or legacy `mode` | `agent` | Kept when it names an opencode built-in (`build`, `plan`, `general`, `explore`); legacy Copilot modes (`ask`/`edit`/`agent`) and anything else are dropped + logged rather than producing a command that references a nonexistent agent. |
| `model` | `model` | Mapped through the `models` option by exact string; for a list, the first mappable entry wins; otherwise omitted + logged — never guessed. |
| `tools` | dropped + logged | opencode commands have no per-command tool scope. |
| body | `template` | One distinct `${input:x}` → `$ARGUMENTS`; several → `$1..$N` by first appearance (repeats reuse their number); `${workspaceFolder}` → your worktree path; `#file:path` → `@path`. VS Code-only references (`${file}`, `${selection}`, `#tool:x`, …) are left literal + warned, so a prompt you tested in Copilot cannot silently change meaning. |

### Copilot agents (`.github/agents/**`, `.github/chatmodes/**`, `~/.copilot/agents`)

Searched nearest-first (`.github/agents` then `.github/chatmodes` per root), then your home
directory (disable with `"copilot": { "user": false }`). A name collision resolves
nearest-first; the loser is logged.

| Copilot field | opencode | Notes |
|---|---|---|
| `name` frontmatter, or the file basename minus `.agent`/`.chatmode` | agent key | |
| `description` / body | `description` / `prompt` | Missing `description` → skipped + logged (Copilot only shows described agents in its picker, so there is nothing to render anyway). |
| — | `mode` | `"all"` by default (both user-invocable and model-invocable). `user-invocable: false` → `"subagent"`; `disable-model-invocation: true` → `"primary"`. If both flags are set, `user-invocable: false` wins → `"subagent"` ("hidden from both pickers" is not an opencode mode). |
| `tools` (array or comma-separated string) | `permission = { "*": "deny", …allows }` | Same allowlist shape as Claude subagents. Families: `read`/`readFile`/`read/*` → `read`; `edit`/`editFiles`/`createFile`/`createDirectory`/`edit/*` → `edit`; `execute`/`runInTerminal`/`runCommands`/`runTasks`/`execute/*` → `bash`; `search`/`codebase`/`fileSearch`/`textSearch`/`usages`/`listDirectory`/`search/*` → `grep` + `glob` + `list`; `web`/`fetch`/`web/*` → `webfetch` + `websearch`; `agent`/`runSubagent`/`agent/*` → `task`; `todos` → `todowrite`; `vscode/askQuestions` → `question`; `<server>/<tool>` → `"<server>_<tool>"` and `<server>/*` → `"<server>_*"`. Unknown names (`browser_*`, `githubRepo`, `problems`, …) are dropped + one log per file naming them. |
| `tools: "*"` or absent | no permission rule | The agent keeps opencode's default tools. |
| `agents: []` | `task: "deny"` | Explicitly no subagents. Applied *after* the tools allowlist, so an explicit deny wins over an `agent`-family allow. |
| `agents: [a, b]` | `task: {"*":"deny", a:"allow", b:"allow"}` | Only these subagents. |
| `agents: ["*"]` / absent | no rule | All subagents allowed — nothing to constrain. |
| `model` (string or array) | `model` | Mapped through the `models` option by exact string; for an array, the first mappable entry wins; otherwise omitted + logged. |
| `mcp-servers`, `handoffs`, `hooks`, `target`, `argument-hint`, `metadata`, `infer` | dropped | Logged once per file, naming the fields. `mcp-servers` is cloud-only (`${{ secrets.X }}`). |

## Limitations & troubleshooting

- Every "drop" described above is intentional and logged — not a bug. Unresolved `models` /
  `inputs` references are omitted rather than guessed.
- Ordering matters if another plugin listed before `opencode-rosetta` calls `client.*`
  during its own setup in a way that materializes agent/command/skill state early — list
  `opencode-rosetta` **first**.
- Model strings are not validated against the providers you actually have configured; an
  unresolvable `provider/model` fails at invocation time, the same as if you had typed it by
  hand.
- Useful commands when something looks missing:
  - `opencode debug config` — prints the fully-resolved, post-plugin config; the fastest way
    to see exactly what rosetta added.
  - `opencode debug info` — lists loaded plugins (confirm `opencode-rosetta` is one) and
    which version you are running.
  - `--pure` (or `OPENCODE_PURE=1`) — runs opencode with external plugins disabled; an A/B
    against `opencode debug config` shows exactly what this plugin contributes.
  - `"log": "debug"` in this plugin's options — every translated key and every skip, with a
    reason.
  - `OPENCODE_ROSETTA=off` — disable just this plugin.
  - `OPENCODE_DISABLE_PROJECT_CONFIG=1` — start from global config only, if a broken project
    config won't let opencode start at all.
- Releases and their changes are documented in [`CHANGELOG.md`](CHANGELOG.md).

Curious how it works? [`docs/design/0001-config-hook-translation.md`](docs/design/0001-config-hook-translation.md)
has the mechanism and rationale (short version: a plugin `config` hook mutates the live
config object in memory before anything consumes it — nothing is ever written to disk).

## Development

```sh
bun install
bun run typecheck
bun test
bun run build
bun run e2e     # needs a real `opencode` binary on PATH (npm i -g opencode-ai)
```

## License

MIT — see [`LICENSE`](LICENSE).
