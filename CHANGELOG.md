# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.1.0] - 2026-08-24

Initial release. One plugin, one mechanism: a `config` hook that translates
Claude Code and GitHub Copilot artifacts into opencode config **in memory** —
nothing is ever written to disk.

### Added

- **Claude Code sources**
  - `.claude/agents/**/*.md` and `~/.claude/agents/**/*.md` → `cfg.agent[name]`
    (subagents; tools allowlist → opencode `permission`, model/color/maxTurns
    mapping) (B1).
  - `.claude/commands/**/*.md` and `~/.claude/commands/**/*.md` →
    `cfg.command[name]` (`$ARGUMENTS`, `$N` 0-based → 1-based shift,
    `context: fork` → `subtask`) (B2).
  - `.mcp.json` and `~/.claude.json` MCP servers → `cfg.mcp[name]` (B3).
- **GitHub Copilot sources**
  - `.github/copilot-instructions.md` → `cfg.instructions[]` (B5).
  - `.github/instructions/**/*.instructions.md` with `applyTo` globs →
    path-scoped injection on file reads (configurable: `inject` / `always` /
    `ignore`), plus `~/.copilot/instructions/**` (B5).
  - `.github/prompts/**/*.prompt.md` → `cfg.command[name]` (`${input:x}`,
    `${workspaceFolder}`, `#file:` translation) (B6).
  - `.github/agents/**/*.agent.md`, `.github/chatmodes/*.chatmode.md` and
    `~/.copilot/agents` → `cfg.agent[name]` (tools families, subagent rules,
    mode derivation) (B7).
  - `.github/skills` and `~/.copilot/skills` → `cfg.skills.paths[]` (B8).
  - `.vscode/mcp.json` (incl. `${input:}`, `${env:}` expansion) →
    `cfg.mcp[name]` (B9).
- Precedence guarantees: a key already present in config is never overwritten;
  every skip is logged with a reason via `client.app.log`.
- Options: per-tool/per-artifact toggles, `models` alias map, `inputs` map for
  VS Code `${input:}` references, log threshold, `OPENCODE_ROSETTA=off` kill switch.
