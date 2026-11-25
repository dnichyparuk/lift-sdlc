---
name: ship-sdlc
description: "Use this skill when shipping a feature end-to-end after plan acceptance: executing, committing, reviewing, fixing critical issues, versioning, and opening a PR in one flow. Dispatches every sub-skill (including execute-plan-sdlc) as an Agent for context isolation, with structured return values driving the pipeline state machine. Arguments: [--auto] [--steps <csv>] [--quick] [--quality full|balanced|minimal] [--bump patch|minor|major|<label>] [--draft] [--dry-run] [--resume] [--plan <path>] [--workspace branch|worktree|prompt] [--branch | --tree] [--openspec-change <name>] [--init-config] [--gc] [--ttl-days <N>]. The `<label>` form for --bump (e.g. `--bump rc`) is forwarded to version-sdlc, where it is interpreted as `--bump patch --pre <label>`; labels must match `^[a-z][a-z0-9]*$`. Triggers on: ship it, ship this, full pipeline, execute to PR, ship feature, run the whole thing."
user-invocable: true
argument-hint: "[--auto] [--steps <csv>] [--quick] [--quality full|balanced|minimal] [--bump patch|minor|major|<label>] [--draft] [--dry-run] [--resume] [--plan <path>] [--workspace branch|worktree|prompt] [--branch | --tree] [--openspec-change <name>] [--init-config] [--gc] [--ttl-days <N>]"
---

# Ship Pipeline

End-to-end feature shipping: execute plan, commit, review, fix critical issues, version, and open a PR. Chains sub-skills sequentially with a conditional review-fix loop and deterministic `run_workflow` orchestration.

**Announce at start:** "I'm using ship-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

---

## Step 0 — Plan Mode Check & Flags

### Plan Mode Check

If the system context contains "Plan mode is active":

> **VERBATIM** — Run every `node` command in this file exactly as written, invoking the script with `node` and its absolute path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin. Pattern: `<PLUGIN_ROOT>/scripts/<group>/<script-name>.js` where `<group>` is `skill`, `util`, `lib`, `state`, or `ci`). Never modify, rephrase, or simplify the flags.

1. Invoke (`$ARGUMENTS` is forwarded verbatim):
   ```shell
   node "<PLUGIN_ROOT>/scripts/util/plan-mode-check.js" $ARGUMENTS
   ```
   > **Contract (Input/Output):**
   > - **Input**: ship-sdlc's `$ARGUMENTS`, forwarded to `skill/ship.js` after `--output-file --plan-mode-blocked`.
   > - **Output**: Prints `PLAN_MODE_OUTPUT_FILE=<path>` and `PLAN_MODE_EXIT=<code>`. Wrapper exits 0 when `ship.js` ran; read `PLAN_MODE_EXIT` for `ship.js`'s exit code (exit 2 only if `ship.js` could not be located).
2. If `PLAN_MODE_EXIT` is non-zero: show errors from the output file, run `rm -f "$PLAN_MODE_OUTPUT_FILE"`, and stop.
3. Read `$PLAN_MODE_OUTPUT_FILE`. Confirm `planModeBlocked === true` and extract `stateFile`, `flags.bump`, `flags.steps`.
4. Announce:
   > Plan mode is active. ship-sdlc requires write operations (git commit, gh pr create, git tag) and cannot run inside plan mode.
   >
   > **Pipeline state saved to `<stateFile>` with resolved flags:** bump=`<flags.bump>`, steps=`<flags.steps>`.
   >
   > Exit plan mode and re-invoke `/ship-sdlc` (no args needed) — implicit resume will pick up the saved state and resume from the first pending step with the originally-resolved flags intact (including `flags.planFile`).
5. Run `rm -f "$PLAN_MODE_OUTPUT_FILE"` on every exit branch.
6. Stop. Do not proceed to subsequent steps.

All gates cite resolved fields from prepare output (`planModeBlocked`, `stateFile`, `flags.bump`, `flags.steps`) — never re-parse `$ARGUMENTS` directly.

### Flags & Config Summary

- **Config source:** `.sdlc/local.json` (`ship` section, with legacy `.sdlc/ship-config.json` fallback). If the session-start system-reminder has a `Ship config:` line, treat it as a heads-up only — `skill/ship.js` is authoritative.
- **Explicit-only `--plan <path>`:** `--plan <path>`, `--plan-file <path>`, or a positional `*.md` path. `skill/ship.js` never scans directories or infers a plan from conversation context. Missing plan when `execute` will run yields `errors[*].id === "missingPlanFile"`.
- **Conditional CLI flags:** Forward `--plan`, `--bump`, `--workspace`/`--branch`/`--tree`, `--steps`, `--quality`, `--draft`, `--auto`, `--dry-run`, `--resume`, `--openspec-change`, `--ttl-days` ONLY when passed by the user (unconditional flags override `.sdlc/local.json`). Legacy `--preset` and `--skip` are hard-removed.
- **Implicit resume hook signal:** If the session-start `<system-reminder>` contains `/^Active pipeline: ship-sdlc/` AND the user did NOT type `--resume`, append `--hook-active-pipeline` to `raw_args` / `skill/ship.js`.

---

## Step 1a — Utility Subcommands & Prepare Contract

### 1a. `--init-config` handler

If `--init-config` was passed:

**Redirect:** Suggest running `/setup-sdlc` instead for unified configuration. If the user insists on `--init-config`, proceed:

1. Read `./resources/config-format.md` and run the interactive walkthrough (steps multi-select, optional `--quick` profile, bump type, auto, threshold, workspace isolation).
2. Run `ship-init.js` via `run_command` substituting the user's answers (append `--quick <csv>` only when selected):
   ```shell
   INIT_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/ship-init.js" --output-file --steps execute,commit,review,archive-openspec,pr --bump patch --auto --threshold high --workspace prompt)
   EXIT_CODE=$?
   echo "INIT_OUTPUT_FILE: $INIT_OUTPUT_FILE"
   echo "STATUS: $EXIT_CODE"
   ```
   > **Contract (Input/Output):**
   > - **Input**: `--steps <csv>`, `--bump patch|minor|major`, `--draft`, `--auto`, `--threshold critical|high|medium`, `--workspace branch|worktree|prompt`, `--rebase auto|skip|prompt`, optional `--quick <csv>`.
   > - **Output**: `--output-file` prints a temp JSON manifest path on stdout; exit 0 = success, 1 = validation error (`errors[]` non-empty), 2 = crash.
3. Read `$INIT_OUTPUT_FILE`: display `errors` (if any) or `created` files + `config` JSON.
4. Run `rm -f "$INIT_OUTPUT_FILE"` and stop.

### 1a-gc. `--gc` handler

If `--gc` (with optional `--ttl-days <N>`) was passed, short-circuit without running the pipeline:

```shell
PREPARE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/ship.js" --output-file --gc)
echo "PREPARE_OUTPUT_FILE=$PREPARE_OUTPUT_FILE"
```
Append `--ttl-days <N>` when provided.
> **Contract (Input/Output):**
> - **Input**: None (optional `--ttl-days <N>`).
> - **Output**: Garbage collects stale ship/execute state files whose branch is gone. Prints the temp JSON manifest path on stdout — capture into `PREPARE_OUTPUT_FILE`.

Read `$PREPARE_OUTPUT_FILE` (`action === "gc"`, `report: { ttlDays, ship: { deleted, kept }, execute: { deleted, kept } }`), print one line per file (`[deleted] <file> — <reason>` / `[kept] <file> — <reason>`), run `rm -f "$PREPARE_OUTPUT_FILE"`, and stop.

### Prepare `VERBATIM` Capture Block (`skill/ship.js`)

When invoking `skill/ship.js` directly (or inspecting prepare output):
```shell
PREPARE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/ship.js" --output-file --has-plan --auto)
EXIT_CODE=$?
echo "PREPARE_OUTPUT_FILE: $PREPARE_OUTPUT_FILE"
echo "STATUS: $EXIT_CODE"
```
> **Contract (Input/Output):**
> - **Input**: Current branch context plus conditional flags (`--plan "<path>"`, `--bump <type>`, `--workspace`/`--branch`/`--tree`, `--steps <csv>`, `--quality <tier>`, `--hook-active-pipeline`) — append only when applicable.
> - **Output**: Prints the path of a temp JSON manifest (via `writeOutput`) containing `flags`, `sources`, `context`, `resume`, `steps`, `validation`, `errors`, `warnings`, and `contextAdvisory`. Capture stdout into `PREPARE_OUTPUT_FILE`.

---

## Step 1a-engine — Native `run_workflow` & Pipeline Engine Router

Check `.sdlc/local.json` for `ship.engine`:

1. **`ship.engine === "pipeline-sdlc"`:**
   Announce:
   > Delegating to pipeline engine (`/pipeline-sdlc`) with manifest `skills/ship-sdlc/pipeline.json`.

   Invoke `/pipeline-sdlc --manifest skills/ship-sdlc/pipeline.json $ARGUMENTS` via the Skill tool and stop.

2. **`ship.engine !== "legacy"` (default — native `run_workflow`):**
   Announce:
   > Delegating to native `run_workflow` orchestrator (`skills/ship-sdlc/workflows/ship.py`).

   Execute `skills/ship-sdlc/workflows/ship.py` via `run_workflow` (runs `execute.py`, `review.py`, and `verify.py` directly at Depth 1, deterministic preflight/rebase/ancestry/OpenSpec/CI-classify gates, and leaf `agent()` calls):
   - `Description`: `"Execute ship-sdlc pipeline"`
   - `Cwd`: current repository working directory
   - `Args`: `{ "raw_args": "$ARGUMENTS", "plugin_root": "<PLUGIN_ROOT>" }` (append `--hook-active-pipeline` to `raw_args` when the session-start reminder shows `Active pipeline: ship-sdlc` and `--resume` was not typed)
   - `Script`:
     ```python
     exec(open("<PLUGIN_ROOT>/skills/ship-sdlc/workflows/ship.py").read(), globals())
     await main()
     ```

   **Handle the structured JSON returned by `ship.py`:**

   - **`status === "gc"`:** Print GC report lines and stop.
   - **`status === "dry_run"`:** Display the pipeline table (`steps[]`), review threshold, interactive-pause steps, and `validation` summary, then stop.
   - **`status === "blocked"`:** Surface `errors[]` and stop:
     - If `errors` includes `id === "implicitResumeNoState"`, ask via `ask_question`:
       > Active pipeline reminder found but no state file for current branch. Start fresh, or specify a state path?
       Options: **fresh** (re-invoke `ship.py` without `--hook-active-pipeline`) | **path** (ask for path, re-invoke with `--state-file <path>`) | **abort**.
     - If `errors` includes `id === "missingPlanFile"`, suggest `--plan <path>` (or `--steps` without `execute`).
   - **`status === "needs_consent"` when `gate === "workspace_mode"` (PRE-INIT — no state file exists yet):**
     Present workspace selection via `ask_question` (**branch** | **worktree** | **continue** on `current_branch`). If approved, re-invoke `ship.py` **WITHOUT `--resume`** in `raw_args` and pass `workspace_flag: "branch"|"worktree"|"continue"` in `Args`.
   - **Post-init `status === "needs_consent"` / `"paused_conflicts"` / `"paused_gate"` (state file IS preserved on disk):**
     Present the gate prompt via `ask_question`. If approved, re-invoke `ship.py` **WITH `--resume`** appended to `raw_args` plus the gate's approval flag in `Args`:
     - **`gate === "high_risk_wave"`** (propagated from `execute.py`): ask via `ask_question` (**yes** | **skip** | **cancel**). On **yes**, re-invoke `ship.py` with `--resume` and `approve_high_risk: true`. On **skip**, re-invoke with `--resume` and `skip_high_risk: true`. On **cancel**, stop and preserve state for `/ship-sdlc --resume`.
     - **`gate === "commit"` | `"version"` | `"pr"`** (when not `--auto`): confirm `step` (`args` on `branch`) via `ask_question` (**yes** | **cancel**). On **yes**, re-invoke with `--resume` and `approve_commit: true` (covers `commit` / `commit-fixes`), `approve_version: true`, or `approve_pr: true` (`ship.py` forwards `--auto` to the leaf skill).
     - **`gate === "received_review"`:** Show `verdict`, `counts`, and `review_comment_file`; on approval, re-invoke with `--resume` and `approve_received_review: true`.
     - **`gate === "rebase_conflicts"`** (`needs_consent` or `paused_conflicts`): List conflicting `files` against `base`.
       - In `--auto` mode or when `status === "paused_conflicts"` (including failed fallback merge): stop, preserve state, and print `/ship-sdlc --resume` instructions.
       - In interactive mode: ask via `ask_question` (**Pause pipeline** — resolve manually then `/ship-sdlc --resume` | **Skip rebase** — re-invoke with `--resume` and `rebase_conflict_action: "skip"` | **Merge instead** — re-invoke with `--resume` and `rebase_conflict_action: "merge"`).
     - **`gate === "openspec_archive"`:** Confirm archiving OpenSpec `change`; on approval, re-invoke with `--resume` and `approve_openspec_archive: true`.
     - **`gate === "verify_pipeline"`:** Show failed CI checks for PR; ask via `ask_question` (**analyze** — re-invoke with `--resume` and `approve_ci_fix: true` | **skip** — re-invoke with `--resume` and `skip_ci_fix: true` | **abort**).
     - **`gate === "await_remote_review"`:** Show actionable remote review summary; on approval, re-invoke with `--resume` and `approve_remote_review: true`.
   - **`status === "completed"` or `"failed"`:** Render **Step 6 (REPORT)** below from the returned JSON (and run the interactive worktree keep/remove prompt when a linked worktree is active). Stop here.

3. **`ship.engine === "legacy"`:**
   Read `./resources/legacy-ship-workflow.md` and execute legacy Steps 1b–5 (manual `invoke_subagent` dispatch loop, `ship-todos.js`, inter-step gates, and error recovery), then continue to Step 6 below.

---

## Step 6 (REPORT): Pipeline Summary

Print a summary report containing, in order:

1. **Step table** (`Step | Skill | Result`): one row per pipeline step, using `[done] <outcome>` (commit hash, verdict, PR URL, etc.), `[failed] <error>`, or `— not triggered` / `— skipped (<reason>)`.
2. **Decisions log:** steps resolved and source, whether `--quality` was forwarded, version bump/skip reason, review-threshold outcome, and any `--draft`/base-branch flags used.
3. **Deferred review findings** (if any): one line per finding as `[severity] file:line — description`, followed by `→ Run /received-review-sdlc to address these`.
4. **State cleanup / failure resume line:**
   - On completion: state-file cleanup confirmation line (path deleted; surface `PIPELINE CONTRACT VIOLATION` if cleanup exited non-zero and do NOT print a success summary).
   - On failure:
     ```
     Step <N> (<name>) failed: <error summary>
     State saved to: <state file path>
     To resume: /ship-sdlc --resume
     ```
5. **Self-Learning Opportunity Advisory:** Use `learn_status` from `ship.py` output (or run `node "<PLUGIN_ROOT>/scripts/util/learn-status.js"` in legacy mode) and extract `eligibleCount` and `threshold`. If `eligibleCount > 0`, display:
   > 💡 **Self-Learning Opportunity:** {eligibleCount} recurring pattern(s) have met the recurrence threshold ({threshold}). Run `/learn-sdlc` to generate an automated guardrail proposal PR.
6. **OpenSpec follow-up line:** `→ OpenSpec change "<name>" archived and committed.` if OpenSpec was detected and `archive-openspec` succeeded; otherwise if OpenSpec was detected, append `/opsx:verify` and `/opsx:archive` pointers.

### Worktree cleanup

Check `worktree_status` from `ship.py` output (or resolve via `node "<PLUGIN_ROOT>/scripts/util/worktree-lifecycle.js" resolve --branch <branch>`). A linked worktree is active when `found === true` and `path !== mainWorktree`:

- **Auto mode:** Keep (default) and print:
  ```
  Worktree kept: <path>
    Branch: <branch name>
    To remove later: node "<PLUGIN_ROOT>/scripts/util/worktree-lifecycle.js" remove --path <path>
  ```
- **Interactive mode:** Ask via `ask_question` — **keep** or **remove**. On **remove**, run:
  ```bash
  node "<PLUGIN_ROOT>/scripts/util/worktree-lifecycle.js" remove --path <path>
  ```
  If `remove` reports an `error`, warn without failing the pipeline.

### Post-pipeline advisory (when version was auto-skipped)

If the `version` step is `skipped` with reason containing `"worktree"`, append:
```
Note: Version step was skipped (worktree mode — tags are repo-global).
After merging this PR, run on main:
  /version-sdlc <patch|minor|major>
This will tag the release and generate the changelog from all merged commits.
```

---

## DO NOT

- Deviate from `step.dispatchMode` — no synthesized `'skill'` value, no Skill-tool invocation for agent steps.
- Skip the critique/validation step even when all checks seem obvious.
- Forward `--auto` to sub-skills that do not support it (`execute-plan-sdlc`, `review-sdlc`).
- Automatically resolve review findings outside `--auto` — interactive `received-review-sdlc` requires consent.
- Run pipeline steps in parallel — the pipeline is strictly sequential.
- Delete the state file on failure, or proceed past a failed sub-skill — stop, preserve state, inform the user.
- Skip a step marked `will_run` in the pipeline plan — only `skill/ship.js`'s skip set and auto-skip rules decide which steps run.
- Copy example args when dispatching sub-skill Agents — always use `step.invocation`.
- Add `--steps` flags not present in the user's invocation, or resurrect hard-removed `--preset`/`--skip`.
- Dispatch pipeline step Agents without mapping `step.model` to a valid `agy` `Model` enum (`flash_lite|flash|pro|inherit`), or alter `Workspace` from `step.isolation` verbatim.
- Ignore a cleanup contract violation (`state/ship.js cleanup-pipeline` non-zero / `currentRun.valid === false`) — surface it and preserve state.
- Skip the post-version ancestry HARD GATE (`verify-ancestry.js`) when `NEW_TAG` is set.
- Exit the plan-mode-blocked path (Step 0) without running `rm -f "$PLAN_MODE_OUTPUT_FILE"` on every exit branch.
- Re-invoke `ship.py` with `--resume` after a pre-init `workspace_mode` consent pause (no state file exists yet — pass `workspace_flag` without `--resume`), or omit `--resume` after post-init consent pauses (`high_risk_wave`, `commit`, `received_review`, `rebase_conflicts`, `version`, `openspec_archive`, `pr`, `verify_pipeline`, `await_remote_review`).

---

## Gotchas, Learning Capture and What's Next

Read `./resources/gotchas-and-next-steps.md` for gotchas (verdict parsing, intentional double commit, `.sdlc/` gitignore, worktree lifecycle, no-auto-resume rule), Step 6 **Learning Capture** format, and **What's Next** follow-ups.

---

## See Also

- `./resources/legacy-ship-workflow.md` — full Steps 1b–5 manual orchestration and error recovery (`ship.engine === "legacy"`)
- `./resources/config-format.md` — `--init-config` walkthrough and `.sdlc/local.json` schema
- `./resources/state-format.md` — pipeline state schema for pause/resume
- `./resources/gotchas-and-next-steps.md` — gotchas, learning capture, and follow-ups
- [`/execute-plan-sdlc`](../execute-plan-sdlc/SKILL.md) | [`/commit-sdlc`](../commit-sdlc/SKILL.md) | [`/review-sdlc`](../review-sdlc/SKILL.md) | [`/received-review-sdlc`](../received-review-sdlc/SKILL.md) | [`/version-sdlc`](../version-sdlc/SKILL.md) | [`/pr-sdlc`](../pr-sdlc/SKILL.md)
