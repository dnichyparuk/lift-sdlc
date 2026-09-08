---
name: ship-sdlc
description: "Use this skill when shipping a feature end-to-end after plan acceptance: executing, committing, reviewing, fixing critical issues, versioning, and opening a PR in one flow. Dispatches every sub-skill (including execute-plan-sdlc) as an Agent for context isolation, with structured return values driving the pipeline state machine. Arguments: [--auto] [--steps <csv>] [--quick] [--quality full|balanced|minimal] [--bump patch|minor|major|<label>] [--draft] [--dry-run] [--resume] [--workspace branch|worktree|prompt] [--branch | --tree] [--openspec-change <name>] [--init-config] [--gc] [--ttl-days <N>]. The `<label>` form for --bump (e.g. `--bump rc`) is forwarded to version-sdlc, where it is interpreted as `--bump patch --pre <label>`; labels must match `^[a-z][a-z0-9]*$`. Triggers on: ship it, ship this, full pipeline, execute to PR, ship feature, run the whole thing."
user-invocable: true
argument-hint: "[--auto] [--steps <csv>] [--quick] [--quality full|balanced|minimal] [--bump patch|minor|major|<label>] [--draft] [--dry-run] [--resume] [--workspace branch|worktree|prompt] [--branch | --tree] [--openspec-change <name>] [--init-config] [--gc] [--ttl-days <N>]"
model: gemini-3.8-flash-medium
---

# Ship Pipeline

End-to-end feature shipping: execute plan, commit, review, fix critical issues, version, and open a PR. Chains six sub-skills sequentially with a conditional review-fix loop.

**Announce at start:** "I'm using ship-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

## Step 0 — Plan Mode Check

If the system context contains "Plan mode is active":

> **VERBATIM** — Run every `node` command in this file exactly as written, invoking the script with `node` and its absolute path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin. Note the strict script location pattern: `<PLUGIN_ROOT>/scripts/<group>/<script-name>.js`, where `<group>` is one of `skill`, `util`, `lib`, `state`, or `ci`). There is no shell wrapper — always call `node` on the `.js` file directly. Do not modify, rephrase, or simplify the flags.

1. Invoke (`$ARGUMENTS` is forwarded verbatim after the two fixed flags):
   ```shell
node "<PLUGIN_ROOT>/scripts/util/plan-mode-check.js" $ARGUMENTS
```
> **Contract (Input/Output):**
> - **Input**: ship-sdlc's own `$ARGUMENTS`, forwarded to `skill/ship.js` after `--output-file --plan-mode-blocked`.
> - **Output**: Prints `PLAN_MODE_OUTPUT_FILE=<path>` and `PLAN_MODE_EXIT=<code>` (plus the `PLAN_MODE_OUTPUT_FILE: <path>` / `STATUS: <code>` aliases). The wrapper itself exits 0 when it ran `ship.js`; read `PLAN_MODE_EXIT` for ship.js's own exit code. It exits 2 only when `scripts/skill/ship.js` could not be located.
2. If `PLAN_MODE_EXIT` is non-zero: show any errors from the output file and stop.
3. Read the output JSON from `$PLAN_MODE_OUTPUT_FILE`. Confirm `planModeBlocked === true`. Extract `stateFile`, `flags.bump`, `flags.steps`.
4. Announce:
   > Plan mode is active. ship-sdlc requires write operations (git commit, gh pr create, git tag) and cannot run inside plan mode.
   >
   > **Pipeline state saved to `<stateFile>` with resolved flags:** bump=`<flags.bump>`, steps=`<flags.steps>`.
   >
   > Exit plan mode and re-invoke `/ship-sdlc` (no args needed) — the existing implicit-resume mechanism will pick up the saved state and resume from the first pending step with the originally-resolved flags intact.
5. Run `rm -f "$PLAN_MODE_OUTPUT_FILE"` to clean up the temp output file.
6. Stop. Do not proceed to subsequent steps.

All gates in steps 3–5 cite resolved fields from prepare output (`planModeBlocked`, `stateFile`, `flags.bump`, `flags.steps`) — never re-parse `$ARGUMENTS` directly.

---

## Step 1 (CONSUME): Load Config, Parse Flags, Detect Context

### 1a. --init-config handler

If `--init-config` was passed:

**Redirect:** Suggest running `/setup-sdlc` instead for unified configuration. If user insists on `--init-config`, proceed with the existing walkthrough.

1. Read `./resources/config-format.md` and run the interactive walkthrough to collect the user's answers (steps multi-select, bump type, auto, threshold, workspace isolation).
   After the `steps[]` selection, offer the optional `--quick` profile prompt:
   > "Would you like to define a `--quick` profile? Select steps that form your shortened pipeline, or skip to omit."
   If the user selects steps, capture them. If the user skips, omit the `--quick` flag when calling `ship-init.js`.
2. Call `ship-init.js` via Bash with the collected answers, substituting the user's walkthrough answers for the example values below (append `--quick <csv>` only when the user made a quick-profile selection):
```shell
INIT_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/ship-init.js" --output-file --steps execute,commit,review,archive-openspec,pr --bump patch --auto --threshold high --workspace prompt)
EXIT_CODE=$?
echo "INIT_OUTPUT_FILE: $INIT_OUTPUT_FILE"
echo "STATUS: $EXIT_CODE"
```
> **Contract (Input/Output):**
> - **Input**: Pipeline initialization flags — `--steps <csv>`, `--bump patch|minor|major`, `--draft`, `--auto`, `--threshold critical|high|medium`, `--workspace branch|worktree|prompt`, `--rebase auto|skip|prompt`, and the optional `--quick <csv>`.
> - **Output**: Scaffolds internal ship state. `--output-file` makes the script print the path of a temp JSON manifest on stdout; exit 0 = success, 1 = validation error (manifest's `errors[]` is non-empty), 2 = crash.
3. Parse the output JSON from `$INIT_OUTPUT_FILE`:
   - If `errors` is non-empty, display them and stop.
   - Otherwise display the `created` files list and `config` JSON for user confirmation.
4. Run `rm -f "$INIT_OUTPUT_FILE"` to clean up the temp output file.
5. Stop. No pipeline execution.

### 1a-gc. --gc handler

If `--gc` (with optional `--ttl-days <N>`) was passed, run `skill/ship.js --gc` and stop — no pipeline composition. The prepare script short-circuits: it scans `<main-worktree>/.sdlc/execution/` for stale ship- and execute- state files (older than TTL AND whose branch is no longer in `git branch --list`), removes them, and emits a JSON report.

```shell
PREPARE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/ship.js" --output-file --gc)
echo "PREPARE_OUTPUT_FILE=$PREPARE_OUTPUT_FILE"
```
Append `--ttl-days <N>` to the same command when the user passed `--ttl-days`.

> **Contract (Input/Output):**
> - **Input**: None (optional `--ttl-days <N>`).
> - **Output**: Garbage collects stale ship runs. Prints the temp JSON manifest path on stdout — assign it to `PREPARE_OUTPUT_FILE`; the block echoes the path.

Read the prepare output. The top-level `action` field will be `"gc"`; the `report` field contains `{ttlDays, ship: {deleted, kept}, execute: {deleted, kept}}`.

Print one line per file:
```
[deleted] ship-deletedbranch-20240101T000000Z.json — stale+branch-gone
[kept]    ship-main-20260505T120000Z.json — ttl-fresh
```

Run `rm -f "$PREPARE_OUTPUT_FILE"` to clean up the temp output file. Then stop. Do not proceed to step 1b. The pipeline does not run.

### 1b. Load ship config

**Hook context fast-path:** If the session-start system-reminder contains a `Ship config:` line, note it for display. The prepare script (`skill/ship.js`) remains the authoritative source for config values — the hook line is a user-facing heads-up, not a data source.

Check for ship config via skill/ship.js output (reads from `.sdlc/local.json` → `ship` section, with legacy `.sdlc/ship-config.json` fallback). If found, read and merge. Print loaded config verbosely:
```
Ship config loaded from .sdlc/local.json (schema v2)
  steps: [execute, commit, review, archive-openspec, pr], draft: false, bump: patch
  reviewThreshold: high
  execute.commitWaves: false
```

The `execute.commitWaves` field controls per-wave WIP commits during the execute step. Default `false`. When `true`, `--commit-waves` is appended to the execute step's invocation; execute-plan-sdlc then commits `wip(execute): wave N — <titles>` after each wave's G9+G11 pass, and the commit step later squashes those commits into the final feature commit via soft-reset (PR history unchanged). Always cite `step.invocation`, never raw `config.execute.commitWaves`.
If not found: `No ship config found — using built-in defaults. Run /setup-sdlc to configure.`

**Legacy v1 auto-migration:** If the loader detects a v1 config (no top-level `version`, with `ship.preset` or `ship.skip`), it migrates in place to schema v2 and emits a single stderr deprecation notice. The migrated shape (`ship.steps[]`) is what subsequent steps consume.

### 1c. Prepare pipeline context

Run `skill/ship.js` to pre-compute flags, context, and step statuses:
```shell
PREPARE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/ship.js" --output-file --has-plan --auto)
EXIT_CODE=$?
echo "PREPARE_OUTPUT_FILE: $PREPARE_OUTPUT_FILE"
echo "STATUS: $EXIT_CODE"
```
> **Contract (Input/Output):**
> - **Input**: Current branch context, plus the conditional flags below.
> - **Output**: Prints the path of a temp JSON manifest (via `writeOutput`) containing PR and ship status. `--output-file` makes stdout the manifest path; capture it into `PREPARE_OUTPUT_FILE`.

**Conditional flags — append to the invocation above only under the stated condition. Never add a flag "for completeness"; an unconditional flag overrides the user's config.**

- **`--bump <type>`** — append ONLY when the user explicitly passed `--bump` to ship-sdlc. `skill/ship.js` otherwise resolves the bump from config (`version.preRelease`) or the `patch` default. Passing `--bump` unconditionally would override config and break pre-release trains.
- **Workspace mode** — intentionally omitted from the example above so it falls back to `.sdlc/local.json` → `ship.workspace` via `mergeFlags`. A literal `--workspace <value>` here would override user config. Append `--workspace <branch|worktree|prompt>`, `--branch`, or `--tree` ONLY when the user passed that override for this single run — e.g. `PREPARE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/ship.js" --output-file --has-plan --auto --tree)`.
- **`--steps <csv>`** — append ONLY when the user passed `--steps`. Pipeline composition otherwise comes from config `ship.steps[]` (top-level `schemaVersion: 4`). CLI `--steps` is a one-shot override, e.g. `--steps execute,commit,pr`. Legacy `--preset` / `--skip` are hard-removed. Unrecognized `--steps` values (e.g. `--steps reviw`) are rejected by `ship.js parseArgs` with exit 1 and abort the run — typos never silently skip a step.
- **`--quality <full|balanced|minimal>`** — append ONLY when the user explicitly passed `--quality`. It sets the model tier forwarded to execute-plan-sdlc; when absent, no quality flag is forwarded downstream.
- **`--hook-active-pipeline`** — append when the session-start `<system-reminder>` contains a line matching `/^Active pipeline: ship-sdlc/` AND the user did NOT type `--resume`. This is the implicit-resume hook signal. `skill/ship.js` then inspects the ship state file for the current branch and, when found and fresh, sets `flags.implicitResume = true` AND `flags.resume = true`, so downstream steps treat the run as a resume without the user typing `--resume`. When no state file is found it emits `errors[*].id === "implicitResumeNoState"` — handled by the missing-state prompt in Step 1e.

Parse the output JSON from `$PREPARE_OUTPUT_FILE`. If `errors` is non-empty, display them and stop. The parsed output replaces manual computation in subsequent sub-steps (1d–1g).

**Context-heaviness advisory:** If the parsed output's top-level `contextAdvisory` field is a non-empty string, print it verbatim before continuing. The advisory recommends `/compact` and notes that pipeline state is preserved across compaction (PreCompact + SessionStart hooks). Sourced from `$TMPDIR/sdlc-context-stats.json`, intended to be written by a `UserPromptSubmit` hook at `hooks/context-stats.js` — that hook **does not exist and is not registered in `hooks.json`**, so the sidecar is never written today and `contextAdvisory` is always `null` in practice. Reader helper at `scripts/lib/context-advisory.js`. When `contextAdvisory` is `null`, emit nothing.

**Gitignore warning:** If `context.sdlcGitignored` is `false` in the output, print:
```
⚠ Warning: .sdlc/ is not gitignored. Run --init-config to fix, or manually create .sdlc/.gitignore:
  printf '*\n' > .sdlc/.gitignore
```

### 1d. Parse flags

Print the `flags` object from the `skill/ship.js` output as `name: value (source: cli|config|default)` lines, one per flag, using the `sources` map to attribute each value (e.g. `auto: true (source: cli)`, `steps: [execute, commit, review, archive-openspec, pr] (source: config)`).

### 1e. Resume check

**Hook context fast-path:** If the session-start system-reminder contains an `Active pipeline:` line, note the state file path and resume point. When the user does not pass `--resume` explicitly but the hook reported an active pipeline, the Step 1c invocation already appended `--hook-active-pipeline` (see the conditional-flags list under Step 1c). The prepare script then either sets `flags.implicitResume === true` (state file found and fresh) or returns `errors[*].id === "implicitResumeNoState"` (state file missing). The LLM does NOT scan the filesystem — `skill/ship.js` is authoritative.

Print `resume.found` and `resume.stateFile` from the `skill/ship.js` output. If `resume.found` is `true`, print the state file path and resume point. If `false`, print that no state file was found and the pipeline will start fresh.

**Implicit-resume banner:** When `flags.implicitResume === true` in the prepare output, print the following banner verbatim BEFORE the pipeline table (Step 2). Source `<nextPendingStep>` from `resume.nextPendingStep` (provided by `detectResumeState()` in lib/state.js) and source the step lists from the state file at `resume.stateFile`:

```
Resuming after compaction from step <nextPendingStep>.
Completed: <comma-separated step names where status === "completed">.
Pending:   <comma-separated step names where status !== "completed" && status !== "skipped">.
```

Note: the banner check gates on `flags.implicitResume`, NOT `flags.resume`. The prepare script auto-sets `flags.resume = true` when `flags.implicitResume === true` so the rest of the pipeline (e.g. Step 5's execute resume forwarding) sees a unified `flags.resume` regardless of whether the user typed `--resume` or the hook triggered it.

**Missing-state prompt:** If the prepare output's `errors` array contains an entry with `id === "implicitResumeNoState"`, use AskUserQuestion:

> Active pipeline reminder found but no state file for current branch. Start fresh, or specify a state path?

Options:
- **fresh** — re-invoke `skill/ship.js` without `--hook-active-pipeline` so the pipeline starts cleanly
- **path** — ask the user for an explicit state file path, then re-invoke with `--state-file <path>`
- **abort** — exit cleanly without dispatching any step

Read `./resources/state-format.md` when resuming from a state file.

### 1f. Context detection

Print the `context` object values from the `skill/ship.js` output as a labeled list: plan-in-context, uncommitted changes (count), current branch, default branch, `gh` auth status, OpenSpec detection, and `.sdlc/` gitignore status.

**Contradictory-signal override:** After printing the context detection block, IF `context.openspecAuthoritative.path` is set AND the current session-start `<system-reminder>` contains a line matching `/openspec.*not initialized|not initialized.*openspec/i`, print exactly one line:
`Ignoring contradictory 'not initialized' signal in session context — openspec/config.yaml exists (authoritative source: SDLC's own check via ship.js prepare output).`
Then continue the flow. If the contradictory phrase is absent, emit nothing.

### 1g. Auto-skip logic

Print each step from the `steps` array in the `skill/ship.js` output as `<name>: <status> — <reason>` (e.g. `execute: will_run — plan detected in context`, `version: skipped (auto) — tags are repo-global`).

For a `skipped` step, append the `skipSource` field in parentheses after `skipped`:
- `(cli)` — user passed `--steps` on the command line
- `(quick)` — step is canonical but absent from `ship.quick` under an active `--quick` run; `flags.sources.steps === 'quick'` in the prepare output
- `(config)` — skip set loaded from `.sdlc/local.json` (`ship.steps[]` omitted the step)
- `(auto)` — auto-skipped by `computeSteps` logic (e.g., worktree mode)
- `(condition)` — conditional step whose condition was not met
- `(default)` — built-in defaults excluded the step

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
| 8 | learnings-commit | will_run | (inline shell — see "After pr — learnings-commit" below) | no |

Two opt-in inline steps, `verify-pipeline` and `await-remote-review`, insert after pr-sdlc only when listed in `flags.steps`; see their dedicated Step 5 subsections for args and pause behavior.

### --auto Mode Audit

Not all sub-skills support `--auto`. This table is the source of truth:

| Sub-skill | --auto support | Behavior when ship runs with --auto |
|-----------|---------------|--------------------------------------|
| execute-plan-sdlc | No | Forwards `--quality <X>` only when the user explicitly passed `--quality` to ship; otherwise no quality flag is forwarded and execute-plan-sdlc applies its own selection logic. |
| commit-sdlc | Yes | `--auto` forwarded. Skips commit approval prompt. |
| review-sdlc | No | No interactive prompts to skip — runs fully automatically already. |
| received-review-sdlc | Yes | `--auto` forwarded. Skips Step 10 consent prompt and Step 12 reply/resolve prompt. Critique gates and verification still run. Only "will fix" items auto-implemented; threads for "will fix" items auto-resolved. Items with 'disagree' / 'won't fix' / 'needs discussion' verdicts are never auto-actioned; only 'agree, will fix' is applied. |
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
- When `flags.sources.steps === 'quick'` in the prepare output, verify that `flags.steps` is non-empty (an error would have fired if `ship.quick` was missing — non-empty confirms the quick profile resolved correctly). Cite `flags.sources.steps`, NOT raw `--quick` or `$ARGUMENTS`, at all decision sites.
- `--quick` and `--steps` are mutually exclusive — an error fires if both are present; surface it from `errors[]` in prepare output, do not re-check independently.
- At least one step will run
- Flag combinations are coherent (`--bump` without version step → warn). `--bump` accepts `major|minor|patch` or any pre-release label matching `^[a-z][a-z0-9]*$` (e.g. `--bump rc` ships an RC release; the label is forwarded verbatim to version-sdlc).

---

## Step 4 (DO): Present Pipeline and Confirm

### Dry-run mode

If `--dry-run`, redisplay the Step 2 pipeline table plus the review threshold and any interactive-pause steps, then stop — do not dispatch anything.

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

**The LLM does not have authority to skip planned steps based on its own assessment of change complexity or risk** (added after the review step was skipped on a 'just docs/config' judgement — issue #68).

### Context budget — dispatch isolation

All sub-skills are Agent-dispatched for context isolation: each Agent loads its SKILL.md in its own context and returns only a structured result (5–10 lines). The ship pipeline's context receives structured data, not sub-skill definitions.

`execute-plan-sdlc` is the orchestrator and returns a Step-9-formatted result (waves completed, files modified, state file path) for ship's main-context loop to consume. Agent dispatch returns control to ship-sdlc after execute completes, enabling branch migration, the staging window, and remaining steps. `execute-plan-sdlc` bounds its own context impact by dispatching one wave-runner Agent per wave rather than per task.

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

3. **Dispatch Agent** with: skill name, args from `step.invocation`, model from `step.model` (which natively carries the correctly mapped suffix from ship.js), and brief pipeline context (branch, previous step results needed for this step). Pass `model: step.model` to the Agent tool on every dispatch. When `step.isolation` is non-null, additionally pass `isolation: step.isolation`; when `step.isolation` is null, omit the `isolation` parameter entirely (the Agent tool schema does not accept `null` for `isolation`). The LLM must not add, remove, or change the `isolation` parameter from what `ship.js` computed. Agent prompt template:
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

6. **Record step completion/failure** via state/ship.js.

7. **Use result to determine next step** (e.g., review verdict → received-review decision). Print decision reasoning:
   ```
     Review verdict: APPROVED WITH NOTES (2 medium)
     Decision: CONTINUING — no critical/high issues found
   ```

---

Ship-sdlc retains full control of: pipeline table display, validation output, step progress headers, result formatting, state persistence messages, verdict-based flow decisions, and the final summary report. Sub-skills only execute their skill and return structured data — they do not print pipeline-level output.

### Main-thread TodoWrite orchestration

ship-sdlc surfaces live pipeline progress in the Antigravity Code task tray via main-thread `TodoWrite` calls (if the tool is available). All derivation logic lives in `scripts/lib/ship-todos.js`. Skip entirely when `flags.steps.length < 2`.

**For every event below:** run `node "<PLUGIN_ROOT>/scripts/lib/ship-todos.js" --state-file "$STATE_FILE" <event args>`, parse the JSON from stdout, call `TodoWrite` with the `todos[]` array if the tool is available (otherwise ignore), and echo `marker` verbatim to stdout (audit trail).

| Event args | When to call |
|---|---|
| `--event init` | Once, BEFORE the Step 5 dispatch loop |
| `--event step --current-step <stepName>` | Start of EACH Step 5 iteration, BEFORE the progress header |
| `--event step --current-step <stepName> --mark-completed <stepName>` | AFTER the Agent return and result print, AFTER `state/ship.js complete` has persisted status=completed on disk (ship-todos reads the state file, so ordering matters) |
| `--event step --current-step <stepName> --fail-step <stepName>` | AFTER `state/ship.js fail` records a failure (no todo lingers `in_progress` — the helper enforces this) |
| `--event resume --current-step <resume.nextPendingStep>` | Inside the implicit-resume banner block, BEFORE the pipeline table prints, when `flags.resume === true` (the single gate — unifies explicit `--resume` and `flags.implicitResume`) |
| `--event cleanup --current-step cleanup` | Before invoking the Terminal cleanup Bash command (see below) |

**Cross-skill note:** `execute-plan-sdlc`'s internal per-wave `TodoWrite` calls remain (Agent-context bookkeeping). They are NOT parent-visible — see `execute-plan-sdlc/SKILL.md` Progress signal section.

### Workspace isolation and branch setup

**Skip on resume re-entry** (`flags.resume === true`) or when `WORKSPACE_MODE = continue` — the resume block below already handled mode/cwd, and continue requires no setup.

When NOT resuming, resolve workspace mode, enforce default-branch guard, assert correct cwd, and create branch/worktree by calling the unified setup script. Derive `<logical-type>` and `<derived-slug>` from the plan title in context:

```shell
SETUP_JSON=$(node "<PLUGIN_ROOT>/scripts/util/ship-workspace-setup.js" \
  --workspace-flag "$WORKSPACE_MODE_FLAG" \
  --prepare-output-file "$PREPARE_OUTPUT_FILE" \
  --logical-type "<logical-type>" \
  --derived-slug "<derived-slug>")
```
> **Contract (Input/Output):**
> - **Input**: Workspace flags — `--workspace-flag`, `--prepare-output-file`, `--logical-type`, `--derived-slug`.
> - **Output**: A single JSON line on stdout containing `status`, `workspaceMode`, `executeBranch`, and `worktreePath`. Exit 0 on success; 1 on a user-facing error; 2 when `scripts/lib/config.js` cannot be located.

Where `$WORKSPACE_MODE_FLAG` is set from the `--workspace` CLI flag parsed by the prepare script, and `$PREPARE_OUTPUT_FILE` is the path to the prepare JSON file.

Parse the output `SETUP_JSON` from stdout:
1. If `status` is `"error"`, print the error message and halt.
2. Extract `workspaceMode`, `executeBranch`, and `worktreePath`.
3. If `worktreePath` is set (non-empty), the LLM must explicitly use `worktreePath` as the current working directory (`Cwd` parameter) for all subsequent shell commands and Agent dispatches (e.g. `execute-plan-sdlc`, `commit-sdlc`, `review-sdlc`, `pr-sdlc`, etc.). If `worktreePath` is empty, continue using the current workspace directory.
4. Pass `--branch "$executeBranch"` to `execute-plan-sdlc` in the execute dispatch (see "Execute step" section below) so execute-plan-sdlc knows which branch is active.

The setup script handles ship state migration (`state/ship.js` migrate) internally before creating any branch or worktree.

### Execution loop

**Execute step resume:** When the pipeline is resuming (gate on `flags.resume === true` from the prepare output — this is `true` whether the user typed `--resume` or the hook triggered implicit resume; do NOT re-parse `$ARGUMENTS`) and the execute step's status in the ship state file is `in_progress`:
1. Check for `<main-worktree>/.sdlc/execution/execute-<branch>-*.json` (an execute-plan-sdlc state file for the current branch). Resolve `<main-worktree>` from the `mainWorktree` field of `node "<PLUGIN_ROOT>/scripts/util/worktree-lifecycle.js" resolve --branch <branch>` (that field is returned whether or not a linked worktree was `found`).
2. If found, dispatch execute-plan-sdlc via the Agent tool with args from `step.invocation` plus `--resume` (e.g. `"--quality <X> --resume"` if the user passed `--quality` to ship; `"--resume"` otherwise). Wave progress and gates run inside the Agent's sub-context; the structured return value drives the next step. `flags.resume` is the single resume signal regardless of source.
3. If not found, dispatch via Agent tool normally using `step.invocation` (execute restarts from scratch)

ship-sdlc does not manage execute-plan-sdlc's state file — execute-plan-sdlc handles its own creation, updates, and cleanup.

**Worktree re-entry on resume:** Check `context.worktree.inLinkedWorktree` from the skill/ship.js output. If true, already in the worktree — proceed normally.

If false (resuming from the main worktree but the pipeline originally ran in a worktree), resolve the worktree for the branch recorded in the ship state file:
```bash
node "<PLUGIN_ROOT>/scripts/util/worktree-lifecycle.js" resolve --branch <resume-branch>
```
`resolve` prints `{"found":true,"path":"...","mainWorktree":"...","branch":"...","exists":true,"matchedBy":"branch"|"cwd"}` when the branch has a linked worktree (or the cwd itself matches one, when the branch name doesn't), or `{"found":false,"mainWorktree":"..."}` when no worktree matches. If `found` and `exists`, `cd <path>`. If `found` but not `exists`, warn `Worktree <path> is registered but missing — run git worktree prune; falling back to current branch` and continue on the current branch.

**Execute-step todo mirroring:**

Assign `PLAN_FILE` from `extract-plan-file.js`. **This script does NOT print the plan path — it prints the path of a temp JSON manifest** (scripts never write raw JSON to stdout). Run it, then read the manifest it names and take `.planFile`:

```shell
EXTRACT_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/extract-plan-file.js" "$PREPARE_OUTPUT_FILE")
```
> **Contract (Input/Output):**
> - **Input**: One positional argument — the prepare output file path.
> - **Output**: Prints the path of a temp JSON manifest on stdout. Read that file and `JSON.parse` it; the shape is `{ ok, planFile, errors }`. Exit 0 = success, 1 = validation error (`ok` is `false`, `errors[]` is non-empty), 2 = crash.

Read `$EXTRACT_OUTPUT_FILE`, parse it, and set `PLAN_FILE` to its `.planFile` value. If `ok` is `false`, surface `errors[]` and stop. Then run `rm -f "$EXTRACT_OUTPUT_FILE"` to clean up the temp output file.

Where `$PREPARE_OUTPUT_FILE` is the path to the temp file holding the `skill/ship.js` JSON output. When `PLAN_FILE` is empty, the `ship-todos.js` execute event will fail. Surface that error before dispatching.

Before dispatching `execute-plan-sdlc`, run:

```bash
node "<PLUGIN_ROOT>/scripts/lib/ship-todos.js" --state-file "$STATE_FILE" --plan-file "$PLAN_FILE" --event execute --current-step execute
```
> **Contract (Input/Output):**
> - **Input**: `--state-file`, `--event`, `--current-step`.
> - **Output**: Updates the IDE Todo UI and prints confirmation.

`$PLAN_FILE` is the resolved plan file path. The helper expands the `execute` step's placeholder substep to one substep per plan task (one `### Task N:` heading per substep). Parse JSON. If the `TodoWrite` tool is available, call it. Echo `marker` verbatim to stdout.

Then dispatch `execute-plan-sdlc` as below. On Agent return (success), run the post-execution completeness invariant **before** marking the step complete:

```shell
node "<PLUGIN_ROOT>/scripts/util/verify-completeness.js" --state-file "$STATE_FILE" --plan-file "$PLAN_FILE"
```
> **Contract (Input/Output):**
> - **Input**: `--state-file`, `--plan-file` (both required).
> - **Output**: Evaluates task completeness and exits non-zero if incomplete. On failure it also emits the "execute step failed" TodoWrite payload itself (JSON on stdout, `marker` on stderr) — no separate `ship-todos.js --fail-step` call is needed.

If `verify-completeness` exits 65, the pipeline MUST halt before commit. The missing task IDs appear on stderr as JSON `{missingIds, totalPlanned, totalAccounted}`. Do NOT advance to the commit step.

Then run per-step-completion: `node "<PLUGIN_ROOT>/scripts/lib/ship-todos.js" --state-file "$STATE_FILE" --event step --current-step execute --mark-completed execute`. The parent does NOT receive per-task completion signals from the Agent; per-task todos all transition to `completed` atomically on return.

Example dispatch sequence (use `step.invocation` for actual args):
- Agent: execute-plan-sdlc, args: from `step.invocation` PLUS `--branch "$EXECUTE_BRANCH"` when `EXECUTE_BRANCH` is set (i.e. `WORKSPACE_MODE` is `branch` or `worktree`). When `WORKSPACE_MODE` is `continue`, omit `--branch` (execute handles its own isolation or runs on existing branch). Example: `"--quality balanced --branch feat/my-feature"`. execute-plan-sdlc short-circuits its own Step 1 isolation in response.
- Agent: commit-sdlc, args: `"--auto"`
- Agent: review-sdlc, args: `"--committed"`
- Agent: received-review-sdlc, args: `"--auto"` (when `flags.auto`; otherwise no args)
- Agent: version-sdlc, args: `"patch"`
- Agent: pr-sdlc, args: `"--auto --draft"`

### Post-execute note

Branch migration runs **before** the execute dispatch — inside the workspace isolation block (see the "Workspace isolation and branch setup" section above). There is no post-execute migration block.

Subsequent state operations (`start`, `complete`, `read`) automatically pick up the renamed file because `state/ship.js` resolves by current branch.

### Between execute and commit

execute-plan-sdlc creates and modifies files but does not stage them. Stage them through the ship git-ops script:

```bash
node "<PLUGIN_ROOT>/scripts/util/ship-git-ops.js" stage-post-execute
```

The script owns the staging command (`git add -A -- ':!.sdlc/'` — `.sdlc/` is excluded so runtime state is never committed) and then reports the resulting index. Branch on its JSON:

- `{"staged":["src/middleware/auth.ts", ...]}` (exit 0) — print each staged path, the total count, and the reason (execute-plan-sdlc creates files but does not stage them; `.sdlc/` is excluded to prevent committing runtime state).
- `{"staged":[],"error":"<message>"}` (exit 1) — staging failed. Show the `error` and stop the pipeline.

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

### After version — post-version ancestry HARD GATE

After the version step dispatches and returns, capture the new tag from the version-sdlc return value as `NEW_TAG`. When `NEW_TAG` is set (non-empty) AND `EXECUTE_BRANCH` is set (non-empty), run the ancestry check:

```shell
node "<PLUGIN_ROOT>/scripts/util/verify-ancestry.js" --new-tag "$NEW_TAG" --execute-branch "$EXECUTE_BRANCH"
```
> **Contract (Input/Output):**
> - **Input**: `--new-tag <tag>` and `--execute-branch <branch>` — passed as explicit flags (the shell original read them from ambient `NEW_TAG` / `EXECUTE_BRANCH` env vars).
> - **Output**: Fails if the branch is not properly rebased. Exit 0 when the tag is an ancestor (or the check is a no-op); non-zero halts the pipeline with the remediation steps printed to stderr.

`NEW_TAG` is the tag string emitted by version-sdlc (e.g. `v1.2.3`). `EXECUTE_BRANCH` is the feature branch variable set during pre-execute workspace isolation (already available in the pipeline shell context). This gate is a **no-op when `NEW_TAG` is unset** (version step was skipped or not in `flags.steps`, e.g., under `workspace: worktree`). Works correctly under both `workspace: branch` and `workspace: worktree`.

### Between version and pr — archive-openspec (conditional)

If the `archive-openspec` step has `status: "conditional"` in the pipeline plan, execute it inline (no Agent dispatch — this is a deterministic shell operation):

1. Extract the change name from `step.args` (`--change <name>`).
2. Validate the change (wraps `lib/openspec.js::validateChangeStrict`):
   ```shell
   VALIDATE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/openspec-validate.js" '<name>')
   ```
   > **Contract (Input/Output):**
   > - **Input**: One positional argument — the change `<name>`.
   > - **Output**: **Prints the path of a temp JSON manifest on stdout, not raw JSON.** Read that file and `JSON.parse` it; the shape is `{ ok, stdout, stderr, cliAvailable, errors }`. Exit 0 when `ok` is `true`, 1 when `ok` is `false`, 2 on crash.
3. Read `$VALIDATE_OUTPUT_FILE` and parse it. **If `ok === false`:** halt the pipeline. Print the validation errors (`stderr` / `errors[]` from the manifest) and save state for `--resume`. Then run `rm -f "$VALIDATE_OUTPUT_FILE"` to clean up the temp output file.
4. **If `ok === true`:** prompt the user for approval (skip prompt in `--auto` mode).
5. On approval, run the archive:
   ```shell
   ARCHIVE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/openspec-archive.js" '<name>')
   ```
   > **Contract (Input/Output):**
   > - **Input**: One positional argument — the change `<name>`.
   > - **Output**: Same temp-manifest-path + `{ ok, stdout, stderr, cliAvailable, errors }` contract as the validate step above. Exit 0 when `ok` is `true`, 1 when `ok` is `false`, 2 on crash.

   Read `$ARCHIVE_OUTPUT_FILE` and parse it to confirm `ok === true` before continuing. Then run `rm -f "$ARCHIVE_OUTPUT_FILE"` to clean up the temp output file.
6. If archive succeeds, commit it through the ship git-ops script:
   ```bash
   node "<PLUGIN_ROOT>/scripts/util/ship-git-ops.js" commit-openspec-archive --change '<name>'
   ```
   The script re-checks `isArchived()` **before** staging anything, then runs the `git add openspec/` + `git commit -m "chore(openspec): archive <name>"` pair itself. Branch on its JSON:
   - `{"committed":true}` (exit 0) — the archive commit landed.
   - `{"committed":false,"reason":"not-archived"}` (exit 0) — the change is not archived, so nothing was staged or committed. Report it and continue.
   - `{"committed":false,"reason":"clean"}` (exit 0) — already archived and already committed; nothing to commit. Report "already archived" and continue.
   - `{"committed":false,"reason":"<git error>"}` (exit 1) — the add or commit failed. Show the `reason` and stop the pipeline.
7. If `isArchived(projectRoot, name)` already returns true (idempotence), skip with reason "already archived".

If the step has `status: "skipped"`, print the skip reason from `step.reason`.

### After pr — verify-pipeline and await-remote-review (conditional, opt-in)

Both are optional inline steps (no Agent dispatch — deterministic polling scripts), gated by step membership in `flags.steps` (cite `step.status === "will_run"` from the prepare output, not `$ARGUMENTS`). If a step's `status` is `"skipped"`, print `step.reason` and do nothing.

Each wrapper below takes the args from `step.args` plus `--state-file <ship-state-path>` — there is no separate path-resolution step; the wrapper locates its underlying `scripts/skill/*.js` script and forwards every argument to it unchanged, then prints a single JSON line on stdout. Exit 2 (with a locate error on stderr) only if the underlying script is missing; otherwise the wrapped script's own exit code. Do NOT replicate polling, log fetching, or fix-application logic in this prose — that lives in the wrapped scripts and the `verify-pipeline-sdlc` skill.

#### verify-pipeline

```shell
node "<PLUGIN_ROOT>/scripts/util/verify-pipeline.js" $STEP_ARGS --state-file "$SHIP_STATE_PATH"
```

Parse the JSON line. Branch on `status`:

   **`status === "green"`** — log `verify-pipeline: CI green for PR #N` and proceed to `await-remote-review`.

   **`status === "failed"`** AND `flags.auto === false` — interactive. Use `AskUserQuestion`:
   > Wave verify-pipeline failed for PR #N. <X> failed checks: <names>.
   >
   > Options: **analyze** (Recommended) | **skip** | **abort**
   - **analyze**: dispatch `verify-pipeline-sdlc` subagent (Agent tool, model gemini-3.8-flash-high) with `--pr <N>` and `--logs <inline-log-excerpt-from-failedChecks>`. On verdict `fix-applied`, dispatch `commit-sdlc` (Agent tool, model gemini-3.8-flash-medium, `--auto`) directly to commit and push. Then re-run verify-pipeline (loop). Iteration cap = `flags.verifyPipelineMaxIterations` (default 3); after cap, log warning and proceed to `await-remote-review`. The pre-existing `commit-fixes` step entry (already visited before `pr`) is NOT involved — this dispatch is direct via the Agent tool.
   - **skip**: log warning, proceed to `await-remote-review`.
   - **abort**: write `verifyPipelineExhausted: true` to the ship state file, exit pipeline 1.

   **`status === "failed"`** AND `flags.auto === true` — non-interactive. Directly dispatch `verify-pipeline-sdlc` subagent (Agent tool, model gemini-3.8-flash-high) with `--pr <N> --logs <excerpt> --auto`. On `fix-applied`, dispatch `commit-sdlc --auto` directly (Agent tool, model gemini-3.8-flash-medium). Loop with the same iteration cap (`flags.verifyPipelineMaxIterations`). On cap exhaustion, log warning and proceed.

   **`status === "timeout"`** — log warning `verify-pipeline: timeout after Ns`. The script has already written `verifyPipelineExhausted: true` to the state file. Proceed to `await-remote-review`.

   **`status === "skipped"`** (resume short-circuit) — log info `verify-pipeline: skipped (resumed from prior exhaustion)`. Proceed.

   **`status === "error"`** — log warning `verify-pipeline: error — <reason>`. Proceed.

#### await-remote-review

```shell
node "<PLUGIN_ROOT>/scripts/util/await-review.js" $STEP_ARGS --state-file "$SHIP_STATE_PATH"
```

Parse the JSON line. Branch on `status`:

   **`status === "actionable"`** — directly dispatch `received-review-sdlc` (Agent tool, model gemini-3.8-flash-high) with `--pr <verdict.prNumber>` (and `--auto` when `flags.auto === true`). After the subagent completes, run `git status --porcelain` in the main context; if there are working-tree changes, directly dispatch `commit-sdlc` (Agent tool, model gemini-3.8-flash-medium, `--auto`) to commit and push. The pre-existing `received-review` and `commit-fixes` step entries (already visited before `pr`) are NOT involved — these dispatches are direct via the Agent tool.

   **`status === "approved-clean"`** — log `await-remote-review: APPROVED by <reviewer>` and proceed. Do NOT dispatch received-review-sdlc.

   **`status === "timeout"`** — log warning `await-remote-review: timeout after Ns waiting for <reviewers>`. The script has already written `awaitRemoteReviewExhausted: true` to the state file. Proceed.

   **`status === "skipped"`** (resume short-circuit) — log info and proceed.

   **`status === "error"`** — log warning and proceed.

### After pr — learnings-commit (final step)

Pipeline-level learnings cannot land in the feature commit — review/version/pr/archive all run *after* the feature commit. The `learnings-commit` step exists to capture them in a trailing chore commit so post-pipeline `git status` is clean.

If the `learnings-commit` step has `status: "will_run"`, execute it inline (no Agent dispatch — deterministic shell):

1. Run the ship-level Learning Capture (see the `## Learning Capture` section below) — append any new entries to `.sdlc/learnings/log.md`.
2. Commit them through the ship git-ops script:
   ```bash
   node "<PLUGIN_ROOT>/scripts/util/ship-git-ops.js" commit-learnings
   ```
   The script owns the whole sequence: it no-ops when `.sdlc/learnings/log.md` has no diff, otherwise stages that one file, commits it as `chore(ship-sdlc): capture pipeline learnings`, pushes, and then asserts the post-condition that `git status --porcelain` is empty. Branch on its JSON:
   - `{"committed":false,"reason":"clean"}` (exit 0) — nothing changed. Skip the commit and report `learnings-commit: no-op (no new learnings)`.
   - `{"committed":true,"pushed":true}` (exit 0) — the commit landed and was pushed.
   - `{"committed":true,"pushed":false,"reason":"<push error>"}` (exit 0) — push failure (offline, auth) is **never** fatal. Report the `reason` but do **not** halt the pipeline — the local commit still lands and a follow-up `git push` will deliver it.
   - `{"committed":false,"reason":"<git error>"}` (exit 1) — the add or commit failed. Show the `reason` and stop.
   - Any result additionally carrying `"dirty":true` with `postConditionReason` (exit 1) — the working tree was NOT clean after the learnings commit, which it MUST be. Surface `postConditionReason` and stop.

If the step has `status: "skipped"` (omitted from `--steps` or `ship.steps[]`), print the skip reason from `step.reason` and do not perform any of the above. The execute-plan-sdlc-level Learning Capture still runs and lands in the feature commit; only the ship-level append is conditional on this step.

### Between last commit and version — rebase on default branch

After all commits are done (feature commit + optional review-fix commit + optional archive commit), rebase onto the latest default branch to ensure a clean merge:

```bash
node "<PLUGIN_ROOT>/scripts/util/rebase-onto-base.js" --base <defaultBranch>
```

The script owns the whole sequence: it fetches the base from `origin` (the remote is hardcoded), skips the rebase when `origin/<defaultBranch>` is already an ancestor of HEAD, and on conflict collects the conflicting paths and runs the abort itself so the repo is never left mid-rebase. It ALWAYS exits 0 — branch on `status`, never on the exit code:

- `{"status":"up_to_date"}` — the branch already contains the base tip. Print "Already up to date with `<defaultBranch>`" and skip.
- `{"status":"clean","sha":"<new-head-sha>"}` — rebased successfully; `sha` is the new HEAD. Print the summary and continue.
  ```
  Rebase: clean — replayed on origin/<defaultBranch> (HEAD now <sha>)
  ```
- `{"status":"conflicts","files":["src/foo.ts", ...]}` — the rebase did not apply and has already been aborted for you. List `files` and handle per mode below.
- `{"status":"fetch_failed","remote":"origin","base":"<defaultBranch>","error":"<stderr>"}` — the fetch itself failed (network, auth, unknown remote). Print "Could not fetch `<remote>/<base>`: `<error>` — skipping rebase; branch may be behind base" and continue (non-fatal, same posture as `conflicts`).

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

Note: in a worktree, all of this is safe — main working tree is untouched (the script runs in the current cwd).

### State persistence

After each step, update pipeline state by calling the ship state CLI directly: `node "<PLUGIN_ROOT>/scripts/state/ship.js" <subcommand> [flags]`. Every argument is a subcommand plus its flags — nothing is rewritten on the way in.

At pipeline start (after Step 1 completes), initialize the state file:
```bash
node "<PLUGIN_ROOT>/scripts/state/ship.js" init --branch <branch> --flags '<flags JSON>'
```
> **Contract (Input/Output):**
> - **Input**: Subcommand (`init`, `start`, `complete`, `skip`, `fail`, `decide`, `defer`, `migrate`, `cleanup-pipeline`, …) and its flags.
> - **Output**: Mutates pipeline state files.

Before each step: `node "<PLUGIN_ROOT>/scripts/state/ship.js" start --step <name>`
After each step: `node "<PLUGIN_ROOT>/scripts/state/ship.js" complete --step <name> --result "<summary>"` (or `skip --step <name> --reason "<reason>"` or `fail --step <name> --error "<error>"`)
Record decisions: `node "<PLUGIN_ROOT>/scripts/state/ship.js" decide --step <name> --text "<decision>"`
Defer findings: `node "<PLUGIN_ROOT>/scripts/state/ship.js" defer --severity <s> --file <f> --title "<t>"`

### Terminal cleanup step

The prepare-script output (`steps[]` array) ends with a synthetic step named `cleanup` (`status: "will_run"`, `skill: null`, `reserved: true`). It is appended unconditionally by `skill/ship.js::computeSteps` and is NOT user-configurable — listing `cleanup` in `--steps` or `ship.steps[]` produces a validation error in Step 1c.

Dispatch the cleanup step **as a direct Bash call**, not as an Agent. Each `cleanup` step entry has an `invocation` object with two precomputed command variants; substitute the absolute plugin path for `$SCRIPT` (replace `"node \"$SCRIPT\""` with `node "<PLUGIN_ROOT>/scripts/state/ship.js"`):

```json
{
  "method": "bash",
  "normal": "node \"<PLUGIN_ROOT>/scripts/state/ship.js\" cleanup-pipeline",
  "forced": "node \"<PLUGIN_ROOT>/scripts/state/ship.js\" cleanup-pipeline --force"
}
```

**Cleanup-step todo:** fire the `--event cleanup` TodoWrite call (see the table above) before invoking the cleanup Bash command below. After the cleanup command returns (success or contract violation), fire the `--mark-completed cleanup` completion event.

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

Run `rm -f "$PREPARE_OUTPUT_FILE"` to clean up the temp output file. Unlike the other temp output files (each read once and cleaned up immediately after), `$PREPARE_OUTPUT_FILE` is re-read throughout the pipeline, so it is cleaned up only here, at the very end.

---

## Step 6 (REPORT): Pipeline Summary

Print a summary report containing, in order:
1. A `Step | Skill | Result` table, one row per pipeline step, using `[done] <outcome>` (commit hash, verdict, PR URL, etc.) or `— not triggered` / `— skipped (<reason>)`.
2. A **Decisions log** listing key resolved decisions: steps resolved and their source, whether `--quality` was forwarded, version bump/skip reason, review-threshold outcome, and any `--draft`/base-branch flags used.
3. **Deferred review findings** (if any): one line per finding as `[severity] file:line — description`, followed by `→ Run /received-review-sdlc to address these`.
4. The state-file cleanup confirmation line (path deleted).

Then append an OpenSpec follow-up line: `→ OpenSpec change "<name>" archived and committed.` if OpenSpec was detected in Step 1f and archive-openspec ran successfully; otherwise, if OpenSpec was detected but archive-openspec was skipped or not triggered, append the `/opsx:verify` and `/opsx:archive` follow-up pointers.

### Worktree cleanup

Detect whether a linked worktree is active by resolving the pipeline's branch through the worktree lifecycle script:
```bash
node "<PLUGIN_ROOT>/scripts/util/worktree-lifecycle.js" resolve --branch <branch>
```
`resolve` prints `{"found":true,"path":"...","mainWorktree":"...","branch":"...","exists":true,"matchedBy":"branch"|"cwd"}` when the branch has a linked worktree, or `{"found":false,"mainWorktree":"..."}` when it does not — nothing to clean up in that case. A worktree is active when `found` is `true` and `path` differs from `mainWorktree`. `matchedBy` is `"branch"` for the normal case and `"cwd"` when the branch name itself matched no entry but the current directory's toplevel did — either way the same `exists`/cleanup handling applies.

**Auto mode:** keep (default). Print path and action:
```
Worktree kept: <path>
  Branch: <branch name>
  To remove later: node "<PLUGIN_ROOT>/scripts/util/worktree-lifecycle.js" remove --path <path>
```

**Interactive mode:** Use AskUserQuestion — keep or remove.
If remove:
```bash
node "<PLUGIN_ROOT>/scripts/util/worktree-lifecycle.js" remove --path <path>
```
`remove` runs from the resolved main worktree and refuses to delete it (exit 1 with `{"error":"refusing to remove the main worktree"}`); on success it prints `{"removed":true,"path":"..."}`.

If `remove` reports an `error`, warn but don't fail the pipeline.

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
| `ship-git-ops.js stage-post-execute` fails (returns `staged: []` with an `error`, exit 1) | Show error, stop pipeline | No — user action needed |
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

- Deviate from `step.dispatchMode` (§Step 5 Pre-step validation) — no synthesized `'skill'` value, no Skill-tool invocation from Step 5.
- Skip the critique step (Step 3) even when all checks seem obvious.
- Forward `--auto` to sub-skills that do not support it (see `--auto Mode Audit` table).
- Automatically resolve review findings — received-review-sdlc is always interactive.
- Run pipeline steps in parallel — the pipeline is strictly sequential.
- Delete the state file on failure, or proceed past a failed sub-skill — stop, save state, inform the user.
- Skip a step marked `will_run` in the confirmed pipeline plan — it is a contract with the user; only skill/ship.js's skip set and auto-skip rules decide which steps run.
- Copy example args from this document when dispatching sub-skill Agents — always use `step.invocation`.
- Add `--steps` flags not present in the user's original invocation, or resurrect the hard-removed legacy `--preset`/`--skip` flags.
- Dispatch pipeline step Agents without `model: step.model`, or add/remove/change the `isolation` parameter from `step.isolation` verbatim (§Dispatch protocol) — a stray `isolation: "worktree"` when `step.isolation` is null causes hidden Agent SDK worktrees that conflict with `--workspace branch`.
- Ignore a cleanup contract violation (`state/ship.js cleanup` exit 1) — surface it and preserve state, do not proceed to the success summary.
- Skip the post-version ancestry HARD GATE — the only safeguard against tags landing on orphaned commits (it is already a no-op when `NEW_TAG` is unset, so there is nothing to pre-empt).
- Exit the plan-mode-blocked path (Step 0) without running `rm -f "$PLAN_MODE_OUTPUT_FILE"` on every exit branch.

---

## Gotchas

**Verdict detection is text-based.** Parse the conversation for a line matching `Verdict: <VERDICT>`. The review-sdlc orchestrator always emits this. If the conversation is compacted between review and verdict parsing, the verdict may be lost — treat missing verdict as APPROVED WITH NOTES and warn the user.

**Double commit is intentional.** Feature commit (step 2) and review fix commit (step 5) are separate. This keeps feature work and review fixes distinct in git history. Do not squash them.

**Config file is optional.** The pipeline runs with built-in defaults when no ship config exists in `.sdlc/local.json`. Do not error on missing config.

**.sdlc/ must be gitignored** (see Step 1c's warning) **as the primary defense** — `ship-git-ops.js stage-post-execute`'s `git add` excluding `.sdlc/` is only a fallback.

**State files are script-managed.** Use state/ship.js / state/execute.js for all state operations. Don't hand-write JSON to `.sdlc/execution/`.

**Worktree lifecycle is script-driven.** `util/worktree-create.js` to create (handles branch collision), `util/worktree-lifecycle.js resolve` + `remove` to clean up. Never use EnterWorktree/ExitWorktree.

**Worktree state is not persisted.** Git is the source of truth: branch name + `util/worktree-lifecycle.js resolve --branch <branch>` yields the worktree path. Do not add worktree fields to state files.

**Worktree mode changes the version and PR steps.** `computeSteps` in skill/ship.js auto-skips the version step when `workspace === 'worktree'` (tags are repo-global) and adds `--label skip-version-check` to the PR step args so `gh pr create` carries the label from creation. Only worktree auto-skip triggers the label, not a `version` omitted from `ship.steps[]`; the label must already exist in the repository (pr-sdlc creates it if missing). Print the post-merge advisory (see "Post-pipeline advisory" above).

**Auto mode does not auto-resume without --resume.** When `--auto` is set but `--resume` is not, the pipeline starts fresh even if a state file exists for the current branch. The state file is preserved (not deleted) so the user can explicitly `--resume` later.

---

## Learning Capture

After completing the pipeline, append to `.sdlc/learnings/log.md`:

- Review verdicts that surprised (threshold too aggressive or too lenient)
- Sub-skills that failed in unexpected ways during chaining
- Config combinations that produced unintended pipeline shapes
- Projects where the default `steps[]` behavior was wrong, or migrations from legacy v1 configs (`ship.preset`/`ship.skip`) that produced unexpected `steps[]` after auto-migration. CLI `--preset`/`--skip` are no longer accepted; ship-sdlc emits a migration-pointer error if either is passed.

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
