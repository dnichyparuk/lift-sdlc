# Legacy Ship Workflow (`ship.engine === "legacy"`)

Fallback manual orchestration for `ship-sdlc` when `.sdlc/local.json` explicitly sets `ship.engine: "legacy"`. In default mode (`ship.engine !== "legacy"`), `ship-sdlc` delegates to `skills/ship-sdlc/workflows/ship.py` via `run_workflow`.

Read `./gotchas-and-next-steps.md` (Gotchas section) before Step 5.

> **VERBATIM** — Run every `node` command in this file exactly as written, invoking the script with `node` and its absolute path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin). Do not modify, rephrase, or simplify the flags.

---

## Step 1b–1g (CONSUME): Load Config, Prepare Context & Compute Steps

### 1b. Load ship config

**Hook context fast-path:** If the session-start system-reminder contains a `Ship config:` line, note it for display. The prepare script (`skill/ship.js`) remains the authoritative source for config values.

Check for ship config via `skill/ship.js` output (reads `.sdlc/local.json` → `ship` section, with legacy `.sdlc/ship-config.json` fallback). Print loaded config verbosely:
```
Ship config loaded from .sdlc/local.json (schema v2)
  steps: [execute, commit, review, archive-openspec, pr], draft: false, bump: patch
  reviewThreshold: high
  execute.commitWaves: false
```

`execute.commitWaves` (default `false`) appends `--commit-waves` to the execute step invocation so `execute-plan-sdlc` commits `wip(execute): wave N — <titles>` after each wave and `commit-sdlc` later squashes them. Always cite `step.invocation`, never raw `config.execute.commitWaves`.
If not found: `No ship config found — using built-in defaults. Run /setup-sdlc to configure.`

**Legacy v1 auto-migration:** If the loader detects a v1 config (no top-level `version`, with `ship.preset` or `ship.skip`), it migrates in place to schema v2 and emits a single stderr deprecation notice.

### 1c. Prepare pipeline context

Run `skill/ship.js` to pre-compute flags, context, and step statuses:
```shell
PREPARE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/ship.js" --output-file --has-plan --auto)
EXIT_CODE=$?
echo "PREPARE_OUTPUT_FILE: $PREPARE_OUTPUT_FILE"
echo "STATUS: $EXIT_CODE"
```
> **Contract (Input/Output):**
> - **Input**: Current branch context, plus conditional flags below.
> - **Output**: Prints the path of a temp JSON manifest (via `writeOutput`) containing PR and ship status. Capture stdout into `PREPARE_OUTPUT_FILE`.

**Conditional flags — append only under the stated condition (never unconditionally):**
- **`--plan "<path>"`** — append when the user passed `--plan <path>`, `--plan-file <path>`, or a positional `*.md` path. Never infer from conversation or directory listings. On resume `skill/ship.js` reuses `flags.planFile` from state; otherwise it reports `missingPlanFile`.
- **`--bump <type>`** — append ONLY when explicitly passed. Accepts `major|minor|patch` or a pre-release label matching `^[a-z][a-z0-9]*$`.
- **Workspace mode** — append `--workspace <branch|worktree|prompt>`, `--branch`, or `--tree` ONLY when the user passed that override.
- **`--steps <csv>`** — append ONLY when the user passed `--steps`. Legacy `--preset`/`--skip` are hard-removed.
- **`--quality <full|balanced|minimal>`** — append ONLY when explicitly passed.
- **`--hook-active-pipeline`** — append when the session-start `<system-reminder>` contains `/^Active pipeline: ship-sdlc/` AND the user did NOT type `--resume`.

Parse the JSON from `$PREPARE_OUTPUT_FILE`. If `errors` is non-empty, display them and stop.

- **Context-heaviness advisory:** If `contextAdvisory` is a non-empty string, print it verbatim before continuing (`scripts/lib/context-advisory.js`).
- **Gitignore warning:** If `context.sdlcGitignored` is `false`, print:
  ```
  ⚠ Warning: .sdlc/ is not gitignored. Run --init-config to fix, or manually create .sdlc/.gitignore:
    printf '*\n' > .sdlc/.gitignore
  ```

### 1d. Parse flags

Print the `flags` object from `skill/ship.js` output as `name: value (source: cli|config|default)` lines using the `sources` map.

### 1e. Resume check

Print `resume.found` and `resume.stateFile` from `skill/ship.js` output. Do NOT scan the filesystem — `skill/ship.js` is authoritative.

**Implicit-resume banner:** When `flags.implicitResume === true`, print verbatim BEFORE the pipeline table (Step 2), sourcing `<nextPendingStep>` from `resume.nextPendingStep` and step lists from `resume.stateFile`:
```
Resuming after compaction from step <nextPendingStep>.
Completed: <comma-separated step names where status === "completed">.
Pending:   <comma-separated step names where status !== "completed" && status !== "skipped">.
```

**Missing-state prompt:** If `errors` contains `id === "implicitResumeNoState"`, use `ask_question`:
> Active pipeline reminder found but no state file for current branch. Start fresh, or specify a state path?
Options: **fresh** (re-invoke without `--hook-active-pipeline`) | **path** (ask for path, re-invoke with `--state-file <path>`) | **abort**.

Read `./state-format.md` when resuming from a state file.

### 1f. Context detection

Print `context` values as a labeled list: plan file (`context.planFile`, or `none`; append `(from resumed state)` when `context.planFileSource === "state"`), uncommitted changes count, current branch, default branch, `gh` auth status, OpenSpec detection, and `.sdlc/` gitignore status.

**Contradictory-signal override:** If `context.openspecAuthoritative.path` is set AND the session-start `<system-reminder>` matches `/openspec.*not initialized|not initialized.*openspec/i`, print:
`Ignoring contradictory 'not initialized' signal in session context — openspec/config.yaml exists (authoritative source: SDLC's own check via ship.js prepare output).`

### 1g. Auto-skip logic

Print each step from `steps[]` as `<name>: <status> — <reason>`. For `skipped` steps with `skipSource !== "none"`, append `(<skipSource>)` (`cli`, `quick`, `config`, `auto`, `condition`, `default`). `skill/ship.js` is the source of truth.

---

## Step 2 (PLAN): Build Pipeline Plan

Generate the pipeline table from `steps[]` (`index + 1`, `step.skill`, `step.status`, `step.args`, `step.pause ? 'YES' : 'no'`). Opt-in inline steps `verify-pipeline` and `await-remote-review` insert after `pr-sdlc` only when listed in `flags.steps`.

### --auto Mode Audit

| Sub-skill | --auto support | Behavior when ship runs with --auto |
|-----------|---------------|--------------------------------------|
| execute-plan-sdlc | No | Forwards `--quality <X>` only when explicitly passed to ship. |
| commit-sdlc | Yes | `--auto` forwarded. Skips commit approval prompt. |
| review-sdlc | No | Runs fully automatically already. |
| received-review-sdlc | Yes | `--auto` forwarded. Skips consent & reply/resolve prompts; only "agree, will fix" items are auto-implemented/resolved. |
| version-sdlc | Yes | `--auto` forwarded. Skips release plan approval prompt. |
| pr-sdlc | Yes | `--auto` forwarded. Skips PR approval prompt. |

### Review verdict conditional logic

After `review-sdlc` completes, the `Verdict:` label (`CHANGES REQUESTED` / `APPROVED WITH NOTES` / `APPROVED`) is display-only. Dispatch of `received-review-sdlc` is gated exclusively by `flags.reviewThreshold`:

| `flags.reviewThreshold` | Dispatch `received-review-sdlc` when findings include … |
|-------------------------|---------------------------------------------------------|
| `critical` | any critical |
| `high` | any critical OR high |
| `medium` | any critical OR high OR medium |
| `low` | any finding except `info` |

If met → invoke `received-review-sdlc` (forward `--auto` when `flags.auto`). Otherwise defer findings to Step 6.

---

## Step 3 (CRITIQUE): Validate Pipeline

Print validation checks:
- `gh auth status` succeeds
- Current branch is not default branch (warn only)
- All `--steps` values recognized (`execute`, `commit`, `review`, `version`, `archive-openspec`, `pr`, `learnings-commit`, plus opt-in `verify-pipeline`, `await-remote-review`)
- When `flags.sources.steps === 'quick'`, `flags.steps` is non-empty (cite `flags.sources.steps`, not raw `--quick`)
- `--quick` and `--steps` mutual exclusion surfaced from `errors[]`
- At least one step will run
- Flag coherence (`--bump` without `version` → warn)

---

## Step 4 (DO): Present Pipeline and Confirm

- **Dry-run (`--dry-run`):** Redisplay Step 2 table, review threshold, and interactive-pause steps, then stop.
- **Auto (`--auto`):** Display pipeline table and proceed without prompting.
- **Interactive:** Display table and use `ask_question` (**yes** | **edit** | **cancel**). Loop on **edit** until **yes** or **cancel**.

---

## Step 5 (EXECUTE): Run Pipeline Steps Sequentially

### Pre-step validation & dispatch isolation

Before each step, read `step.status` from `skill/ship.js`:
1. `"will_run"` → dispatch per `step.dispatchMode` (`invoke_subagent` for `'agent'`, inline shell/logic for `null`). Never skip a `will_run` step based on perceived simplicity.
2. `"conditional"` → evaluate runtime condition; dispatch if met or print why not.
3. `"skipped"` → print `reason` and `skipSource`.

All sub-skills are Agent-dispatched for context isolation and return a structured 5–10 line result. Always use `step.invocation` verbatim.

### Dispatch protocol (`step.dispatchMode === 'agent'`)

1. Print verbose progress header (`Step N/M`, Skill, Args, Reason).
2. Record step start via `state/ship.js`.
3. Dispatch via `invoke_subagent`:
   - `TypeName`: `"self"`
   - `Role`: `"Ship Pipeline - " + step.skill`
   - `Model`: map `step.model` to a valid `agy` enum (`flash_lite|flash|pro|inherit`): valid enums pass verbatim; `*-hydrogen-low` / `*-flash-low` → `flash_lite`; `*-hydrogen-*` / `*-flash-*` → `flash`; `*-neon-*` / `*-argon-*` / `*-carbon-*` / `*-pro-*` → `pro`; otherwise → `inherit`
   - `Workspace`: `step.isolation === 'worktree' ? 'branch' : 'inherit'`
   - `Prompt`: execute `/<skill-name> <args>` and return `(1) status`, `(2) result summary`, `(3) artifacts`, `(4) warnings/issues`.
4. Print agent result, record `complete` or `fail` via `state/ship.js`, and evaluate next-step decision.

### Pipeline progress and state orchestration

Skip when `flags.steps.length < 2`. For each event below, run `node "<PLUGIN_ROOT>/scripts/lib/ship-todos.js" --state-file "$STATE_FILE" <event args>`, parse stdout JSON, and echo `marker` verbatim:

| Event args | When to call |
|---|---|
| `--event init` | Once, before the Step 5 loop |
| `--event step --current-step <stepName>` | Start of each Step 5 iteration |
| `--event step --current-step <stepName> --mark-completed <stepName>` | After `state/ship.js complete` |
| `--event step --current-step <stepName> --fail-step <stepName>` | After `state/ship.js fail` |
| `--event resume --current-step <resume.nextPendingStep>` | Inside implicit-resume banner when `flags.resume === true` |
| `--event cleanup --current-step cleanup` | Before terminal cleanup |

### Workspace isolation and branch setup

Skip on resume (`flags.resume === true`) or when `WORKSPACE_MODE = continue`. Otherwise derive `<logical-type>` and `<derived-slug>` from the plan title and run:

```shell
SETUP_JSON=$(node "<PLUGIN_ROOT>/scripts/util/ship-workspace-setup.js" \
  --workspace-flag "$WORKSPACE_MODE_FLAG" \
  --prepare-output-file "$PREPARE_OUTPUT_FILE" \
  --logical-type "<logical-type>" \
  --derived-slug "<derived-slug>")
```
> **Contract (Input/Output):**
> - **Input**: `--workspace-flag`, `--prepare-output-file`, `--logical-type`, `--derived-slug`.
> - **Output**: Single JSON line `{ status, workspaceMode, executeBranch, worktreePath }`. Exit 0 success, 1 user error, 2 missing config lib.

If `status === "error"`, halt. If `worktreePath` is non-empty, use it as `Cwd` for all subsequent commands and dispatches. Pass `--branch "$executeBranch"` to `execute-plan-sdlc`. The setup script handles `state/ship.js migrate` internally before creating any branch/worktree.

### Execution loop & execute-step gates

- **Execute step resume:** When `flags.resume === true` and execute is `in_progress`, check `<main-worktree>/.sdlc/execution/execute-<branch>-*.json` (resolve `<main-worktree>` via `worktree-lifecycle.js resolve --branch <branch>`). If found, append `--resume` to `step.invocation`; otherwise run `step.invocation` from scratch.
- **Worktree re-entry on resume:** If `context.worktree.inLinkedWorktree` is `false`, run:
  ```bash
  node "<PLUGIN_ROOT>/scripts/util/worktree-lifecycle.js" resolve --branch <resume-branch>
  ```
  If `found && exists`, `cd <path>`. If `found && !exists`, warn and continue on current branch.
- **Execute-step todo mirroring:** Extract `PLAN_FILE` from the prepare manifest:
  ```shell
  EXTRACT_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/extract-plan-file.js" "$PREPARE_OUTPUT_FILE")
  ```
  > **Contract (Input/Output):**
  > - **Input**: Prepare output file path.
  > - **Output**: Prints temp JSON manifest path `{ ok, planFile, errors }`. Read, parse `.planFile`, then `rm -f "$EXTRACT_OUTPUT_FILE"`.

  Before dispatching `execute-plan-sdlc`:
  ```bash
  node "<PLUGIN_ROOT>/scripts/lib/ship-todos.js" --state-file "$STATE_FILE" --plan-file "$PLAN_FILE" --event execute --current-step execute
  ```
  After `execute-plan-sdlc` returns success, run the post-execution completeness invariant BEFORE marking complete:
  ```shell
  node "<PLUGIN_ROOT>/scripts/util/verify-completeness.js" --state-file "$STATE_FILE" --plan-file "$PLAN_FILE"
  ```
  If exit 65, halt before commit (stderr JSON `{missingIds, totalPlanned, totalAccounted}`). Otherwise run `ship-todos.js --state-file "$STATE_FILE" --event step --current-step execute --mark-completed execute`.

### Inter-step hooks and gates

- **Between execute and commit (staging):**
  ```bash
  node "<PLUGIN_ROOT>/scripts/util/ship-git-ops.js" stage-post-execute
  ```
  Excludes `.sdlc/`. Exit 0 → print `staged[]`; exit 1 → show `error` and halt.

- **Between commit and review (Preflight Gate):** If `package.json` defines `scripts.preflight`, run:
  ```bash
  node "<PLUGIN_ROOT>/scripts/util/run-truncated.js" "npm run preflight"
  ```
  Halt immediately on non-zero exit (do not dispatch `review-sdlc`).

- **Between review and received-review:** Evaluate `flags.reviewThreshold`. If `received-review-sdlc` runs and modifies files (`git status`), dispatch `commit-sdlc` (step `commit-fixes`).

- **Between last commit and version (rebase onto base):**
  ```bash
  node "<PLUGIN_ROOT>/scripts/util/rebase-onto-base.js" --base <defaultBranch>
  ```
  Always exits 0; branch on JSON `status`: `up_to_date`, `clean` (`sha`), `fetch_failed` (warn & continue), or `conflicts` (already aborted; in `--auto` stop and save state for `--resume`; in interactive mode ask via `ask_question`: **Pause pipeline** | **Skip rebase** | **Merge instead** with `git merge origin/<defaultBranch>` and abort-on-conflict fallback to pause).

- **After version — post-version ancestry HARD GATE:** When `NEW_TAG` and `EXECUTE_BRANCH` are both non-empty:
  ```shell
  node "<PLUGIN_ROOT>/scripts/util/verify-ancestry.js" --new-tag "$NEW_TAG" --execute-branch "$EXECUTE_BRANCH"
  ```
  Non-zero halts the pipeline with remediation steps on stderr. No-op when `NEW_TAG` is unset.

- **Between version and pr — `archive-openspec` (conditional inline):**
  1. Extract `--change <name>` from `step.args`.
  2. Validate:
     ```shell
     VALIDATE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/openspec-validate.js" '<name>')
     ```
     Read `{ ok, stdout, stderr, cliAvailable, errors }` and `rm -f "$VALIDATE_OUTPUT_FILE"`. If `ok === false`, halt and save state.
  3. Prompt user for approval (skip in `--auto`).
  4. Archive:
     ```shell
     ARCHIVE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/openspec-archive.js" '<name>')
     ```
     Confirm `ok === true` and `rm -f "$ARCHIVE_OUTPUT_FILE"`.
  5. Commit:
     ```bash
     node "<PLUGIN_ROOT>/scripts/util/ship-git-ops.js" commit-openspec-archive --change '<name>'
     ```
     Branch on `{ committed, reason }` (exit 1 halts).

- **After pr — `verify-pipeline` (opt-in inline):**
  ```shell
  node "<PLUGIN_ROOT>/scripts/util/verify-pipeline.js" $STEP_ARGS --state-file "$SHIP_STATE_PATH"
  ```
  Branch on JSON `status`: `green`, `timeout`, `skipped`, `error`, or `failed`. On `failed`: in interactive mode ask via `ask_question` (**analyze** | **skip** | **abort**); on **analyze** (or `--auto`), dispatch `verify-pipeline-sdlc` (`invoke_subagent`, `Model: "pro"`) with `--pr <N> --logs <excerpt>` (plus `--auto`), then `commit-sdlc --auto` (`Model: "flash"`) on `fix-applied`, looping up to `flags.verifyPipelineMaxIterations` (default 3).

- **After pr — `await-remote-review` (opt-in inline):**
  ```shell
  node "<PLUGIN_ROOT>/scripts/util/await-review.js" $STEP_ARGS --state-file "$SHIP_STATE_PATH"
  ```
  Branch on JSON `status`: `approved-clean`, `timeout`, `skipped`, `error`, or `actionable` (dispatch `received-review-sdlc` with `Model: "pro"` and `--pr <N>` / `--auto`, then `commit-sdlc --auto` with `Model: "flash"` if `git status --porcelain` is non-empty).

- **After pr — `learnings-commit` (inline):** If `status === "will_run"`, append ship-level learnings to `.sdlc/learnings/log.md` (see `./gotchas-and-next-steps.md`) and run:
  ```bash
  node "<PLUGIN_ROOT>/scripts/util/ship-git-ops.js" commit-learnings
  ```
  Push failure (`committed: true, pushed: false`) is non-fatal; exit 1 or `dirty: true` halts.

### State persistence

```bash
node "<PLUGIN_ROOT>/scripts/state/ship.js" init --branch <branch> --flags '<flags JSON>'
```
Before/after steps: `start --step <name>`, `complete --step <name> --result "<summary>"`, `skip --step <name> --reason "<reason>"`, `fail --step <name> --error "<error>"`, `decide --step <name> --text "<decision>"`, `defer --severity <s> --file <f> --title "<t>"`.

### Terminal cleanup step

Always runs as direct `run_command` (never an Agent), even on failure paths. Fire `ship-todos.js --event cleanup --current-step cleanup` before and `--mark-completed cleanup` after. Select `normal` (`cleanup-pipeline`) if no step failed, or `forced` (`cleanup-pipeline --force`) if any step failed (append `--ttl-days <N>` if passed):
```bash
node "<PLUGIN_ROOT>/scripts/state/ship.js" cleanup-pipeline
```
If `currentRun.valid === false`, print `PIPELINE CONTRACT VIOLATION`, list unresolved steps, preserve state, and do NOT proceed to the success summary. Finally run `rm -f "$PREPARE_OUTPUT_FILE"`.

---

## Error Recovery

> **Flow**: detect → diagnose → auto-recover (retry once if transient) → escalate to user for persistent failures.

| Error | Recovery | Invoke error-report-sdlc? |
|-------|----------|---------------------------|
| Sub-skill fails (script crash) | Show error, stop pipeline, save state for `--resume` | Delegated to sub-skill |
| `gh auth status` fails | Stop at Step 3; tell user to run `gh auth login` | No — user setup |
| `ship-git-ops.js stage-post-execute` fails (exit 1) | Show error, stop pipeline | No — user action needed |
| Network error (gh API) | Auto-retry via `retryExec` (3 attempts); if exhausted, record failure + print resume instruction | No — transient |
| State file write fails | Warn and continue (best-effort) | No |
| Resume state file corrupt | Warn, start fresh | No |
| Review verdict unparseable | Treat as APPROVED WITH NOTES, warn user, defer all findings | No |
| Sub-skill times out | Stop pipeline, save state, inform user to `--resume` | No — transient |

**Resume instruction format:**
```
Step <N> (<name>) failed: <error summary>
State saved to: <state file path>
To resume: /ship-sdlc --resume
```

Return to `SKILL.md` **Step 6 (REPORT): Pipeline Summary** after terminal cleanup.
