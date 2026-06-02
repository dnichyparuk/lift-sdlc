# Execution Guardrails Sub-Flow

Sub-flow of `/setup-sdlc --execution-guardrails`. Runs skill/guardrails.js with `--target execute` to scan the project and generate execution-focused proposals, then lets the user review and select. Writes guardrails to `.sdlc/config.json` via lib/config.js.

## Arguments

| Flag | Description | Default |
|------|-------------|---------|
| `--add` | Expansion mode: propose only guardrails not already configured | off |

## Workflow

### Step 0 — Prepare

Run skill/guardrails.js:

```shell
<PLUGIN_ROOT>/skills/setup-sdlc/scripts/setup-execution-guardrails_prepare.sh
```

Replace `{init|add}` with `add` if `--add` was passed, otherwise `init`.

Parse JSON output. If `errors` non-empty, show errors and stop. Store `signals`, `proposals`, and `existing`.

If not in `--add` mode and `existing.count > 0`: Use AskUserQuestion: "N execution guardrails already configured. Replace all, or use --add to expand?" Options: replace / cancel. On cancel, stop.

### Step 1 (REVIEW) — Refine Script-Generated Proposals

The prepare script produced proposals with evidence from its template catalog. The LLM:

1. Reviews each proposal for project-specific accuracy
2. Checks if `claudeMdRules` from output suggest additional guardrails beyond the template catalog
3. May refine descriptions to be more specific based on `signals` data
4. Drops proposals that don't make sense despite matching a signal
5. Caps at 3–8 proposals

This is lightweight — reviewing and filtering for runtime code constraints, not generating from scratch.

### Step 2 (PRESENT) — Interactive Selection

Present refined proposals as a numbered list with evidence. Use AskUserQuestion:

> Install which execution guardrails?

Options:

- **all** — install all proposed guardrails
- **select** — comma-separated numbers to install a subset
- **custom** — prompt user for id, description, severity to add alongside selections
- **cancel** — exit without changes

On **custom**: collect id (validate kebab-case pattern `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`), description, severity (default: error). Allow multiple custom entries.

### Step 3 (WRITE) — Write Config

Write selected guardrails via inline Node.js using config library:

```shell
<PLUGIN_ROOT>/skills/setup-sdlc/scripts/setup-execution-guardrails_write.sh
```

Replace `<GUARDRAILS_JSON>` with the JSON array of selected guardrails. In `--add` mode: prepend existing guardrails from the prepare output to the array.

### Step 4 (VALIDATE) — Run Validation Script

```shell
<PLUGIN_ROOT>/skills/setup-sdlc/scripts/setup-execution-guardrails_validate.sh
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
- **Custom guardrails need ID validation.** The kebab-case pattern `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` must be enforced before writing.

## See Also

- [`/execute-plan-sdlc`](../execute-plan-sdlc/SKILL.md) — consumes execution guardrails during plan execution
- [`/setup-sdlc --execution-guardrails`](../SKILL.md) — parent skill that delegates execution guardrail setup to this sub-flow
- [`setup-guardrails.md`](./setup-guardrails.md) — plan guardrails analog
