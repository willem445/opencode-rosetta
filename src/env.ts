/**
 * Variable expansion shared by the MCP translators (B3/B9). Handles every
 * form the mapping tables name:
 *
 *   ${VAR}            -> ctx.env[VAR]; unset, no default -> left LITERAL + recorded
 *   ${VAR:-default}   -> env value; unset-or-empty -> default (shell semantics)
 *   ${env:VAR}        -> same as ${VAR} (VS Code syntax)
 *   ${input:id}       -> options.inputs[id] (itself expandable, e.g. {env:VAR})
 *                        then ROSETTA_INPUT_<ID> in the environment
 *                        then the artifact's own inputs[].default
 *                        unresolved everywhere -> left literal + id recorded
 *   ${workspaceFolder} -> ctx.worktree
 *   ${userHome}       -> ctx.home
 *
 * SECRETS ARE NEVER LOGGED: the outcome records variable *names* and input
 * *ids* only -- never an expanded value. Callers turn `unexpandedVars` /
 * `unresolvedInputs` into diagnostics; the values themselves exist only in
 * the returned string.
 */

export interface ExpandContext {
  worktree: string;
  home: string;
  /** The plugin's env view (`ctx.env`), never `process.env` read here. */
  env: Record<string, string | undefined>;
  /** Plugin options `inputs` map (B9 resolution layer 1). */
  inputs?: Record<string, string>;
  /**
   * Defaults from the translated artifact's own `inputs:` array
   * (.vscode/mcp.json), keyed by input id (B9 resolution layer 3).
   */
  inputDefaults?: Record<string, string>;
}

export interface ExpandOutcome {
  /** The expanded string (unresolvable references left literal inside it). */
  value: string;
  /** Names of env variables that were left literal (unset, no default). */
  unexpandedVars: string[];
  /** Ids of `${input:...}` references that resolved nowhere. */
  unresolvedInputs: string[];
}

/** `github-token` -> `ROSETTA_INPUT_GITHUB_TOKEN` (upper-cased, non-alnum -> `_`). */
export function rosettaInputEnvVar(id: string): string {
  return `ROSETTA_INPUT_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

const REF = /\$\{([^{}]*)\}/g;

function expandInputId(id: string, cx: ExpandContext): ExpandOutcome {
  // Layer 1: plugin options.inputs -- its value is itself expandable
  // ({env:VAR} per the README example, plus every ${...} form).
  const fromOptions = cx.inputs?.[id];
  if (fromOptions !== undefined) {
    const viaSingleBrace = fromOptions.replace(/\{env:([^{}]*)\}/g, (_m, name: string) =>
      cx.env[name] === undefined ? `{env:${name}}` : (cx.env[name] as string),
    );
    const inner = expandString(viaSingleBrace, { ...cx, inputs: {}, inputDefaults: {} });
    if (!inner.value.includes("{env:") && !inner.value.includes("${")) {
      return { value: inner.value, unexpandedVars: [], unresolvedInputs: [] };
    }
    // The option value itself referenced something unresolvable -- fall through
    // to later layers rather than emitting a broken value.
  }

  // Layer 2: ROSETTA_INPUT_<ID> in the environment.
  const fromEnv = cx.env[rosettaInputEnvVar(id)];
  if (fromEnv !== undefined && fromEnv !== "") {
    return { value: fromEnv, unexpandedVars: [], unresolvedInputs: [] };
  }

  // Layer 3: the artifact's own inputs[].default.
  const fromDefault = cx.inputDefaults?.[id];
  if (fromDefault !== undefined && fromDefault !== "") {
    return { value: fromDefault, unexpandedVars: [], unresolvedInputs: [] };
  }

  return { value: `\${input:${id}}`, unexpandedVars: [], unresolvedInputs: [id] };
}

function expandReference(inner: string, cx: ExpandContext): ExpandOutcome & { matched: boolean } {
  if (inner.startsWith("input:")) {
    return { ...expandInputId(inner.slice("input:".length), cx), matched: true };
  }

  let rest = inner;
  if (rest.startsWith("env:")) {
    rest = rest.slice("env:".length);
  } else if (rest === "workspaceFolder") {
    return { value: cx.worktree, unexpandedVars: [], unresolvedInputs: [], matched: true };
  } else if (rest === "userHome") {
    return { value: cx.home, unexpandedVars: [], unresolvedInputs: [], matched: true };
  }

  // ${VAR} / ${VAR:-default} / ${env:VAR}
  const sep = rest.indexOf(":-");
  const name = sep === -1 ? rest : rest.slice(0, sep);
  const hasDefault = sep !== -1;
  const fallback = hasDefault ? rest.slice(sep + 2) : undefined;

  if (name === "") return { value: `\${${inner}}`, unexpandedVars: [], unresolvedInputs: [], matched: false };

  const value = cx.env[name];
  if (value !== undefined && value !== "") {
    return { value, unexpandedVars: [], unresolvedInputs: [], matched: true };
  }
  if (hasDefault) {
    return { value: fallback ?? "", unexpandedVars: [], unresolvedInputs: [], matched: true };
  }
  // Missing, no default: Claude's documented behaviour is to leave the
  // reference literal (B3), in its original form; record only the NAME
  // for the warn diagnostic.
  return { value: `\${${inner}}`, unexpandedVars: [name], unresolvedInputs: [], matched: true };
}

/** Expand every `${...}` reference in `text`. Unresolvable refs stay literal. */
export function expandString(text: string, cx: ExpandContext): ExpandOutcome {
  let value = "";
  const unexpandedVars: string[] = [];
  const unresolvedInputs: string[] = [];
  let last = 0;

  for (const match of text.matchAll(REF)) {
    const inner = match[1] ?? "";
    value += text.slice(last, match.index);
    last = (match.index ?? 0) + match[0].length;
    const out = expandReference(inner, cx);
    value += out.value;
    unexpandedVars.push(...out.unexpandedVars);
    unresolvedInputs.push(...out.unresolvedInputs);
  }
  value += text.slice(last);

  return { value, unexpandedVars, unresolvedInputs };
}
