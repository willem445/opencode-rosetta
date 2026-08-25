# 0002 — Blanket `mcp__*` on the allow side stays deny-all + an explicit warn

Status: accepted (issue #14, option 3). Owner: fix/allow-side-mcp-semantics.

## Context

A Claude agent frontmatter with `tools: mcp__*` says "allow all MCP tools". The translator
drops that entry (opencode has no all-MCP permission key), keeps the `"*": "deny"` allowlist
umbrella, and warns — so the emitted config *denies* what the source config meant to *allow*.
Safe (it can never grant more than the source asked for, the #10 invariant) but surprising:
the user's MCP tools stop working and only a terse warn hinted at why.

Issue #14 offered three options: keep as-is; expand the blanket to per-server allows for the
servers this plugin translates into `cfg.mcp` (option 2); or strengthen the warn (option 3).

## What opencode's permission model actually expresses (verified at tag v1.18.21)

- **Rule keys support wildcards.** A tool call evaluates
  `Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)`
  (`packages/opencode/src/permission/index.ts`, `evaluate()`); `Wildcard.match`
  (`packages/core/src/util/wildcard.ts`) anchors a regex where `*` → `.*`. So a key like
  `"srv_*"` matches every tool of server `srv` — which is exactly how specific-server grants
  (`mcp__srv` → `"srv_*": "allow"`) already work in this plugin.
- **An MCP tool asks under its own id.** MCP tools execute with
  `ctx.ask({ permission: <toolId>, patterns: ["*"], ... })` where `<toolId>` is
  `sanitize(server)_sanitize(tool)` (`packages/opencode/src/session/tools.ts`;
  `McpCatalog.toolName`, `packages/opencode/src/mcp/catalog.ts`). That is what makes the
  per-server keys above match.
- **There is no all-MCP key.** The only key covering every MCP tool is `"*"`, which also
  covers every built-in (`read`, `bash`, …) and any plugin-registered tool. Emitting `"*":
  "allow"` to honour the blanket would grant far more than Claude's `mcp__*` names — the
  widening bug class #10 was about, in a new place.

So a **bounded** expansion (option 2) is expressible *in opencode*, but only per enumerated
server. This plugin cannot enumerate them at conversion time: `toolsToPermission` runs inside
the `claude.agents` source, which the registry (`src/sources/index.ts`) executes **before**
`claude.mcp` — the translated-server list does not exist yet — and plumbing it across would
mean touching other slices' modules. Agent frontmatter itself never names MCP servers
(`mcpServers` is a dropped field).

## Decision

Option 3: keep today's fail-safe translation (blanket dropped, umbrella kept) and make the
warn state the consequence explicitly, per direction:

- Allow side (`tools: mcp__*`): *"MCP tools stay DENIED despite this allow rule"* + the rule
  name + the remediation (list servers explicitly, e.g. `mcp__<server>`).
- Deny side (`disallowedTools: mcp__*`): *"specific MCP servers are NOT denied by this
  entry"* + the same remediation shape.

This matches issue #14's own recommendation (option 3 as a minimum). Option 2 remains open as
a deliberate follow-up if a real user report lands: it would require re-ordering or
cross-wiring the sources (or a second pass at apply time) and must stay bounded to servers
rosetta itself translated — never a blanket `"*": "allow"`.

Pinned by tests: the explicit wording per direction, plus a never-widens test asserting the
dropped blanket contributes zero allow keys in any mix (bare, mixed with mapped tools, or
alongside a specific server).
