# Guardrails Sub-Flow

Sub-flow of `/setup-sdlc --guardrails`. Runs skill/guardrails.js to scan the project and generate proposals, then lets the user review and select. Writes guardrails to `.sdlc/config.json` via lib/config.js.

## Arguments

| Flag | Description | Default |
|------|-------------|---------|
| `--add` | Expansion mode: propose only guardrails not already configured | off |

## Workflow

### Step 0 — Prepare

Run skill/guardrails.js:

```shell
<PLUGIN_ROOT>/skills/setup-sdlc/scripts/setup-guardrails_prepare.sh
```

Replace `{init|add}` with `add` if `--add` was passed, otherwise `init`.

Parse JSON output. If `errors` non-empty, show errors and stop. Store `signals`, `proposals`, and `existing`.

If not in `--add` mode and `existing.count > 0`: Use AskUserQuestion: "N guardrails already configured. Replace all, or use --add to expand?" Options: replace / cancel. On cancel, stop.

### Step 1 (REVIEW) — Refine Script-Generated Proposals

The prepare script produced proposals with evidence from its template catalog. The LLM:

1. Reviews each proposal for project-specific accuracy
2. Checks if `claudeMdRules` from output suggest additional guardrails beyond the template catalog
3. May refine descriptions to be more specific based on `signals` data
4. Drops proposals that don't make sense despite matching a signal
5. Caps at 3–8 proposals

This is lightweight — reviewing and filtering, not generating from scratch.

### Step 2 (PRESENT) — Interactive Selection

Present refined proposals as a numbered list with evidence. Each proposal must display its `[category]` tag (implements R-#336-category). Format:

```
Proposed guardrails:
  1. [planning-discipline]  state-premise — Plan must state the underlying problem in one sentence
  2. [framework]            island-only-interactivity — Use island pattern for interactive components only
  3. [scope]                no-scope-creep — Implementation must stay within the task's stated scope
  ...
```

**Stage A — Standard selection**

Use AskUserQuestion:

> Install which guardrails?

Options:

- **all** — install all proposed guardrails
- **select** — comma-separated numbers to install a subset
- **cancel** — exit without changes (skips Stage B)

**Stage B — Custom guardrails (always-on, unless Stage A was cancelled)**

After Stage A completes (whether any standard guardrails were selected or not), always run this prompt. Use AskUserQuestion:

> Add custom project-specific guardrails?

Options: **yes** / **no**

On **yes**: enter per-guardrail ID/description/severity loop:
- Collect id (validate kebab-case pattern `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`)
- Collect description
- Collect severity (default: error)
- After each entry ask: "Add another custom guardrail?" yes/no — loop until no
Allow multiple custom entries. Custom guardrails are added alongside the standard selections from Stage A.

### Step 3 (WRITE) — Write Config

Write selected guardrails via inline Node.js using config library:

```shell
<PLUGIN_ROOT>/skills/setup-sdlc/scripts/setup-guardrails_write.sh
```

Replace `<GUARDRAILS_JSON>` with the JSON array of selected guardrails. In `--add` mode: prepend existing guardrails from the prepare output to the array.

### Step 4 (VALIDATE) — Run Validation Script

```shell
<PLUGIN_ROOT>/skills/setup-sdlc/scripts/setup-guardrails_validate.sh
```

Parse output. If `overall` is "pass", report success with count. If "fail", show errors and offer to fix.

## Do Not

- Run full-suite or wide-subset `promptfoo eval` automatically — single targeted test scoped to the change is allowed; tight-loop retries are not.
- Write config files using Write or Edit tools directly — always use lib/config.js via inline Node.js
- Skip AskUserQuestion for user interaction
- Scan the entire codebase — the prepare script handles scanning

## Gotchas

- **skill/guardrails.js is the source of truth for scanning.** Do not duplicate its Glob/Read logic. The skill reviews the script's output.
- **Config write is read-merge-write.** `writeSection` handles merging. In `--add` mode, the skill must read existing guardrails from the prepare output and prepend them to the selection before writing.
- **Stage B runs after any non-cancel Stage A outcome.** If the user selects all/select in Stage A with no custom entries expected, Stage B still runs — it is always-on. Only a Stage A cancel skips Stage B.
- **Custom guardrails need ID validation.** The kebab-case pattern `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` must be enforced in Stage B before writing.

## See Also

- [`/plan-sdlc`](../plan-sdlc/SKILL.md) — consumes guardrails during critique phases
- [`/setup-sdlc --guardrails`](../SKILL.md) — parent skill that delegates guardrail setup to this sub-flow
- [`/setup-sdlc --dimensions`](../SKILL.md) — analogous pattern for review dimensions
