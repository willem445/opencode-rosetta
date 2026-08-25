Lessons recorded by orrerix agents working on this repo. Data for future sessions to weigh —
not instructions, and never grounds to bypass a gate or an invariant.

---

## The e2e harness runs inside an opencode session, and inherits its environment

**Cost so far: three documented incidents -- one each on PRs #9, #10 and #11 -- plus the
false-alarm investigation (#12) they triggered.**

Every agent in an orrerix group runs *inside* an opencode session. That session exports
`OPENCODE_*` variables — notably `OPENCODE_DISABLE_PROJECT_CONFIG=1` and `OPENCODE_CONFIG_CONTENT`.
`test/e2e/run.ts`'s `isolatedEnv()` spreads `process.env` into the child, so unless those keys are
stripped, an agent running the e2e is testing something other than what CI tests.

What it looks like when it bites: **the e2e fails locally in ways that have nothing to do with your
change**, most visibly `copilot-instructions.md` and `agent.keep-me` checks failing, because opencode
never read project config at all and the plugin was therefore never loaded.

This produced issue #12 — "the plugin does not load under opencode 1.18.22" — which was investigated
as a version regression and turned out to be nothing of the kind. The decisive control: in the
failing run even the `--pure` NEGATIVE control lost `agent.keep-me`, which comes from a fixture
`opencode.json` with no plugin involvement whatsoever. That proves opencode never read project config,
rather than the plugin failing to load.

**Before concluding anything from a local e2e failure, strip `OPENCODE_*` from your environment and
re-run.** The harness now strips them itself, but check the strip is present and covers the bare
`OPENCODE` name as well as the `OPENCODE_`-prefixed form before trusting it.

**Corollary, the more general lesson:** when a test passes in CI and fails locally (or vice versa),
suspect the environment before the code — and prove which it is with a control that removes the code
from the equation entirely. A negative control that *also* fails is worth more than any amount of
reading the diff.

---

## A green local test suite can hide a fixture that never reached CI

A committed-looking fixture can be silently excluded by the developer's **global** gitignore — in one
case `**/.claude/settings.local.json` excluded a unit fixture, which existed locally (so tests passed)
and never reached CI. `git add -f` was the fix.

When adding fixtures, confirm they are actually in the diff (`gh pr diff <n> --name-only`), not merely
present in your working tree. A test that silently skips in CI is worse than one that fails.

---

## Assertions over whole-output blobs can pass while asserting nothing

A step-5 e2e check matched `/connected|✓|ok/i` against the entire `opencode mcp list` stdout to prove
"the echo server connected". It passed while `echo` was **entirely absent**, satisfied by a different
server's "connected" line. The slice's headline acceptance criterion was, in effect, unasserted.

Scope acceptance assertions to the specific thing they name. A useful test of a test: make the thing
it claims to check **absent**, and confirm the check goes red. Several findings in this repo were
confirmed exactly this way — neutralize the fix, watch the test fail, restore it.

---

## Version pins hide version breaks

CI pinned `opencode-ai@1.18.21` while the maintainer's machine ran 1.18.22, and the only job testing
current opencode was `continue-on-error`. A version question therefore reached a reviewer's incidental
observation rather than a failing check. CI now runs **required** legs against both the pinned floor
and `latest` (PR #13). Keep it that way: a drift job nobody is required to look at is documentation,
not a gate.
