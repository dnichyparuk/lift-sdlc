---
name: run-workflow
description: "Generic workflow engine that executes declarative pipeline manifests. Dispatches sub-skills as isolated Agents with per-step model selection and manages deterministic state machine transitions."
user-invocable: true
argument-hint: "--manifest <path> [--auto] [--dry-run] [--resume] [pipeline-flags]"
model: gemini-3.8-flash-medium
---

# Generic Workflow Engine

Executes structured SDLC pipelines defined by declarative manifests and prepare scripts. Manages state machine transitions, Agent tool dispatches, inline execution steps, and verification gates.

## Step 0 — Plan Mode Check

If the system context contains "Plan mode is active":
1. Announce:
   > Plan mode is active. Workflow pipelines require write operations and cannot run inside plan mode. Exit plan mode to execute this workflow.
2. Stop. Do not proceed.

---

## Step 1 — Prepare Runtime Manifest

Run the generic prepare wrapper to compute the pipeline plan:

```shell
PREPARE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/run-workflow.js" --manifest "$MANIFEST_PATH" $FORWARDED_ARGS)
EXIT_CODE=$?
echo "PREPARE_OUTPUT_FILE: $PREPARE_OUTPUT_FILE"
echo "STATUS: $EXIT_CODE"
```

1. If `EXIT_CODE` is non-zero, read errors from `$PREPARE_OUTPUT_FILE`, display them to the user, and stop.
2. Parse the JSON manifest from `$PREPARE_OUTPUT_FILE`.
3. Extract `pipeline`, `version`, `statePrefix` (fallback: `pipeline`), `steps[]`, `flags`, and `validation`. Extract `<branch>` from `context.currentBranch` (or `git branch --show-current`). Extract `$PLAN_FILE` from `context.planFile` (or `flags.planFile`). Retain `statePrefix` for all state CLI calls to match session resume and hook conventions. Also extract `resume` (`resume.found`, `resume.stateFile`, `resume.nextPendingStep`) when present — `scripts/skill/run-workflow.js` injects this generically for any `prepareScript` that doesn't compute its own resume state (see Step 2/3 below).
4. **Missing-state prompt:** if `errors[]` contains an entry with `id === "implicitResumeNoState"`, display its `message` and stop — `--resume` was passed but no state file exists for this pipeline+branch. Do not fall through to Step 2.
5. Clean up: `rm -f "$PREPARE_OUTPUT_FILE"`.

---

## Step 2 — Display Pipeline Plan & User Confirmation

**Resume banner:** When `flags.resume === true`, print the following banner verbatim BEFORE the pipeline table, sourcing `<nextPendingStep>` from `resume.nextPendingStep` and the step lists from the state file at `resume.stateFile`:

```
Resuming <pipeline> from step <nextPendingStep>.
Completed: <comma-separated step names where status === "completed">.
Pending:   <comma-separated step names where status !== "completed" && status !== "skipped">.
```

Format and display the pipeline table:

```
━━━━━━━━━━━━━━━━━━━━ Pipeline Plan: <pipeline> ━━━━━━━━━━━━━━━━━━━━
  #   Step                 Skill                   Mode    Status      Model
──────────────────────────────────────────────────────────────────
  1   execute              execute-plan-sdlc       agent   will_run    gemini-3.8-flash-medium
  2   commit               commit-sdlc             agent   will_run    gemini-3.8-flash-medium
  ...
```

1. **If `--dry-run` was passed**: Stop here. Do not initialize state or execute steps.
2. **If `flags.auto === true`**: Announce "Auto mode active — executing pipeline without interactive prompts" and proceed immediately to Step 3.
3. **If interactive mode**:
   Use `AskUserQuestion` to ask:
   > Run this pipeline?
   - **yes** — execute as shown
   - **cancel** — stop here

---

## Step 3 — Initialize Pipeline State

**Skip on resume** (`flags.resume === true`): do not call `init` — it would create a fresh state file and discard prior progress. Use `resume.stateFile` (already known from Step 1) as `<stateFile>` directly, and proceed to Step 4 starting at `resume.nextPendingStep`.

**Otherwise**, initialize the execution state file via the state CLI using `<statePrefix>`:

```shell
node "<PLUGIN_ROOT>/scripts/state/pipeline.js" --pipeline "<statePrefix>" init --branch "<branch>" --flags '<flags_json>' --steps '<steps_json>'
```

Extract the created `stateFile` path from stdout (`const stateFile = JSON.parse(stdout).filePath;`).

---

## Step 4 — Execute Pipeline Steps

Iterate sequentially through each step in `steps[]`. **When resuming** (`flags.resume === true`), start iteration at the step named `resume.nextPendingStep` instead of the first step — steps before it are already `completed`/`skipped` in the loaded state file and must not be re-run.

### 4a. Handle Skipped Steps
If `step.status === "skipped"`:
1. Print skip notice:
   ```
   [skipped] Step <name> (<reason>, source: <skipSource>)
   ```
2. Record skip in state machine:
   ```shell
   node "<PLUGIN_ROOT>/scripts/state/pipeline.js" --pipeline "<statePrefix>" skip --step "<step.name>" --reason "<step.reason>"
   ```
3. Proceed to next step.

### 4b. Evaluate Conditional Steps
If `step.status === "conditional"`:
1. Evaluate the condition against previous step results in context (e.g., review findings threshold).
2. If the condition is met: proceed to dispatch.
3. If the condition is NOT met:
   - Print: `[skipped] Step <name> condition not met (<step.reason>)`
   - Record skip via `node "<PLUGIN_ROOT>/scripts/state/pipeline.js" --pipeline "<statePrefix>" skip --step "<step.name>" --reason "condition not met"`
   - Proceed to next step.

### 4c. Step Dispatch

1. **Record step start**:
   ```shell
   node "<PLUGIN_ROOT>/scripts/state/pipeline.js" --pipeline "<statePrefix>" start --step "<step.name>"
   ```

2. **Dispatch Step**:

   **Case A: `step.dispatchMode === "agent"` (Agent tool dispatch)**:
   Dispatch via the **Agent tool** with:
   - `model: step.model`
   - `isolation: step.isolation` (omit if null)
   - Prompt:
     ```text
     You are executing the <step.skill> skill. Invoke `/<step.skill> <step.args>` using the Skill tool — this loads the SKILL.md automatically. Return a structured result:
     (1) status — success or failure
     (2) result summary — 2-3 lines
     (3) artifacts — commit hash, tag, PR URL, verdict, etc.
     (4) any warnings or issues encountered
     ```

   *Bounded Retry Rule:* If the agent result cannot be parsed, retry dispatch exactly once with a clarifying request. If it fails again, treat as step failure.

   **Case B: `step.dispatchMode === null` (Inline step execution)**:
   Execute the step directly in main orchestrator context per the step's handler specification:
   - `archive-openspec`: Run `ARCHIVE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/openspec-archive.js" '<name>')`
   - `verify-pipeline`: Poll CI checks via `node "<PLUGIN_ROOT>/scripts/util/verify-pipeline.js"`
   - `await-remote-review`: Poll PR reviews via `node "<PLUGIN_ROOT>/scripts/util/await-review.js"`
   - `learnings-commit`: Commit learnings via `node "<PLUGIN_ROOT>/scripts/util/ship-git-ops.js" commit-learnings`

3. **Post-Gates Verification**:
   If `step.postGates` is defined, execute each gate command sequentially, interpolating `$STATE_FILE` and `$PLAN_FILE`:
   ```shell
   # Example: scripts/util/verify-completeness.js --state-file $STATE_FILE --plan-file $PLAN_FILE
   ```
   If any gate script exits with its configured `haltExitCode` (e.g. 65 for completeness check):
   - Record step failure via `node "<PLUGIN_ROOT>/scripts/state/pipeline.js" --pipeline "<statePrefix>" fail --step <step.name> --error "Post-gate failed"`
   - Halt pipeline execution and proceed to cleanup.

4. **Record Completion**:
   Record step completion via the state CLI:
   ```shell
   node "<PLUGIN_ROOT>/scripts/state/pipeline.js" --pipeline "<statePrefix>" complete --step "<step.name>" --result "<summary>"
   ```

5. **Record Decisions**:
   If the step produced structured flow decisions (e.g. review verdict), persist them:
   ```shell
   node "<PLUGIN_ROOT>/scripts/state/pipeline.js" --pipeline "<statePrefix>" decide --step "<step.name>" --text "<decision>"
   ```

---

### 4d. Tiered Autonomy & Question Governance

When a dispatched agent or step encounters ambiguity in `--auto` mode, resolve it using the **5-Rung Autonomous Ladder**:
1. **Rung 1 (State Context):** Check existing config, plan, and state metadata.
2. **Rung 2 (Repository Conventions):** Inspect surrounding code, recent commits, and established patterns.
3. **Rung 3 (Documented Defaults):** For implementation choices (**Q3**), select the standard Lift-SDLC default and record it:
   ```shell
   node "<PLUGIN_ROOT>/scripts/util/record-assumption.js" --state-file "$STATE_FILE" --step "<step.name>" --question-class "Q3" --decision "<choice>" --rationale "<reason>"
   ```
4. **Rung 4 (Safe Branch Fallback):** For destructive operations (**Q6**), choose non-destructive alternatives (safe rebase instead of merge).
5. **Rung 5 (Structured Suspension):** For hard blockers (**Q1/Q2** — missing credentials, external API reachability), do NOT ask interactive questions. Transition step to `needs_input`:
   ```shell
   node "<PLUGIN_ROOT>/scripts/state/pipeline.js" --pipeline "<statePrefix>" suspend --step "<step.name>" --question '<question_json>'
   ```
   Halt the turn so the user can address the blocker.

*Proxy Questions Cap:* An agent is restricted to at most 2 rounds of clarifications. If ambiguity persists after 2 rounds, force a Rung 5 suspension.

---

## Step 5 — Generate Run Audit & Terminal Cleanup

1. **Generate Run Audit Ledger**:
   Before deleting the state file, compile the permanent human-readable execution audit:
   ```shell
   node "<PLUGIN_ROOT>/scripts/util/generate-run-audit.js" --state-file "$STATE_FILE"
   ```

2. **Run terminal pipeline cleanup**:
   - If all steps succeeded:
     ```shell
     node "<PLUGIN_ROOT>/scripts/state/pipeline.js" --pipeline "<statePrefix>" cleanup-pipeline
     ```
   - If any step failed:
     ```shell
     node "<PLUGIN_ROOT>/scripts/state/pipeline.js" --pipeline "<statePrefix>" cleanup-pipeline --force
     ```

---

## Step 6 — Summary Report

Print the final execution summary to the user:
- Pipeline status (SUCCESS or FAILED)
- Summary of executed steps and durations
- Artifacts produced (commits, tags, pull requests)
- Links to audit ledgers (`RUN_AUDIT_<runId>.md` and `ASSUMPTIONS_<runId>.md`)
- Any deferred findings or warnings
