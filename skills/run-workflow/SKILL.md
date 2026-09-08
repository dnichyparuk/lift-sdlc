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

   **Gate-retry loops.** If a gate exits non-zero with a code that is NOT the configured
   `haltExitCode` AND the step carries a `loop` block, run the retry loop instead of halting:
   1. Re-dispatch the step's own skill (per `loop.subDispatch`, which must name the same skill)
      exactly as in 4c.2, appending the gate's failure output (its JSON/stderr) to the prompt as
      "Previous attempt failed its completion gate: <failure>".
   2. Re-run the post-gates. On pass, continue the pipeline normally.
   3. Allow at most `loop.defaultMaxIterations` re-dispatches (overridable by the flag named in
      `loop.maxIterationsFlag` when the prepare output carries it). When the limit is exhausted
      and the gate still fails, record failure via `pipeline.js fail` and halt as above.
   A non-`haltExitCode` non-zero gate exit on a step WITHOUT a `loop` block is treated as the
   halt case.

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

---

## Step field vocabulary (external-plugin contract)

Third-party manifests (a `prepareScript`'s emitted `steps[]`, e.g. a plugin's own `pipelines/*.json`) rely on this engine to execute specific step fields. This section documents which fields Step 4 above actually reads and acts on, versus fields that only pass through for the step's own handler to interpret. Where the engine has no defined behavior for a field, that is called out explicitly rather than assumed — a manifest author should not build on undocumented behavior.

**`dispatchMode`** — `"agent"` or `null` (Step 4c.2). `"agent"` dispatches the step via the Agent tool with `model: step.model` and `isolation: step.isolation` (omitted when null), invoking `/<step.skill> <step.args>`. `null` (or omitted) runs the step inline in the orchestrator's own context (Case B).

**`inlineHandler` + `handlerSpec`** — For a `dispatchMode: null` step, Case B names four built-in handlers with concrete, engine-defined execution:
- `archive-openspec` — `ARCHIVED_PATH=$(node "<PLUGIN_ROOT>/scripts/util/openspec-archive.js" '<name>')`
- `verify-pipeline` — `node "<PLUGIN_ROOT>/scripts/util/verify-pipeline.js"`
- `await-remote-review` — `node "<PLUGIN_ROOT>/scripts/util/await-review.js"`
- `learnings-commit` — `node "<PLUGIN_ROOT>/scripts/util/ship-git-ops.js" commit-learnings`

Case B's instruction is "execute the step directly in main orchestrator context per the step's handler specification" before that list — so an `inlineHandler` outside these four, carrying a `handlerSpec` string, is executed by following the `handlerSpec` text verbatim (this is how a plugin defines its own inline steps, e.g. a `user-checkpoint` handler). An `inlineHandler` that is neither one of the four built-ins nor accompanied by a `handlerSpec` has no defined execution path.

**`checkpoint` `{prompt, autoBehavior}`** — Not read by the engine directly; there is no built-in Case B branch for it. It only does anything when a step's own `handlerSpec` text instructs the orchestrator to read `checkpoint.prompt` and act on `checkpoint.autoBehavior`. Treat `checkpoint` as opaque data your `handlerSpec` must reference explicitly — **undefined, do not rely on it, if your handlerSpec doesn't mention it.**

**`loop` `{maxIterationsFlag, defaultMaxIterations, triggerCondition, subDispatch[]}`** — Defined by Step 4c.3's Gate-retry loops (above): when a post-gate exits non-zero with a code other than the configured `haltExitCode`, the engine re-dispatches the step's own skill with the gate failure appended to the prompt, up to `defaultMaxIterations` attempts (flag-overridable via `maxIterationsFlag`), then fails and halts. `subDispatch[].skill` must equal the step's own skill; `triggerCondition` is descriptive text for humans, not an evaluated expression. Pair a `loop` block with a gate `haltExitCode` that the gate's failure exit does NOT use (e.g. gate fails with 1, `haltExitCode: 2`) — otherwise the halt branch wins and the loop never runs.

**`postGates` `{script, args, haltExitCode}`** — Documented in Step 4c.3: each gate script runs with `$STATE_FILE`/`$PLAN_FILE` interpolated into `args`. If a gate exits with its configured `haltExitCode` (default `1`, per `pipeline.js fail`), the step is recorded failed and the pipeline halts. `script` is expected to be an absolute, existing path (the `prepareScript` contract resolves it under its own plugin root before handing it to the engine — see the calling plugin's own contract checks). A non-zero exit that is *not* the configured `haltExitCode` triggers the step's Gate-retry loop when a `loop` block is present (Step 4c.3), and is treated as the halt case otherwise.

**`statePrefix`** — Manifest-level (not a per-step field), extracted in Step 1 with `pipeline` as its fallback, and threaded through as `--pipeline "<statePrefix>"` on every `pipeline.js` call (`init`, `start`, `complete`, `skip`, `fail`, `suspend`, `resume`, `decide`, `cleanup-pipeline`). It is the bucketing/naming key for state files and drives resume detection. Currently informational beyond that: `pipeline.js` does not validate it against the manifest's `pipeline` field, a registry, or any other field — it is only used as it's given.
