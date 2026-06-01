---
name: ship-sdlc
description: "Use this skill when shipping a feature end-to-end after plan acceptance: executing, committing, reviewing, fixing critical issues, versioning, and opening a PR in one flow. Dispatches every sub-skill (including execute-plan-sdlc) as an Agent for context isolation, with structured return values driving the pipeline state machine. Arguments: [--auto] [--steps <csv>] [--quick] [--quality full|balanced|minimal] [--bump patch|minor|major|<label>] [--draft] [--dry-run] [--resume] [--init-config]. The `<label>` form for --bump (e.g. `--bump rc`) is forwarded to version-sdlc, where it is interpreted as `--bump patch --pre <label>`; labels must match `^[a-z][a-z0-9]*$`. Triggers on: ship it, ship this, full pipeline, execute to PR, ship feature, run the whole thing."
user-invocable: true
argument-hint: "[--auto] [--steps <csv>] [--quick] [--quality full|balanced|minimal] [--bump patch|minor|major|<label>] [--draft] [--dry-run] [--resume] [--workspace branch|worktree|prompt] [--branch | --tree] [--openspec-change <name>] [--init-config] [--gc] [--ttl-days <N>]"
model: gemini-3.5-flash
---

# Ship Pipeline

End-to-end feature shipping: execute plan, commit, review, fix critical issues, version, and open a PR. Chains six sub-skills sequentially with a conditional review-fix loop.

**Announce at start:** "I'm using ship-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

## Step 0 — Plan Mode Check

If the system context contains "Plan mode is active":

1. Locate `skill/ship.js` (same `find` pattern used in Step 1c below).
2. Invoke:
   ```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

SCRIPT="$SDLC_ROOT/scripts/skill/ship.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/ship.js. Is the sdlc plugin installed?" >&2; exit 2; }
   [ -z "$SCRIPT" ] && [ -f "plugins/sdlc-utilities/scripts/skill/ship.js" ] && SCRIPT="plugins/sdlc-utilities/scripts/skill/ship.js"
   [ -z "$SCRIPT" ] && { echo "ERROR: Could not locate skill/ship.js. Is the sdlc plugin installed?" >&2; exit 2; }
   PLAN_MODE_OUTPUT_FILE=$(node "$SCRIPT" --output-file --plan-mode-blocked $ARGUMENTS)
   PLAN_MODE_EXIT=$?
   echo "PLAN_MODE_OUTPUT_FILE=$PLAN_MODE_OUTPUT_FILE"
   echo "PLAN_MODE_EXIT=$PLAN_MODE_EXIT"
   
```
3. If `PLAN_MODE_EXIT` is non-zero: show any errors from the output file and stop.
4. Read the output JSON from `$PLAN_MODE_OUTPUT_FILE`. Confirm `planModeBlocked === true`. Extract `stateFile`, `flags.bump`, `flags.steps`.
5. Announce:
   > Plan mode is active. ship-sdlc requires write operations (git commit, gh pr create, git tag) and cannot run inside plan mode.
   >
   > **Pipeline state saved to `<stateFile>` with resolved flags:** bump=`<flags.bump>`, steps=`<flags.steps>`.
   >
   > Exit plan mode and re-invoke `/ship-sdlc` (no args needed) — the existing implicit-resume mechanism will pick up the saved state and resume from the first pending step with the originally-resolved flags intact.
6. Run `rm -f "$PLAN_MODE_OUTPUT_FILE"` to clean up the temp output file.
7. Stop. Do not proceed to subsequent steps.

All gates in steps 3–5 cite resolved fields from prepare output (`planModeBlocked`, `stateFile`, `flags.bump`, `flags.steps`) — never re-parse `$ARGUMENTS` directly.

---

## Step 1 (CONSUME): Load Config, Parse Flags, Detect Context

### 1a. --init-config handler

If `--init-config` was passed:

**Redirect:** Suggest running `/setup-sdlc` instead for unified configuration. If user insists on `--init-config`, proceed with the existing walkthrough.

1. Read `./config-format.md` and run the interactive walkthrough to collect the user's answers (steps multi-select, bump type, auto, threshold, workspace isolation).
   After the `steps[]` selection, offer the optional `--quick` profile prompt (R-quick-7):
   > "Would you like to define a `--quick` profile? Select steps that form your shortened pipeline, or skip to omit."
   If the user selects steps, capture them. If the user skips, omit the `--quick` flag when calling `ship-init.js`.
2. Locate and call `ship-init.js` via Bash with the collected answers (append `--quick <csv>` only when the user made a quick-profile selection):
```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

SCRIPT="$SDLC_ROOT/scripts/skill/ship-init.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/ship-init.js. Is the sdlc plugin installed?" >&2; exit 2; }

INIT_OUTPUT_FILE=$(node "$SCRIPT" --output-file --steps execute,commit,review,archive-openspec,pr --bump patch --auto --threshold high --workspace prompt)
EXIT_CODE=$?
echo "INIT_OUTPUT_FILE=$INIT_OUTPUT_FILE"
echo "EXIT_CODE=$EXIT_CODE"
# Single canonical cleanup: trap fires unconditionally on EXIT/INT/TERM.
trap 'rm -f "$INIT_OUTPUT_FILE"' EXIT INT TERM

```
3. Parse the output JSON from `$INIT_OUTPUT_FILE`:
   - If `errors` is non-empty, display them and stop.
   - Otherwise display the `created` files list and `config` JSON for user confirmation.
4. Stop. No pipeline execution.

### 1a-gc. --gc handler (R39, issue #223)

If `--gc` (with optional `--ttl-days <N>`) was passed, run `skill/ship.js --gc` and stop — no pipeline composition. The prepare script short-circuits: it scans `<main-worktree>/.sdlc/execution/` for stale ship- and execute- state files (older than TTL AND whose branch is no longer in `git branch --list`), removes them, and emits a JSON report.

```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

SCRIPT="$SDLC_ROOT/scripts/skill/ship.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/ship.js. Is the sdlc plugin installed?" >&2; exit 2; }
[ -z "$SCRIPT" ] && [ -f "plugins/sdlc-utilities/scripts/skill/ship.js" ] && SCRIPT="plugins/sdlc-utilities/scripts/skill/ship.js"
PREPARE_OUTPUT_FILE=$(node "$SCRIPT" --output-file --gc)  # add --ttl-days <N> when provided
trap 'rm -f "$PREPARE_OUTPUT_FILE"' EXIT INT TERM

```

Read the prepare output. The top-level `action` field will be `"gc"`; the `report` field contains `{ttlDays, ship: {deleted, kept}, execute: {deleted, kept}}`.

Print one line per file:
```
[deleted] ship-deletedbranch-20240101T000000Z.json — stale+branch-gone
[kept]    ship-main-20260505T120000Z.json — ttl-fresh
```

Then stop. Do not proceed to step 1b. The pipeline does not run.

### 1b. Load ship config

**Hook context fast-path:** If the session-start system-reminder contains a `Ship config:` line, note it for display. The prepare script (`skill/ship.js`) remains the authoritative source for config values — the hook line is a user-facing heads-up, not a data source.

Check for ship config via skill/ship.js output (reads from `.sdlc/local.json` → `ship` section, with legacy `.sdlc/ship-config.json` fallback). If found, read and merge. Print loaded config verbosely:
```
Ship config loaded from .sdlc/local.json (schema v2)
  steps: [execute, commit, review, archive-openspec, pr], draft: false, bump: patch
  reviewThreshold: high
  execute.commitWaves: false
```

The `execute.commitWaves` field (Fixes #392 / R35) controls per-wave WIP commits during the execute step. Default `false`. When set to `true` in ship config, `--commit-waves` is appended to the execute step's invocation; the execute-plan-sdlc skill then runs `git add -A && git commit -m "wip(execute): wave N — <titles>"` after each wave's G9 + G11 pass. The subsequent commit step (commit-sdlc) detects the `wip(execute):` commits since fork-point and squashes them via soft-reset into the final feature commit, so the user-facing PR history is unchanged. Resolution is centralized in `scripts/skill/ship.js` (per `scripts-over-llm-logic` and `flag-coherence-cross-skill` guardrails) — SKILL.md cites `step.invocation`, never raw `config.execute.commitWaves`.
If not found: `No ship config found — using built-in defaults. Run /setup-sdlc to configure.`

**Legacy v1 auto-migration:** If the loader detects a v1 config (no top-level `version`, with `ship.preset` or `ship.skip`), it migrates in place to schema v2 and emits a single stderr deprecation notice. The migrated shape (`ship.steps[]`) is what subsequent steps consume.

### 1c. Prepare pipeline context

Locate and run `skill/ship.js` with all CLI flags to pre-compute flags, context, and step statuses:
```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

SCRIPT="$SDLC_ROOT/scripts/skill/ship.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/ship.js. Is the sdlc plugin installed?" >&2; exit 2; }

<!-- Implements A8d. Fixes #371. Workspace mode is intentionally omitted from this example so it falls back to `ship.workspace` config via `mergeFlags`; literal `--workspace <value>` here would override user config. -->
PREPARE_OUTPUT_FILE=$(node "$SCRIPT" --output-file --has-plan --auto)
# --bump is forwarded only when the user passes it; ship-prepare resolves bump from
# config (version.preRelease) or default (patch) otherwise. Passing --bump here would
# unconditionally override config, preventing pre-release trains from working (#394).
# Workspace mode comes from `.sdlc/local.json` (`ship.workspace`) via config fallback.
# Only pass `--workspace`, `--branch`, or `--tree` to override for a single run.
# Example override: node "$SCRIPT" --output-file --has-plan --auto --tree
# Pipeline composition (which steps run) comes from config `ship.steps[]`. To override
# the resolved step list for a single run, pass `--steps <csv>` (e.g.
# `--steps execute,commit,pr`). To set the model tier forwarded to execute-plan-sdlc,
# pass `--quality <full|balanced|minimal>` — only forwarded when explicitly passed.
# Legacy `--preset` and `--skip` are hard-removed (#190) and produce errors.
# The config-level field is `steps[]` (top-level `schemaVersion: 4`); preset/skip are no longer persisted.
#
# Hook signal — R-implicit-resume (#359):
# If the session-start system-reminder contains a line matching
# `/^Active pipeline: ship-sdlc/`, ALSO append `--hook-active-pipeline` to the
# invocation above. The prepare script then inspects the ship state file for the
# current branch and, when found+fresh, sets flags.implicitResume=true AND
# flags.resume=true so subsequent steps treat this run as a resume without
# requiring the user to type --resume. When no state file is found, prepare
# emits errors[*].id === "implicitResumeNoState" (handled in Step 1e).
EXIT_CODE=$?
echo "PREPARE_OUTPUT_FILE=$PREPARE_OUTPUT_FILE"
echo "EXIT_CODE=$EXIT_CODE"
# Single canonical cleanup: trap fires unconditionally on EXIT/INT/TERM, so the
# manifest is removed even if any pipeline step errors out, an Agent dispatch
# crashes, or the user cancels. The 1a INIT trap (if previously set) is
# replaced — the --init-config path exits before reaching 1c, so there is no
# overlap in runtime lifecycle between the two manifest variables.
trap 'rm -f "$PREPARE_OUTPUT_FILE"' EXIT INT TERM

```

Parse the output JSON from `$PREPARE_OUTPUT_FILE`. If `errors` is non-empty, display them and stop. The parsed output replaces manual computation in subsequent sub-steps (1d–1g).

**Context-heaviness advisory (implements R35):** If the parsed output's top-level `contextAdvisory` field is a non-empty string, print it verbatim before continuing. The advisory recommends `/compact` and notes that pipeline state is preserved across compaction (PreCompact + SessionStart hooks). Sourced from `$TMPDIR/sdlc-context-stats.json`, written by the `UserPromptSubmit` hook (`hooks/context-stats.js`); helper at `scripts/lib/context-advisory.js`. When `contextAdvisory` is `null`, emit nothing.

**Gitignore warning:** If `context.sdlcGitignored` is `false` in the output, print:
```
⚠ Warning: .sdlc/ is not gitignored. Run --init-config to fix, or manually create .sdlc/.gitignore:
  printf '*\n' > .sdlc/.gitignore
```

### 1d. Parse flags

Print the `flags` object from the `skill/ship.js` output, including the `sources` map showing where each value came from (CLI, config, or default):
```
Flag resolution (from skill/ship.js):
  auto:    true  (source: cli)
  steps:   [execute, commit, review, archive-openspec, pr]  (source: config)
  preset:  balanced  (source: cli, legacy sugar; expanded to steps)
  bump:    patch (source: default)
  draft:   false (source: default)
```

### 1e. Resume check

**Hook context fast-path:** If the session-start system-reminder contains an `Active pipeline:` line, note the state file path and resume point. When the user does not pass `--resume` explicitly but the hook reported an active pipeline, the Step 1c invocation already appended `--hook-active-pipeline` (see comment above). The prepare script then either sets `flags.implicitResume === true` (state file found and fresh) or returns `errors[*].id === "implicitResumeNoState"` (state file missing). The LLM does NOT scan the filesystem — `skill/ship.js` is authoritative.

Print `resume.found` and `resume.stateFile` from the `skill/ship.js` output. If `resume.found` is `true`, print the state file path and resume point. If `false`, print that no state file was found and the pipeline will start fresh.

**Implicit-resume banner (R-implicit-resume, #359):** When `flags.implicitResume === true` in the prepare output, print the following banner verbatim BEFORE the pipeline table (Step 2). Source `<nextPendingStep>` from `resume.nextPendingStep` (provided by `detectResumeState()` in lib/state.js) and source the step lists from the state file at `resume.stateFile`:

```
Resuming after compaction from step <nextPendingStep>.
Completed: <comma-separated step names where status === "completed">.
Pending:   <comma-separated step names where status !== "completed" && status !== "skipped">.
```

Note: the banner check gates on `flags.implicitResume`, NOT `flags.resume`. The prepare script auto-sets `flags.resume = true` when `flags.implicitResume === true` so the rest of the pipeline (e.g. Step 5's execute resume forwarding) sees a unified `flags.resume` regardless of whether the user typed `--resume` or the hook triggered it.

**Missing-state prompt (R-implicit-resume):** If the prepare output's `errors` array contains an entry with `id === "implicitResumeNoState"`, use AskUserQuestion:

> Active pipeline reminder found but no state file for current branch. Start fresh, or specify a state path?

Options:
- **fresh** — re-invoke `skill/ship.js` without `--hook-active-pipeline` so the pipeline starts cleanly
- **path** — ask the user for an explicit state file path, then re-invoke with `--state-file <path>`
- **abort** — exit cleanly without dispatching any step

Read `./state-format.md` when resuming from a state file.

### 1f. Context detection

Print the `context` object values from the `skill/ship.js` output:
```
Context detection (from skill/ship.js):
  Plan in context:     yes
  Uncommitted changes: 14 files modified
  Current branch:      feat/ship-sdlc
  Default branch:      main
  gh CLI:              authenticated as <user>
  OpenSpec:            not detected
  .sdlc/ gitignored:   yes
```

**Contradictory-signal override (implements R21):** After printing the context detection block, IF `context.openspecAuthoritative.path` is set AND the current session-start `<system-reminder>` contains a line matching `/openspec.*not initialized|not initialized.*openspec/i`, print exactly one line:
`Ignoring contradictory 'not initialized' signal in session context — openspec/config.yaml exists (authoritative source: SDLC's own check via ship.js prepare output).`
Then continue the flow. If the contradictory phrase is absent, emit nothing.

### 1g. Auto-skip logic

Print each step from the `steps` array in the `skill/ship.js` output with its `status`, `reason`, and `skipSource`:
```
Auto-skip decisions (from skill/ship.js):
  execute: will_run — plan detected in context
  commit:  will_run — uncommitted changes detected
  review:  will_run — not in skip set
  received-review: conditional — depends on review verdict
  commit (fixes): conditional — depends on received-review changes
  version: skipped (auto) — auto-skipped — tags are repo-global
  archive-openspec: conditional — openspec change ready for archive
  pr:      will_run — not in skip set
```

The parenthetical after `skipped` reflects the step's `skipSource` field:
- `(cli)` — user passed `--steps` on the command line
- `(quick)` — step is canonical but absent from `ship.quick` under an active `--quick` run (R-quick-4); `flags.sources.steps === 'quick'` in the prepare output
- `(config)` — skip set loaded from `.sdlc/local.json`
- `(auto)` — auto-skipped by `computeSteps` logic (e.g., worktree mode)
- `(condition)` — conditional step whose condition was not met

Steps with `skipSource: "none"` are not skipped and show no parenthetical.

The LLM does not compute these statuses — `skill/ship.js` is the source of truth.

---

## Step 2 (PLAN): Build Pipeline Plan

The pipeline table is generated from the `steps` array in the `skill/ship.js` output. Each row maps:
- Step number: array index + 1
- Skill: `step.skill`
- Status: `step.status`
- Args: `step.args`
- Pause: `step.pause ? 'YES' : 'no'`

| Step | Skill | Status | Args | Pause |
|------|-------|--------|------|-------|
| 1 | execute-plan-sdlc | will_run | (none, or `--quality <X>` if user passed `--quality` to ship) | no |
| 2 | commit-sdlc | will_run | `--auto` | no |
| 3 | review-sdlc | will_run | `--committed` | no |
| 4 | received-review-sdlc | conditional | (if crit/high) | YES |
| 5 | commit-sdlc (fixes) | conditional | `--auto` | no |
| 6 | version-sdlc | skipped | — | — |
| 7 | pr-sdlc | will_run | `--auto --draft` | no |
| 7a | verify-pipeline (inline, opt-in) | conditional on `'verify-pipeline' ∈ flags.steps` | `--timeout <N> --interval <N>` | YES on failure (interactive) |
| 7b | await-remote-review (inline, opt-in) | conditional on `'await-remote-review' ∈ flags.steps` | `--timeout <N> --interval <N> --reviewers <csv>` | no |
| 8 | learnings-commit | will_run | (none — inline shell, see "After pr — learnings-commit" below) | no |

### --auto Mode Audit

Not all sub-skills support `--auto`. This table is the source of truth:

| Sub-skill | --auto support | Behavior when ship runs with --auto |
|-----------|---------------|--------------------------------------|
| execute-plan-sdlc | No | Forwards `--quality <X>` only when the user explicitly passed `--quality` to ship; otherwise no quality flag is forwarded and execute-plan-sdlc applies its own selection logic. (Renamed from `--preset` in #190 to disambiguate from ship's step-selection semantics.) |
| commit-sdlc | Yes | `--auto` forwarded. Skips commit approval prompt. |
| review-sdlc | No | No interactive prompts to skip — runs fully automatically already. |
| received-review-sdlc | Yes | `--auto` forwarded. Skips Step 10 consent prompt and Step 12 reply/resolve prompt. Critique gates and verification still run. Only "will fix" items auto-implemented; threads for "will fix" items auto-resolved. |
| version-sdlc | Yes | `--auto` forwarded. Skips release plan approval prompt. Pre-condition checks and critique gates still run. |
| pr-sdlc | Yes | `--auto` forwarded. Skips PR approval prompt. |

### Review verdict conditional logic

After review-sdlc completes, parse the conversation for a `Verdict:` line. The verdict label (`CHANGES REQUESTED` / `APPROVED WITH NOTES` / `APPROVED`) is **display-only** — it is included in the run banner but does NOT gate dispatch. Dispatch is gated exclusively by `flags.reviewThreshold` (resolved by `scripts/skill/ship.js`):

| `flags.reviewThreshold` | Dispatch received-review-sdlc when findings include …            |
|-------------------------|-------------------------------------------------------------------|
| `critical`              | any critical                                                      |
| `high`                  | any critical OR high                                              |
| `medium`                | any critical OR high OR medium                                    |
| `low`                   | any finding except `info`                                         |

If the threshold is met → invoke received-review-sdlc (forward `"--auto"` when `flags.auto`).
Otherwise → collect findings and defer to the pipeline summary report.

Example run-banner lines (display-only — do NOT control dispatch):
```
Review verdict: CHANGES REQUESTED (1 critical, 2 high)
Review verdict: APPROVED WITH NOTES (3 medium, 1 low)
Review verdict: APPROVED
```

In `--auto` mode, dispatch is automatic and `received-review-sdlc --auto` is forwarded — no interactive pause.

---

## Step 3 (CRITIQUE): Validate Pipeline

Print each validation check:
```
Pipeline validation:
  [pass] gh CLI authenticated
  [pass] Not on default branch (feat/ship-sdlc)
  [pass] 5 of 7 steps will run
  [pass] All skip values recognized
  [pass] Version step supports --auto (release approval prompt skipped in auto mode)
  [warn] If review finds critical/high issues, pipeline will pause for fix approval
```

Validation checks:
- `gh auth status` succeeds
- Current branch is not the default branch (warn if it is — do not block)
- All `--steps` values are recognized step names: `execute`, `commit`, `review`, `version`, `archive-openspec`, `pr`, `learnings-commit`
- When `flags.sources.steps === 'quick'` in the prepare output, verify that `flags.steps` is non-empty (R-quick-6 error would have fired if `ship.quick` was missing — non-empty confirms the quick profile resolved correctly). Cite `flags.sources.steps`, NOT raw `--quick` or `$ARGUMENTS`, at all decision sites (R-quick-2, R-quick-3).
- `--quick` and `--steps` are mutually exclusive — R-quick-5 error fires if both are present; surface from `errors[]` in prepare output, not re-checked independently.
- At least one step will run
- Flag combinations are coherent (`--bump` without version step → warn). `--bump` accepts `major|minor|patch` or any pre-release label matching `^[a-z][a-z0-9]*$` (e.g. `--bump rc` ships an RC release; the label is forwarded verbatim to version-sdlc).

---

## Step 4 (DO): Present Pipeline and Confirm

### Dry-run mode

If `--dry-run`, display the full pipeline table and stop:
```
Ship Pipeline (dry run)
────────────────────────────────────────────────────────────────
Step  Skill                 Status       Args              Pause?
────────────────────────────────────────────────────────────────
1     execute-plan-sdlc     will run     (none)             no
2     commit-sdlc           will run     --auto            no
3     review-sdlc           will run     --committed       no
4     received-review-sdlc  conditional  (if crit/high)    YES
5     commit-sdlc (fixes)   conditional  --auto            no
6     version-sdlc          skipped      —                 —
7     pr-sdlc               will run     --auto --draft    no
────────────────────────────────────────────────────────────────
Review threshold: critical or high findings trigger fix loop
Interactive pauses: received-review (if triggered)
```

### Auto mode

Display the pipeline table for visibility, then proceed without prompting.

### Interactive mode

Display the pipeline table, then:

Use AskUserQuestion to ask:
> Run this pipeline?

Options:
- **yes** — execute as shown
- **edit** — change steps, flags, or other config
- **cancel** — stop here

On **edit**: ask what to change, update flags, rebuild the pipeline table, and re-present. Loop until `yes` or `cancel`.

---

## Step 5 (EXECUTE): Run Pipeline Steps Sequentially

### Pre-step validation

Before dispatching each step, read its `status` from the skill/ship.js output:
1. `"will_run"` → dispatch via Agent tool. Inline-executed steps (`skill === null`, `dispatchMode: null`) are not dispatched via a tool — they are handled directly in main context (either as Bash commands or as conditional logic such as parsing a JSON verdict, as specified per-step). This is non-negotiable.
2. `"conditional"` → evaluate the runtime condition (e.g., review verdict). If condition met → dispatch via Agent tool. If not → print why with the specific condition that was not met.
3. `"skipped"` → print "skipped" with the `reason` and `skipSource` from the script output.

A step with `status: "will_run"` MUST be dispatched per its `dispatchMode`. The LLM does not have authority to override `dispatchMode` or skip a `will_run` step. Printing a skip message for a "will_run" step is a pipeline violation.

### Context budget — dispatch isolation

All sub-skills are Agent-dispatched for context isolation: each Agent loads its SKILL.md in its own context and returns only a structured result (5–10 lines). The ship pipeline's context receives structured data, not sub-skill definitions.

`execute-plan-sdlc` is the orchestrator and returns a Step-9-formatted result (waves completed, files modified, state file path) for ship's main-context loop to consume. Agent dispatch restores pipeline continuity by returning control to ship-sdlc after execute completes, enabling R37 branch migration, the staging window, and remaining steps. (Fixes #366.)

### Dispatch protocol

**Invocation source:** Each step in the skill/ship.js output includes an `invocation` field containing the skill name and computed args. Use `step.invocation` verbatim — do not construct invocations from the examples below.

For each step that will run, apply the dispatch protocol based on `step.dispatchMode`:

---

#### When `step.dispatchMode === 'agent'` — Agent-tool dispatch (all sub-skills)

1. **Print verbose progress header** to user:
   ```
   ━━━ Ship Pipeline — Step 2/7: Commit ━━━
     Skill: commit-sdlc
     Args: --auto
     Reason: --auto forwarded from ship --auto mode
   ```

2. **Record step start** via state/ship.js.

3. **Dispatch Agent** with: skill name, args from `step.invocation`, model from `step.model`, and brief pipeline context (branch, previous step results needed for this step). Pass `model: step.model` to the Agent tool on every dispatch. When `step.isolation` is non-null, additionally pass `isolation: step.isolation`; when `step.isolation` is null, omit the `isolation` parameter entirely (the Agent tool schema does not accept `null` for `isolation`). The LLM must not add, remove, or change the `isolation` parameter from what `ship.js` computed (implements R-agent-isolation-script-driven, C15). Agent prompt template:
   ```
   You are executing the <skill-name> skill. Invoke `/<skill-name> <args>` using the Skill tool — this loads the SKILL.md automatically. Return a structured result:
   (1) status — success or failure
   (2) result summary — 2-3 lines
   (3) artifacts — commit hash, tag, PR URL, verdict, etc.
   (4) any warnings or issues encountered
   ```

4. **Receive agent result.** Print result to user:
   ```
     [done] Step 2 complete: a1b2c3d feat(auth): add OAuth2 PKCE flow
     State saved to .sdlc/execution/ship-<branch>-<timestamp>.json
   ```

5. **Record step completion/failure** via state/ship.js.

6. **Use result to determine next step** (e.g., review verdict → received-review decision). Print decision reasoning:
   ```
     Review verdict: APPROVED WITH NOTES (2 medium)
     Decision: CONTINUING — no critical/high issues found
   ```

---

Ship-sdlc retains full control of: pipeline table display, validation output, step progress headers, result formatting, state persistence messages, verdict-based flow decisions, and the final summary report. Sub-skills only execute their skill and return structured data — they do not print pipeline-level output.

### Main-thread TodoWrite orchestration (R-todowrite-visibility, #427)

ship-sdlc surfaces live pipeline progress in the Claude Code task tray via main-thread `TodoWrite` calls. All derivation logic lives in `scripts/lib/ship-todos.js` (R-todowrite-visibility clause 11). The MAIN thread invokes the helper via Bash and passes the returned `todos[]` array to the `TodoWrite` tool. The helper's `marker` field is echoed verbatim to stdout (audit trail when the tray is hidden).

**Helper resolution (run once at Step 5 entry):**

```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

SHIP_TODOS="$SDLC_ROOT/scripts/skill/ship-todos.js"
[ ! -f "$SHIP_TODOS" ] && { echo "ERROR: Could not locate scripts/skill/ship-todos.js. Is the sdlc plugin installed?" >&2; exit 2; }

```

**Setup (one-time, BEFORE the Step 5 dispatch loop, only when `flags.steps.length >= 2`):**

1. Run: `node "$SHIP_TODOS" --state-file "$STATE_FILE" --event init` (where `$STATE_FILE` is the resolved ship state file path from Step 1c output).
2. Parse JSON from stdout. Call `TodoWrite` with `todos` array.
3. Echo `marker` verbatim to stdout.

For ultra-short runs (`flags.steps.length < 2`), skip TodoWrite entirely.

**Per-step transition (called at start of EACH Step 5 iteration, BEFORE the verbose progress header):**

1. Run: `node "$SHIP_TODOS" --state-file "$STATE_FILE" --event step --current-step <stepName>`.
2. Parse JSON, call `TodoWrite`, echo `marker`.

**Per-step completion (called AFTER the Agent return and result print, AFTER `state/ship.js complete` records success):**

<!-- Ordering required: `state/ship.js complete` must persist status=completed BEFORE this call;
     ship-todos reads the state file to derive substep statuses, so completion must be on disk first. -->
1. Run: `node "$SHIP_TODOS" --state-file "$STATE_FILE" --event step --current-step <stepName> --mark-completed <stepName>`.
2. Parse JSON, call `TodoWrite`, echo `marker`.

**Per-step failure (called when `state/ship.js fail` records a failure):**

1. Run: `node "$SHIP_TODOS" --state-file "$STATE_FILE" --event step --current-step <stepName> --fail-step <stepName>`.
2. Parse JSON, call `TodoWrite`, echo `marker`.
3. No todo lingers in_progress (helper enforces — AC4).

**Resume reconstruction (called inside the existing implicit-resume banner block, BEFORE the pipeline table prints, when `flags.resume === true`):**

1. Run: `node "$SHIP_TODOS" --state-file "$STATE_FILE" --event resume --current-step <resume.nextPendingStep>`.
2. Parse JSON, call `TodoWrite`, echo `marker`.

`flags.resume === true` is the single gate (the prepare script unifies explicit `--resume` and `flags.implicitResume`; this matches the existing implicit-resume banner condition and satisfies `no-opposite-logical-vectors`).

**Cross-skill note:** `execute-plan-sdlc`'s internal per-wave `TodoWrite` calls remain (Agent-context bookkeeping). They are NOT parent-visible — see `execute-plan-sdlc/SKILL.md` Progress signal section and `R-todowrite-visibility`, issue #427.

### Workspace-mode resolution and default-branch guard (R61, R62 — fixes #378)

**Skip on resume re-entry** (`flags.resume === true`) — the resume block below already handled mode/cwd.

When NOT resuming, resolve workspace mode and enforce the default-branch guard before any workspace creation:

```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

# Resolve SDLC_LIB once — used by all subsequent node -e heredocs in this section.
SDLC_LIB="$SDLC_ROOT/scripts/skill/config.js"
[ ! -f "$SDLC_LIB" ] && { echo "ERROR: Could not locate scripts/skill/config.js. Is the sdlc plugin installed?" >&2; exit 2; }

# R61: Resolve workspace mode — flag → config → fail-fast. No interactive prompt.
if [ -z "$WORKSPACE_MODE_FLAG" ]; then
  WORKSPACE_MODE=$(node -e "
    const {readSection,resolveSdlcRoot}=require('$SDLC_LIB/config');
    const ws=readSection(resolveSdlcRoot(),'workspace')||{};
    process.stdout.write(ws.mode||'');
  ")
else
  WORKSPACE_MODE="$WORKSPACE_MODE_FLAG"
fi
if [ -z "$WORKSPACE_MODE" ]; then
  echo "Error: workspace mode not set. Pass --workspace branch|worktree|continue or set workspace.mode in .sdlc/local.json." >&2
  exit 1
fi

# R62: Default-branch guard — reject --workspace continue on the repo default branch.
DEFAULT_BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
[ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH="main"
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" = "$DEFAULT_BRANCH" ] && [ "$WORKSPACE_MODE" = "continue" ]; then
  echo "Error: cannot ship on default branch '$DEFAULT_BRANCH'. Pass --workspace branch or --workspace worktree." >&2
  exit 1
fi

```

`WORKSPACE_MODE_FLAG` is set from the `--workspace` CLI flag parsed by the prepare script. `SDLC_LIB` is the directory containing `config.js` and `branch-name.js`, resolved via the standard plugin path search above (or the in-repo fallback when developing this plugin). The variable persists across all subsequent Bash invocations in this section.

### Cwd-assertion diagnostic (R65 — fixes #405)

Before any branch creation, state migration, or Agent dispatch, consume the `assertions` field from the prepare output and verify the current working directory is the main worktree root when workspace mode is `branch`. This is a diagnostic gate — it aborts the pipeline with a four-field diagnostic so the failure mode (ship-sdlc launched from inside a stale linked worktree under `workspace: branch`) surfaces with structured evidence on next reproduction.

**Skip when resuming** (`flags.resume === true`) and when workspace mode is `worktree` or `continue` — the prepare script emits `assertions.requireMainWorktreeCwd: false` in those cases, so the assertion is a no-op below.

```bash
# Read assertions from prepare output. Path is passed via env var (F) so that
# embedded quotes/backslashes in the temp path cannot break the inline JS.
REQUIRE_MAIN_CWD=$(F="$PREPARE_OUTPUT_FILE" node -e "const d=JSON.parse(require('fs').readFileSync(process.env.F,'utf8'));process.stdout.write(String((d.assertions&&d.assertions.requireMainWorktreeCwd)===true))")
EXPECTED_ROOT=$(F="$PREPARE_OUTPUT_FILE" node -e "const d=JSON.parse(require('fs').readFileSync(process.env.F,'utf8'));process.stdout.write((d.assertions&&d.assertions.expectedMainWorktreeRoot)||'')")

if [ "$REQUIRE_MAIN_CWD" = "true" ] && [ -n "$EXPECTED_ROOT" ]; then
  ACTUAL_CWD=$(git rev-parse --show-toplevel 2>/dev/null)
  if [ "$ACTUAL_CWD" != "$EXPECTED_ROOT" ]; then
    echo "ERROR: ship-sdlc cwd assertion failed (R65, #405)." >&2
    echo "  actual cwd:    $ACTUAL_CWD" >&2
    echo "  expected root: $EXPECTED_ROOT" >&2
    echo "  ship.workspace: $WORKSPACE_MODE" >&2
    echo "  git worktree list --porcelain:" >&2
    git worktree list --porcelain | sed 's/^/    /' >&2
    echo "" >&2
    echo "ship-sdlc was launched from inside a linked worktree but workspace mode is 'branch'." >&2
    echo "Re-run from the main worktree root, or pass --workspace worktree." >&2
    exit 1
  fi
fi
```

The assertion runs unconditionally on every non-resume invocation — when `REQUIRE_MAIN_CWD` is `false` (worktree/continue modes or resume re-entry) the inner block is skipped. `$WORKSPACE_MODE` is already resolved from the section above.

### Pre-execute workspace isolation (R60, R37 — fixes #378, #379)

**Skip when `WORKSPACE_MODE = continue` or when resuming** — no isolation setup needed.

When not resuming and `WORKSPACE_MODE` is `branch` or `worktree`, run the five-step skeleton before dispatching execute-plan-sdlc. This is the single workspace-creation site for the entire pipeline (implements spec I8, R60):

```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

# Step 1: Derive branch name from plan title via lib/branch-name.js (config-driven).
#   Reads workspace.branch config (template, slugMaxLength, typeMap) via readSection.
#   Same helper used by execute-plan-sdlc standalone path — no duplication.
EXECUTE_BRANCH=$(node -e "
  const {resolveBranchName}=require('$SDLC_LIB/branch-name');
  const {readSection,resolveSdlcRoot}=require('$SDLC_LIB/config');
  const cfg=(readSection(resolveSdlcRoot(),'workspace')||{}).branch||{};
  // Logical type and slug derived from plan title (feature/bugfix/chore/docs/refactor).
  // typeMap in config maps logical → branch prefix (defaults: feat/fix/chore/docs/refactor).
  process.stdout.write(resolveBranchName({type:'<logical-type>',slug:'<derived-slug>',config:cfg}));
")

# Step 2: Pre-execute ship state migration (R37).
#   Runs in main worktree cwd — state/ship.js read still resolves OLD slug filename here.
#   BEFORE any branch creation (fixing #379: old post-execute block ran after cwd changed).
STATE_BRANCH=$(node "$SCRIPT" read 2>/dev/null | node -e "process.stdin.on('data',d=>{try{process.stdout.write(JSON.parse(d).branch||'')}catch(_){}})")
if [ -n "$STATE_BRANCH" ] && [ "$EXECUTE_BRANCH" != "$STATE_BRANCH" ]; then
  FROM_SLUG=$(echo "$STATE_BRANCH" | sed 's|[^a-zA-Z0-9-]|-|g')
  result=$(node "$SCRIPT" migrate --from "$FROM_SLUG" --to "$EXECUTE_BRANCH" 2>&1)
  echo "State migrated: $FROM_SLUG → $EXECUTE_BRANCH"
fi

# Step 3a: --workspace branch — simple git checkout, no cd needed (HEAD shared with main worktree).
if [ "$WORKSPACE_MODE" = "branch" ]; then
  git checkout -b "$EXECUTE_BRANCH"
fi

# Step 3b: --workspace worktree — create worktree+branch, cd in main shell.
if [ "$WORKSPACE_MODE" = "worktree" ]; then
WORKTREE_CREATE_SCRIPT="$SDLC_ROOT/scripts/util/worktree-create.js"
[ ! -f "$WORKTREE_CREATE_SCRIPT" ] && { echo "ERROR: Could not locate scripts/util/worktree-create.js. Is the sdlc plugin installed?" >&2; exit 2; }
  [ -z "$WORKTREE_CREATE_SCRIPT" ] && [ -f "plugins/sdlc-utilities/scripts/util/worktree-create.js" ] && WORKTREE_CREATE_SCRIPT="plugins/sdlc-utilities/scripts/util/worktree-create.js"
  [ -z "$WORKTREE_CREATE_SCRIPT" ] && { echo "ERROR: Could not locate scripts/util/worktree-create.js. Is the sdlc plugin installed?" >&2; exit 2; }
  result=$(node "$WORKTREE_CREATE_SCRIPT" --name "$EXECUTE_BRANCH")
  WORKTREE_PATH=$(echo "$result" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).path)")
  # worktree-create.js may collision-suffix; use the resolved branch name.
  EXECUTE_BRANCH=$(echo "$result" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).branch)")
  # Step 4: cd in main shell — Bash cwd persists; all subsequent dispatches inherit this path.
  cd "$WORKTREE_PATH"
fi

```

**Cwd propagation contract:** The single `cd "$WORKTREE_PATH"` above sets the main-context shell cwd. Bash cwd persists across subsequent Bash invocations in the same agent context. Agent-tool dispatches inherit the parent's cwd — so commit-sdlc, review-sdlc, pr-sdlc, verify-pipeline-sdlc, version-sdlc, received-review-sdlc, learnings-commit, and archive-openspec all start in the new worktree automatically. No per-prompt `cd` prepend is needed. In branch mode there is nothing to cd into (HEAD shared with main worktree) — same cwd propagation applies trivially.

**Step 5:** Pass `--branch "$EXECUTE_BRANCH"` to execute-plan-sdlc in the execute dispatch (see "Execute step" section below). execute-plan-sdlc will short-circuit its own Step 1 isolation block (implements R30 from execute-plan-sdlc spec).

The `migrate` subcommand renames `ship-<oldSlug>-<ts>.json` → `ship-<newSlug>-<ts>.json` and updates `data.branch`. On `migrated: false` (e.g. no state file yet, slug already correct), warn and continue — do not abort; the orphaned file (if any) will be cleaned by the terminal `cleanup` step or by `--gc`.

### Execution loop

**Execute step resume:** When the pipeline is resuming (gate on `flags.resume === true` from the prepare output — this is `true` whether the user typed `--resume` or the hook triggered implicit resume; do NOT re-parse `$ARGUMENTS`) and the execute step's status in the ship state file is `in_progress`:
1. Check for `<main-worktree>/.sdlc/execution/execute-<branch>-*.json` (an execute-plan-sdlc state file for the current branch). Resolve `<main-worktree>` via `git worktree list --porcelain` (first `worktree` line).
2. If found, dispatch execute-plan-sdlc via the Agent tool with args from `step.invocation` plus `--resume` (e.g. `"--quality <X> --resume"` if the user passed `--quality` to ship; `"--resume"` otherwise). Wave progress and gates run inside the Agent's sub-context; the structured return value drives the next step. (Implements R-implicit-resume — `flags.resume` is the single resume signal regardless of source.)
3. If not found, dispatch via Agent tool normally using `step.invocation` (execute restarts from scratch)

ship-sdlc does not manage execute-plan-sdlc's state file — execute-plan-sdlc handles its own creation, updates, and cleanup.

**Worktree re-entry on resume:** Check `context.worktree.inLinkedWorktree` from the skill/ship.js output. If true, already in the worktree — proceed normally.

If false (resuming from the main worktree but the pipeline originally ran in a worktree), find the worktree for the resume branch:
```bash
git worktree list --porcelain
```
Match the branch from the ship state file against worktree entries. If found and directory exists, `cd <path>` before continuing. If the worktree directory is gone, warn and fall back to running on the current branch.

**Execute-step todo mirroring (R-todowrite-visibility clause 4):**

Assign `PLAN_FILE` from the prepare output's `context.planFile` field (R-PLANFILE). This is resolved once by `skill/ship.js` using the priority order: CLI `--plan-file` → project `.claude/settings.json` `plansDirectory` → global `~/.claude/settings.json` `plansDirectory` → default `~/.gemini/plans/` (most recent `*.md`). Do not re-derive the path here — use `context.planFile` verbatim:

```bash
PLAN_FILE=$(node -e "const d=require('fs').readFileSync(process.env.F,'utf8'); process.stdout.write(JSON.parse(d).context.planFile||'')" F="$SHIP_PREPARE_OUTPUT_FILE")
```

Where `$SHIP_PREPARE_OUTPUT_FILE` is the path to the temp file holding the `skill/ship.js` JSON output (same file used to read `flags`, `steps`, etc.). When `context.planFile` is null or empty, `PLAN_FILE` will be empty and the `ship-todos.js` execute event will exit 2 with a clear error — surface that error before dispatching.

Before dispatching `execute-plan-sdlc`, run:

```bash
node "$SHIP_TODOS" --state-file "$STATE_FILE" --plan-file "$PLAN_FILE" --event execute --current-step execute
```

`$PLAN_FILE` is sourced from `context.planFile` in the prepare output (R-PLANFILE). The helper expands the `execute` step's placeholder substep to one substep per plan task (one `### Task N:` heading per substep). Parse JSON, call `TodoWrite`, echo `marker`.

Then dispatch `execute-plan-sdlc` as below. On Agent return (success), run the post-execution completeness invariant **before** marking the step complete (R-INVARIANT-COMPLETENESS, #432):

```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

EXECUTE_STATE_SCRIPT="$SDLC_ROOT/scripts/skill/execute.js"
[ ! -f "$EXECUTE_STATE_SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/execute.js. Is the sdlc plugin installed?" >&2; exit 2; }
node "$EXECUTE_STATE_SCRIPT" verify-completeness
COMPLETENESS_EXIT=$?
if [ "$COMPLETENESS_EXIT" -ne 0 ]; then
  echo "ERROR: execute-plan-sdlc returned but planned tasks are unaccounted. Pipeline halted." >&2
  # Mark execute step failed and halt — do NOT advance to commit/review/version/pr
  node "$SHIP_TODOS" --state-file "$STATE_FILE" --plan-file "$PLAN_FILE" --event execute --fail-step execute
  exit "$COMPLETENESS_EXIT"
fi

```

If `verify-completeness` exits 65, the pipeline MUST halt before commit. The missing task IDs appear on stderr as JSON `{missingIds, totalPlanned, totalAccounted}`. Do NOT advance to the commit step.

Then run per-step-completion: `--mark-completed execute`. The parent does NOT receive per-task completion signals from the Agent; per-task todos all transition to `completed` atomically on return.

Example dispatch sequence (use `step.invocation` for actual args):
- Agent: execute-plan-sdlc, args: from `step.invocation` PLUS `--branch "$EXECUTE_BRANCH"` when `EXECUTE_BRANCH` is set (i.e. `WORKSPACE_MODE` is `branch` or `worktree`). When `WORKSPACE_MODE` is `continue`, omit `--branch` (execute handles its own isolation or runs on existing branch). Example: `"--quality balanced --branch feat/my-feature"`. This implements R60 step 5 — execute-plan-sdlc short-circuits its own Step 1 isolation in response (R30).
- Agent: commit-sdlc, args: `"--auto"`
- Agent: review-sdlc, args: `"--committed"`
- Agent: received-review-sdlc, args: `"--auto"` (when `flags.auto`; otherwise no args)
- Agent: version-sdlc, args: `"patch"`
- Agent: pr-sdlc, args: `"--auto --draft"`

### Post-execute note (R37 migration moved pre-execute)

Branch migration (R37) now runs **before** the execute dispatch — inside the pre-execute workspace isolation block (see "Pre-execute workspace isolation" section above). The old post-execute migration block has been removed (fixes #379 — it ran after cwd changed, so `git branch --show-current` always returned the wrong value).

Subsequent state operations (`start`, `complete`, `read`) automatically pick up the renamed file because `state/ship.js` resolves by current branch.

### Between execute and commit

execute-plan-sdlc does not stage files. Run `git add -A -- ':!.sdlc/'` with verbose output:
```
Staging changes from execution:
  A  src/middleware/auth.ts
  A  src/middleware/auth.test.ts
  M  src/routes/index.ts
  Total: 14 files staged
  Reason: execute-plan-sdlc creates files but does not stage them. .sdlc/ excluded to prevent committing runtime state.
```

### Between review and received-review

Evaluate the verdict (see Step 2 conditional logic). Print the decision tree. If received-review-sdlc triggers and makes changes, check `git status`:
```
Review fixes applied: 3 files modified
  M  src/middleware/auth.ts
  M  src/routes/index.ts
  M  tests/auth.test.ts
  → Running commit step for review fixes
```
Then invoke commit-sdlc (step 5) for the fix commit.

### After version — post-version ancestry HARD GATE (R-post-version-ancestry, fixes #349)

After the version step dispatches and returns, capture the new tag from the version-sdlc return value as `NEW_TAG`. When `NEW_TAG` is set (non-empty) AND `EXECUTE_BRANCH` is set (non-empty), run the ancestry check:

```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

# Post-version ancestry HARD GATE (R-post-version-ancestry, fixes #349)
VERIFY_SCRIPT="$SDLC_ROOT/scripts/util/verify-tag-ancestry.js"
[ ! -f "$VERIFY_SCRIPT" ] && { echo "ERROR: Could not locate scripts/util/verify-tag-ancestry.js. Is the sdlc plugin installed?" >&2; exit 2; }
[ -z "$VERIFY_SCRIPT" ] && [ -f "plugins/sdlc-utilities/scripts/util/verify-tag-ancestry.js" ] && VERIFY_SCRIPT="plugins/sdlc-utilities/scripts/util/verify-tag-ancestry.js"
if [ -z "$VERIFY_SCRIPT" ]; then
  echo "WARNING: verify-tag-ancestry.js not found — post-version ancestry check skipped." >&2
fi
if [ -n "$VERIFY_SCRIPT" ] && [ -n "$NEW_TAG" ] && [ -n "$EXECUTE_BRANCH" ]; then
  node "$VERIFY_SCRIPT" --tag "$NEW_TAG" --branch "$EXECUTE_BRANCH" --remote origin
  ANCESTRY_EXIT=$?
  if [ "$ANCESTRY_EXIT" -ne 0 ]; then
    echo "Pipeline halted: tag $NEW_TAG is not an ancestor of $EXECUTE_BRANCH." >&2
    echo "Remediation: delete the tag (git push origin :refs/tags/$NEW_TAG; git tag -d $NEW_TAG) and re-run version step on the correct branch." >&2
    exit 1
  fi
fi

```

`NEW_TAG` is the tag string emitted by version-sdlc (e.g. `v1.2.3`). `EXECUTE_BRANCH` is the feature branch variable set during pre-execute workspace isolation (already available in the pipeline shell context). This gate is a **no-op when `NEW_TAG` is unset** (version step was skipped or not in `flags.steps`, e.g., under `workspace: worktree`). Works correctly under both `workspace: branch` and `workspace: worktree`.

### Between version and pr — archive-openspec (conditional)

If the `archive-openspec` step has `status: "conditional"` in the pipeline plan, execute it inline (no Agent dispatch — this is a deterministic shell operation):

1. Extract the change name from `step.args` (`--change <name>`).
2. Call `lib/openspec.js::validateChangeStrict(projectRoot, name)` via Bash:
   ```bash
   node -e "
   const { validateChangeStrict } = require('<LIB>/openspec.js');
   const result = validateChangeStrict(process.cwd(), '<name>');
   console.log(JSON.stringify(result));
   "
   ```
3. **If `ok === false`:** halt the pipeline. Print the validation errors (`stderr`) and save state for `--resume`.
4. **If `ok === true`:** prompt the user for approval (skip prompt in `--auto` mode).
5. On approval, run the archive:
   ```bash
   node -e "
   const { runArchive } = require('<LIB>/openspec.js');
   const result = runArchive(process.cwd(), '<name>');
   console.log(JSON.stringify(result));
   "
   ```
6. If archive succeeds, commit:
   ```bash
   git add openspec/
   git commit -m "chore(openspec): archive <name>"
   ```
7. If `isArchived(projectRoot, name)` already returns true (idempotence), skip with reason "already archived".

If the step has `status: "skipped"`, print the skip reason from `step.reason`.

### After pr — verify-pipeline (conditional, opt-in)

If the `verify-pipeline` step has `status: "will_run"` (gated by step membership in `flags.steps` — cite `step.status === "will_run"` from the prepare output, not `$ARGUMENTS`; per `flag-coherence-cross-skill`), execute it inline (no Agent dispatch — this is a deterministic polling script). Implements R41–R49.

1. Resolve the script path:
   ```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

VP_SCRIPT="$SDLC_ROOT/scripts/skill/verify-pipeline.js"
[ ! -f "$VP_SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/verify-pipeline.js. Is the sdlc plugin installed?" >&2; exit 2; }
   [ -z "$VP_SCRIPT" ] && [ -f "plugins/sdlc-utilities/scripts/skill/verify-pipeline.js" ] && VP_SCRIPT="plugins/sdlc-utilities/scripts/skill/verify-pipeline.js"
   [ -z "$VP_SCRIPT" ] && { echo "ERROR: Could not locate skill/verify-pipeline.js. Is the sdlc plugin installed?" >&2; exit 2; }
   
```
2. Run the script with the args from `step.args` plus `--state-file <ship-state-path>`:
   ```bash
   node "$VP_SCRIPT" $STEP_ARGS --state-file "$SHIP_STATE_PATH"
   ```
3. Parse the single JSON line on stdout. Branch on `status`:

   **`status === "green"`** — log `verify-pipeline: CI green for PR #N` and proceed to `await-remote-review`. Cites R43.

   **`status === "failed"`** AND `flags.auto === false` — interactive (R45). Use `AskUserQuestion`:
   > Wave verify-pipeline failed for PR #N. <X> failed checks: <names>.
   >
   > Options: **analyze** (Recommended) | **skip** | **abort**
   - **analyze**: dispatch `verify-pipeline-sdlc` subagent (Agent tool, model sonnet) with `--pr <N>` and `--logs <inline-log-excerpt-from-failedChecks>`. On verdict `fix-applied`, dispatch `commit-sdlc` (Agent tool, model haiku, `--auto`) directly to commit and push. Then re-run verify-pipeline (loop). Iteration cap = `flags.verifyPipelineMaxIterations` (default 3, R47); after cap, log warning and proceed to `await-remote-review`. The pre-existing `commit-fixes` step entry (already visited before `pr`) is NOT involved — this dispatch is direct via the Agent tool.
   - **skip**: log warning, proceed to `await-remote-review`.
   - **abort**: write `verifyPipelineExhausted: true` to the ship state file, exit pipeline 1.

   **`status === "failed"`** AND `flags.auto === true` — non-interactive (R46). Directly dispatch `verify-pipeline-sdlc` subagent (Agent tool, model sonnet) with `--pr <N> --logs <excerpt> --auto`. On `fix-applied`, dispatch `commit-sdlc --auto` directly. Loop with the same iteration cap (`flags.verifyPipelineMaxIterations`, R47). On cap exhaustion, log warning and proceed.

   **`status === "timeout"`** — log warning `verify-pipeline: timeout after Ns`. The script has already written `verifyPipelineExhausted: true` to the state file. Proceed to `await-remote-review`. Cites R48, R49.

   **`status === "skipped"`** (resume short-circuit) — log info `verify-pipeline: skipped (resumed from prior exhaustion)`. Proceed. Cites R49.

   **`status === "error"`** — log warning `verify-pipeline: error — <reason>`. Proceed.

Do NOT replicate polling, log fetching, or fix-application logic in this prose — those live in `verify-pipeline.js` and the `verify-pipeline-sdlc` skill (per `scripts-over-llm-logic`).

If the step has `status: "skipped"`, print the skip reason from `step.reason` and do nothing.

### After verify-pipeline — await-remote-review (conditional, opt-in)

If the `await-remote-review` step has `status: "will_run"` (gated by step membership in `flags.steps` — cite `step.status === "will_run"` from the prepare output, not `$ARGUMENTS`), execute it inline. Implements R50–R56.

1. Resolve the script path:
   ```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

AR_SCRIPT="$SDLC_ROOT/scripts/skill/await-remote-review.js"
[ ! -f "$AR_SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/await-remote-review.js. Is the sdlc plugin installed?" >&2; exit 2; }
   [ -z "$AR_SCRIPT" ] && [ -f "plugins/sdlc-utilities/scripts/skill/await-remote-review.js" ] && AR_SCRIPT="plugins/sdlc-utilities/scripts/skill/await-remote-review.js"
   [ -z "$AR_SCRIPT" ] && { echo "ERROR: Could not locate skill/await-remote-review.js. Is the sdlc plugin installed?" >&2; exit 2; }
   
```
2. Run the script with the args from `step.args` plus `--state-file <ship-state-path>`:
   ```bash
   node "$AR_SCRIPT" $STEP_ARGS --state-file "$SHIP_STATE_PATH"
   ```
3. Parse the single JSON line on stdout. Branch on `status`:

   **`status === "actionable"`** — directly dispatch `received-review-sdlc` (Agent tool, model sonnet) with `--pr <verdict.prNumber>` (and `--auto` when `flags.auto === true`). After the subagent completes, run `git status --porcelain` in the main context; if there are working-tree changes, directly dispatch `commit-sdlc` (Agent tool, model haiku, `--auto`) to commit and push. The pre-existing `received-review` and `commit-fixes` step entries (already visited before `pr`) are NOT involved — these dispatches are direct via the Agent tool. Cites R52.

   **`status === "approved-clean"`** — log `await-remote-review: APPROVED by <reviewer>` and proceed. Do NOT dispatch received-review-sdlc. Cites R53.

   **`status === "timeout"`** — log warning `await-remote-review: timeout after Ns waiting for <reviewers>`. The script has already written `awaitRemoteReviewExhausted: true` to the state file. Proceed. Cites R54, R55.

   **`status === "skipped"`** (resume short-circuit) — log info and proceed. Cites R55.

   **`status === "error"`** — log warning and proceed.

If the step has `status: "skipped"`, print the skip reason from `step.reason` and do nothing.

### After pr — learnings-commit (final step)

Pipeline-level learnings cannot land in the feature commit (issue #208) — review/version/pr/archive all run *after* the feature commit. The `learnings-commit` step exists to capture them in a trailing chore commit so post-pipeline `git status` is clean.

If the `learnings-commit` step has `status: "will_run"`, execute it inline (no Agent dispatch — deterministic shell):

1. Run the ship-level Learning Capture (see the `## Learning Capture` section below) — append any new entries to `.sdlc/learnings/log.md`.
2. Check whether anything actually changed:
   ```bash
   git diff --quiet -- .sdlc/learnings/log.md
   ```
   - Exit `0` (no diff) → skip the commit and report `learnings-commit: no-op (no new learnings)`.
3. If there is a diff:
   ```bash
   git add .sdlc/learnings/log.md
   git commit -m "chore(ship-sdlc): capture pipeline learnings"
   git push
   ```
   On push failure (offline, auth), report the error but do **not** halt the pipeline — the local commit still lands and a follow-up `git push` will deliver it.
4. After the step, `git status --porcelain` MUST be empty.

If the step has `status: "skipped"` (omitted from `--steps` or `ship.steps[]`), print the skip reason from `step.reason` and do not perform any of the above. The execute-plan-sdlc-level Learning Capture (`R27` in `docs/specs/execute-plan-sdlc.md`) still runs and lands in the feature commit; only the ship-level append is conditional on this step.

### Between last commit and version — rebase on default branch

After all commits are done (feature commit + optional review-fix commit + optional archive commit), rebase onto the latest default branch to ensure a clean merge:

```bash
git fetch origin <defaultBranch>
```

Check if rebase is needed:
```bash
git merge-base --is-ancestor origin/<defaultBranch> HEAD
```
If main is already an ancestor of HEAD, no rebase needed — print "Already up to date with `<defaultBranch>`" and skip.

Otherwise, attempt rebase:
```bash
git rebase origin/<defaultBranch>
```

**If rebase succeeds:** Print summary and continue.
```
Rebase: clean — <N> commits replayed on origin/<defaultBranch>
```

**If rebase fails (conflicts):** Abort and handle:
```bash
git rebase --abort
```
List conflicting files from the failed output. Then:

**Auto mode:** Stop pipeline, save state for `--resume`. Print:
```
Rebase: CONFLICTS detected with origin/<defaultBranch>
  Conflicting files:
    - src/foo.ts
    - src/bar.ts
  Pipeline paused. Resolve conflicts manually, then --resume.
```

**Interactive mode:** Use AskUserQuestion:
> Rebase onto `<defaultBranch>` has conflicts in <N> files:
> - `src/foo.ts`
> - `src/bar.ts`
>
> 1. **Pause pipeline** — resolve manually, then `--resume`
> 2. **Skip rebase** — create PR with conflicts (GitHub will show merge conflicts)
> 3. **Merge instead** — try `git merge origin/<defaultBranch>` (creates merge commit)

Option 3 fallback: run `git merge origin/<defaultBranch>`. If that also conflicts, abort and fall back to option 1.

Note: in a worktree, all of this is safe — main working tree is untouched.

### State persistence

After each step, update pipeline state via `state/ship.js`. Locate the script:
```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

SCRIPT="$SDLC_ROOT/scripts/state/ship.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/state/ship.js. Is the sdlc plugin installed?" >&2; exit 2; }
[ -z "$SCRIPT" ] && [ -f "plugins/sdlc-utilities/scripts/state/ship.js" ] && SCRIPT="plugins/sdlc-utilities/scripts/state/ship.js"

```

At pipeline start (after Step 1 completes), initialize the state file:
```bash
node "$SCRIPT" init --branch <branch> --flags '<flags JSON>'
```

Before each step: `node "$SCRIPT" start --step <name>`
After each step: `node "$SCRIPT" complete --step <name> --result "<summary>"` (or `skip --step <name> --reason "<reason>"` or `fail --step <name> --error "<error>"`)
Record decisions: `node "$SCRIPT" decide --step <name> --text "<decision>"`
Defer findings: `node "$SCRIPT" defer --severity <s> --file <f> --title "<t>"`

### Terminal cleanup step (R38, issue #223)

The prepare-script output (`steps[]` array) ends with a synthetic step named `cleanup` (`status: "will_run"`, `skill: null`, `reserved: true`). It is appended unconditionally by `skill/ship.js::computeSteps` and is NOT user-configurable — listing `cleanup` in `--steps` or `ship.steps[]` produces a validation error in Step 1c.

Dispatch the cleanup step **as a direct Bash call**, not as an Agent. Each `cleanup` step entry has an `invocation` object with two precomputed command variants:

```json
{
  "method": "bash",
  "normal": "node \"$SCRIPT\" cleanup-pipeline",
  "forced": "node \"$SCRIPT\" cleanup-pipeline --force"
}
```

**Cleanup-step todo (R-todowrite-visibility clause 2):**

Before invoking the cleanup Bash command, run:

```bash
node "$SHIP_TODOS" --state-file "$STATE_FILE" --event cleanup --current-step cleanup
```

Call `TodoWrite`, echo `marker`. After the cleanup command returns (success or contract violation), run per-step-completion with `--mark-completed cleanup`.

Selection rule: walk `steps[]` and check whether any prior step's recorded status (from the live state file, not the prepare snapshot) is `failed`. If so, dispatch with `step.invocation.forced`; otherwise dispatch with `step.invocation.normal`. `$SCRIPT` is the same `state/ship.js` path resolved in the state-persistence section above.

Behavior:
- **Normal:** validates pipeline contract (no `pending`/`in_progress` steps), deletes the current run's state file, then sweeps stale ship- and execute- state files older than `state.gc.ttlDays` (default 7 days) whose branch is no longer in `git branch --list`.
- **Forced:** preserves the current run's state file (so `--resume` works after a failure), skips the contract check, and runs only the GC sweep.

If `--ttl-days <N>` was passed to ship-sdlc, append it to whichever variant you select.

The script prints a JSON report to stdout. Surface it verbatim:

```
Terminal cleanup:
  Current run: deleted ship-<branch>-<ts>.json
  GC swept: 1 ship-* file, 0 execute-* files (1 deleted, kept 1 ttl-fresh)
```

If `currentRun.valid === false` (contract violation on the normal path), print:

```
PIPELINE CONTRACT VIOLATION
The following steps were not resolved:
  - <step>: status "<status>" (expected: completed, skipped, or failed)

State file preserved for debugging: <path>
This is a pipeline bug — all will_run steps must be dispatched.
```

Do NOT proceed to the success summary. The pipeline did not complete correctly.

The cleanup step ALWAYS runs, even on failure paths — orphaned state files from interrupted runs are pruned regardless of whether the current pipeline succeeded.

---

## Step 6 (REPORT): Pipeline Summary

```
Ship Pipeline Complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Step  Skill                 Result
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1     execute-plan-sdlc     [done] 8 tasks, 3 waves completed
2     commit-sdlc           [done] a1b2c3d feat(auth): add OAuth2 PKCE
3     review-sdlc           [done] APPROVED WITH NOTES (2 medium)
4     received-review-sdlc  — not triggered (no critical/high)
5     commit-sdlc (fixes)   — not triggered
6     version-sdlc          — skipped (config default)
7     pr-sdlc               [done] https://github.com/.../pull/42
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Decisions log:
  - Steps resolved: [execute, commit, review, archive-openspec, pr] (from config default; --quality not forwarded to execute-plan-sdlc — user did not pass --quality)
  - Version step skipped (from config default, bump type: patch)
  - Review found 2 medium issues — below threshold, deferred
  - PR created as draft (from --draft flag)

Deferred review findings (2 medium):
  1. [medium] src/middleware/auth.ts:42 — Consider extracting token validation
  2. [medium] src/routes/index.ts:15 — Missing rate limit on new endpoint
  → Run /received-review-sdlc to address these

State file cleaned up: .sdlc/execution/ship-<branch>-<epoch>.json deleted
```

If OpenSpec was detected in Step 1f and the archive-openspec step ran successfully, append:
  `→ OpenSpec change "<name>" archived and committed.`

If OpenSpec was detected but archive-openspec was skipped or not triggered, append:
  `→ Run /opsx:verify to validate implementation completeness against the spec`
  `→ Run /opsx:archive to archive the OpenSpec change and sync delta specs`

### Worktree cleanup

Detect if running in a linked worktree:
```bash
main_wt=$(git worktree list --porcelain | head -1 | sed 's/worktree //')
current=$(git rev-parse --show-toplevel)
```
If `$main_wt != $current`, a worktree is active.

**Auto mode:** keep (default). Print path and action:
```
Worktree kept: <current path>
  Branch: <branch name>
  To remove later: cd <main_wt> && git worktree remove <current>
```

**Interactive mode:** Use AskUserQuestion — keep or remove.
If remove: `cd "$main_wt" && git worktree remove "$current"`

If `git worktree remove` fails, warn but don't fail the pipeline.

### Post-pipeline advisory (when version was auto-skipped)

If the version step status is `skipped` and the reason contains "worktree", print a next-step hint after the summary table:

```
Note: Version step was skipped (worktree mode — tags are repo-global).
After merging this PR, run on main:
  /version-sdlc <patch|minor|major>
This will tag the release and generate the changelog from all merged commits.
```

---

## Error Recovery

> **Flow**: detect → diagnose → auto-recover (retry once if transient) → escalate to user for persistent failures.

| Error | Recovery | Invoke error-report-sdlc? |
|-------|----------|---------------------------|
| Sub-skill fails (script crash) | Show error from sub-skill, stop pipeline, save state for `--resume` | Delegated — sub-skill handles its own error reporting |
| `gh auth status` fails | Stop at validation (Step 3). Tell user to run `gh auth login` | No — user setup |
| `git add -A -- ':!.sdlc/'` fails | Show error, stop pipeline | No — user action needed |
| Network error (gh API) | Auto-retry via `retryExec` (3 attempts with exponential backoff). If exhausted, record failure + print resume instruction (see below) | No — transient |
| State file write fails | Warn and continue — state persistence is best-effort | No |
| Resume state file corrupt | Warn, start fresh | No |
| Review verdict unparseable | Treat as APPROVED WITH NOTES, warn user, defer all findings | No |
| Sub-skill times out | Stop pipeline, save state, inform user to `--resume` | No — transient |

**Resume instruction format** (printed on step failure after retries exhausted or on any unrecoverable step error):
```
Step <N> (<name>) failed: <error summary>
State saved to: <state file path>
To resume: /ship-sdlc --resume
```

Each sub-skill has its own error recovery. ship-sdlc does not duplicate their recovery logic — it catches pipeline-level failures (sequencing, state, context) and delegates skill-level failures to the skill itself.

---

## DO NOT

- Deviate from `step.dispatchMode`. Every sub-skill step has `dispatchMode: 'agent'`; inline-Bash steps have `dispatchMode: null`. The LLM must not synthesize a `'skill'` value or invoke any step via the Skill tool from Step 5. Use Agent tool for all sub-skill steps, including `execute-plan-sdlc`.
- Skip the critique step (Step 3) even when all checks seem obvious
- Forward `--auto` to sub-skills that do not support it (see audit table)
- Automatically resolve review findings — received-review-sdlc is always interactive
- Run pipeline steps in parallel — the pipeline is strictly sequential
- Delete the state file on failure — it is needed for `--resume`
- Proceed past a failed sub-skill — stop, save state, inform user
- Skip pipeline steps that were marked "will run" in the pipeline plan. The pipeline plan is a contract with the user. If a step was planned to run and the user confirmed the pipeline, it MUST run. The LLM does not have authority to skip planned steps based on its own assessment of change complexity or risk. Only the skip set and auto-skip rules (computed by skill/ship.js) control which steps run.
- Copy example args from this document when dispatching sub-skill Agents — use the `invocation` field from the skill/ship.js output, which contains the exact computed args
- Add `--steps` flags not present in the user's original invocation. Pipeline composition derives from CLI `--steps` > config `ship.steps[]` > built-in defaults. Legacy `--preset` and `--skip` are hard-removed (#190); passing them produces an error.
- Dispatch pipeline step Agents without `model: step.model` — the model field is computed by skill/ship.js from each skill's spec. Omitting it defaults all steps to opus.
- Add, remove, or change the `isolation` parameter on Agent dispatches — isolation comes verbatim from `step.isolation`. Adding `isolation: "worktree"` when `step.isolation` is null causes hidden Agent SDK worktrees that conflict with `--workspace branch` (issue #350).
- Ignore cleanup validation failures — if `state/ship.js cleanup` exits with code 1, the pipeline contract was violated. Surface the violation and preserve state.
- Skip the post-version ancestry HARD GATE. The check is the only safeguard against tags landing on orphaned commits (issue #349). The gate is a no-op when `NEW_TAG` is unset — do not pre-empt it by skipping it when you believe the version step succeeded on the right branch.
- Exit the plan-mode-blocked path (Step 0, steps 3–7) without running `rm -f "$PLAN_MODE_OUTPUT_FILE"` — the temp prepare output file is separate from the persistent state file in `.sdlc/execution/` and must be cleaned up on every exit branch.

---

## Gotchas

**Staging gap after execute.** execute-plan-sdlc creates and modifies files but does not stage them. ship-sdlc must run `git add -A -- ':!.sdlc/'` between execute and commit. Missing this produces an empty commit.

**Verdict detection is text-based.** Parse the conversation for a line matching `Verdict: <VERDICT>`. The review-sdlc orchestrator always emits this. If the conversation is compacted between review and verdict parsing, the verdict may be lost — treat missing verdict as APPROVED WITH NOTES and warn the user.

**received-review-sdlc supports `--auto`.** When `--auto` is forwarded, both the Step 10 consent prompt and the Step 12 reply/resolve prompt are skipped. "Will fix" items are auto-implemented and their threads are auto-resolved via in-thread replies. "Disagree" and "won't fix" items are displayed but not auto-implemented; their threads are replied to but left open for the reviewer. Critique gates and verification still run. Without `--auto`, the pipeline pauses for human approval at both gates.

**Double commit is intentional.** Feature commit (step 2) and review fix commit (step 5) are separate. This keeps feature work and review fixes distinct in git history. Do not squash them.

**Version consent gate.** version-sdlc supports `--auto`. When forwarded, the release plan approval prompt is skipped but the plan is still displayed. Pre-condition checks (Steps 6–7) and critique gates (Steps 3–4) still run.

**Config file is optional.** The pipeline runs with built-in defaults when no ship config exists in `.sdlc/local.json`. Do not error on missing config.

**Step set validation matters.** Unrecognized values in `--steps` (e.g., `--steps reviw`) produce an error from `skill/ship.js parseArgs` and abort the run. The single source of truth for step composition is `ship.steps[]` in `.sdlc/local.json`; CLI `--steps` is a one-shot override. The legacy `--preset` and `--skip` flags are hard-removed (#190) and rejected with a migration-pointer error.

**.sdlc/ must be gitignored.** The `.sdlc/` directory contains developer-local config (`local.json`) and ephemeral pipeline state (`execution/`). `--init-config` creates `.sdlc/.gitignore` automatically via `ship-init.js`. If `.sdlc/` is not gitignored, the staging command (`git add -A -- ':!.sdlc/'`) provides a fallback exclusion, but the gitignore is the primary defense.

**Pipeline plan is binding.** The pipeline table displayed in Step 4 and confirmed by the user is a contract. Step statuses (`will_run`, `skipped`, `conditional`) are computed by `skill/ship.js` — the LLM follows them, it does not override them. Steps with `status: "will_run"` must be dispatched as Agents. This was added after an incident where the review step was skipped because the LLM judged the changes to be "just docs/config" (issue #68). The pipeline's value is precisely in catching cases where the developer thinks changes are low-risk but the review disagrees.

**State files are script-managed.** Use state/ship.js / state/execute.js for all state operations. Don't hand-write JSON to `.sdlc/execution/`.

**Worktree lifecycle uses git commands.** `git worktree add` to create (via util/worktree-create.js), `git worktree remove` to clean up. No EnterWorktree/ExitWorktree. No session-scoping issues.

**Worktree state is not persisted.** Git is the source of truth. Branch name + `git worktree list --porcelain` = worktree path. No worktree fields in state files.

**Resume re-enters via `cd`.** Match branch from state file against `git worktree list --porcelain`.

**Rebase happens after all commits, before version.** This ensures the tag is placed on a commit that can merge cleanly. If rebase conflicts, the pipeline pauses — the user resolves in the worktree (main tree untouched) and resumes.

**Rebase is skipped when main is already an ancestor.** `git merge-base --is-ancestor` is a fast check. No fetch + rebase overhead when the branch is already up to date.

**Version step is auto-skipped in worktree mode.** `computeSteps` in skill/ship.js skips the version step when `workspace === 'worktree'`. Tags are repo-global — creating them from an isolated worktree risks collisions with parallel pipelines. The pipeline prints a post-merge advisory: run `/version-sdlc` on main after the PR merges. This also handles changelog — `version-sdlc` generates changelog from `previousTag..HEAD`, capturing all commits from all merged branches regardless of their source worktree.

**Worktree PRs auto-label `skip-version-check`.** When `workspace === 'worktree'` causes the version step to be auto-skipped, `skill/ship.js` adds `--label skip-version-check` to the PR step args. The label is included in `gh pr create` from the start (not added post-creation), so `check-version-bump.yml` sees it on the `opened` event. Only fires for worktree auto-skip, not when `version` is omitted from `ship.steps[]`. Prerequisite: the label must exist in the repository (pr-sdlc creates it automatically if missing).

**Auto mode does not auto-resume without --resume.** When `--auto` is set but `--resume` is not, the pipeline starts fresh even if a state file exists for the current branch. This prevents accidental continuation from stale state. The state file is preserved (not deleted) so the user can explicitly `--resume` later.

**Sub-skill loading and agent isolation.** Each sub-skill's SKILL.md is 200–550 lines. All sub-skills (including `execute-plan-sdlc`) are Agent-dispatched so each loads SKILL.md in its own context and returns only a structured result (5–10 lines). The ship pipeline's context receives structured data, not sub-skill definitions. `execute-plan-sdlc` bounds its own context impact by dispatching one wave-runner Agent per wave rather than per task — its structured Step-9 result is what ship-sdlc consumes to continue the pipeline.

**skipSource tracks provenance.** Each step's `skipSource` field records why a step was skipped: `"none"` (not skipped), `"cli"` (step omitted from CLI `--steps`), `"quick"` (step is canonical but absent from `ship.quick` under an active `--quick` run — R-quick-4), `"config"` (omitted from `ship.steps[]` in `.sdlc/local.json`), `"auto"` (auto-skipped by `computeSteps` logic), `"condition"` (conditional step not triggered), `"default"` (built-in defaults excluded the step). The per-step `skipSource` makes the exclusion provenance auditable per step.

---

## Learning Capture

After completing the pipeline, append to `.sdlc/learnings/log.md`:

- Review verdicts that surprised (threshold too aggressive or too lenient)
- Sub-skills that failed in unexpected ways during chaining
- Config combinations that produced unintended pipeline shapes
- Projects where the default `steps[]` behavior was wrong, or migrations from legacy v1 configs (`ship.preset`/`ship.skip`) that produced unexpected `steps[]` after auto-migration. CLI `--preset`/`--skip` are no longer accepted (#190 hard-remove); ship-sdlc emits a migration-pointer error if either is passed.

Format:
```
## YYYY-MM-DD — ship-sdlc: <brief summary>
<what was learned>
```

---

## What's Next

After the pipeline completes, common follow-ups include:
- `/received-review-sdlc` — address deferred medium/low findings
- `/opsx:verify` — validate implementation against OpenSpec (if detected)
- `/opsx:archive` — archive the OpenSpec change and sync delta specs (if detected)

---

## See Also

- [`/execute-plan-sdlc`](../execute-plan-sdlc/SKILL.md) — plan execution with wave-based dispatch
- [`/commit-sdlc`](../commit-sdlc/SKILL.md) — smart commit with style detection
- [`/review-sdlc`](../review-sdlc/SKILL.md) — multi-dimension code review
- [`/received-review-sdlc`](../received-review-sdlc/SKILL.md) — process and fix review findings
- [`/version-sdlc`](../version-sdlc/SKILL.md) — semantic versioning and release tags
- [`/pr-sdlc`](../pr-sdlc/SKILL.md) — pull request creation
