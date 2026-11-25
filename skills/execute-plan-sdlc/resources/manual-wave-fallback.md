# Execute Plan (SDLC) — Manual Wave Fallback (Steps 2–8)

Use this procedure **only** when native `run_workflow` (`skills/execute-plan-sdlc/workflows/execute.py`) is unavailable or when interactive `custom` per-task model overrides are requested. Prerequisites, Plan Mode Check, explicit `EXPLICIT_PLAN_FILE` / `--resume` resolution, `execute-context-advisory.js --meta` guardrail loading, workspace isolation, and Step 9 reporting live in `../SKILL.md`.

---

## Step 1b: Plan Integrity Validation & OpenSpec Context

### Phase 1 Validation (Plan Integrity)

Dispatch the `plan-execution-validator` subagent via `invoke_subagent` exactly once with `"Model": "pro"` and inputs:
- `PHASE`: `"plan-integrity"`
- `PLAN_FILE_PATH`: `<absolute path to plan>`
- `WAVE_STRUCTURE`: `"none"`

| Validation Check | Fail Action |
|---|---|
| At least 2 tasks present | Stop — single-task plans don't need orchestration; do the work directly |
| Each task has a clear deliverable | Flag vague tasks; ask user to clarify before proceeding |
| No circular dependencies detected | Stop with error, show the cycle |
| No tasks reference inaccessible systems | Warn user, mark as high-risk |

Wait for the JSON response. If `status` is `"failed"`, present the issues and halt until the plan is corrected.

### OpenSpec Context Loading (optional)

Check the plan header's `**Source:**` field. If it points to `openspec/changes/<name>/`, read all markdown files matching `openspec/changes/<name>/specs/*.md` and store them as `openspecSpecs` for Step 5c-bis and Step 8-bis. Missing paths or empty directories are non-blocking.

### OpenSpec Task-Flip Map

For each task containing an `openspec-task:` block, capture `{ taskId, change, ref, line, title }` into `openspecTaskMap`, derive `refToTaskIds: Map<ref, Set<taskId>>`, and seed `flippedRefs: Set<ref>`. When absent, Step 5d-bis is a no-op.

---

## Step 2 (CLASSIFY): Classify Tasks and Build Waves

For each task, determine:

1. **Complexity class:**
   - **Trivial** — single-file change, config edit, rename, or <15 lines at a single edit location. Edits across multiple distinct locations in one file are **Standard**, not Trivial. 1 trivial task in a phase executes inline; 2+ trivials in the same phase batch into a single agent dispatch using the tier's Trivial model (`gemini-4-hydrogen-medium` / `flash`).
   - **Standard** — multi-file change, feature implementation, test writing. Dispatch to agent.
   - **Complex** — architectural change, cross-cutting concern, touches >5 files. Dispatch to agent with extra context.
2. **Risk level:**
   - **Low** — internal implementation, test files, documentation
   - **Medium** — public API changes, database changes, security-related code
   - **High** — breaking changes, credential handling, infrastructure, irreversible operations
3. **Dependencies** — which tasks must complete before this one (based on file outputs/inputs).
4. **Model assignment (Balanced Default):**
   - **Trivial** → `gemini-4-hydrogen-medium` (`"flash"`)
   - **Standard** → `gemini-4-neon-low` (`"pro"`, or `"inherit"` when `execute.standardWorkerEnum: "inherit"` is configured)
   - **Complex** → `gemini-4-neon-medium` (`"pro"`)

Read `./classifying-and-waving-tasks.md` for the wave-building algorithm and adaptive sizing. Two tasks modifying the same file MUST be in different waves.

---

## Step 2b (ROUTE): Small-Plan Direct Execution

- **If total tasks ≤ 3 AND all tasks are Trivial or Standard AND no high-risk tasks:**
  - Print: `Small plan — executing directly without wave orchestration.`
  - Execute each task sequentially in main context (no wave-runner Agent dispatch); verify after each task.
  - After all tasks complete, if `activeGuardrails` is non-empty, run one guardrail evaluation (as in Step 5c-ter) against cumulative `git diff --stat`.
  - Skip Steps 3–4. Apply the 2-retry budget and Step 6 recovery on failure. **Never write a state file** and **never trigger per-wave WIP commits** regardless of `--commit-waves`.
- **If total tasks 4–8:** Standard wave execution with state persistence after every wave → proceed to Step 3.
- **If total tasks 9+:** Standard wave execution with mandatory inter-wave state persistence → proceed to Step 3.

---

## Step 3 (CRITIQUE): Critique Wave Structure

Dispatch `plan-execution-validator` via `invoke_subagent` exactly once with `"Model": "pro"` and inputs:
- `PHASE`: `"wave-integrity"`
- `PLAN_FILE_PATH`: `<absolute path to plan>`
- `WAVE_STRUCTURE`: `<string representation of generated waves from Step 2>`

Evaluates file conflicts, dependency integrity, risk clustering, and trivial aggregation. Pass all items in `issues` to Step 4.

---

## Step 4 (IMPROVE): Revise and Confirm

Fix each issue from Step 3.

**Quality auto-selection:** If `--quality <full|balanced|minimal>` was passed (legacy `A`/`B`/`C` normalized), apply that tier without prompting, display the wave structure with model assignments, and proceed to Step 5. Otherwise present all 3 tiers and ask via `ask_question`:

```
Execution Plan
────────────────────────────────────────────
Pre-wave (1 batch agent, 2 trivial tasks):
  - Task 1: "short description"     [Trivial → gemini-4-hydrogen-medium]
  - Task 2: "short description"     [Trivial → gemini-4-hydrogen-medium]
Wave 1 (N agents — includes 1 batch):
  Batch (2 trivial tasks → 1 gemini-4-hydrogen-medium agent):
    - Task A: "short description"   [Trivial → gemini-4-hydrogen-medium]
    - Task B: "short description"   [Trivial → gemini-4-hydrogen-medium]
  - Task C: "short description"     [Standard → gemini-4-neon-low]
  - Task D: "short description"     [Complex  → gemini-4-neon-medium]
Wave 2 (N tasks, parallel):
  - Task E: "short description"     [Standard → gemini-4-neon-low]
Wave 3 (N tasks — HIGH RISK, will pause):
  - Task F: "short description"     [Complex  → gemini-4-neon-medium]
────────────────────────────────────────────
Total: N tasks across N waves + pre-wave

Quality Tiers (Model Presets):
  minimal) Speed:      N × gemini-4-hydrogen-medium, N × gemini-4-hydrogen-medium, N × gemini-4-hydrogen-high — fast Hydrogen throughput
  balanced) Balanced:  N × gemini-4-hydrogen-medium, N × gemini-4-neon-low, N × gemini-4-neon-medium          — default (Hydrogen trivials, Neon-for-Coding Standard/Complex; execute.standardWorkerEnum: "pro" | "inherit") ✓
  full) Quality:       N × gemini-4-hydrogen-medium, N × gemini-4-neon-medium, N × gemini-4-carbon-medium     — max correctness (Carbon Pro for complex)

Options: minimal (Speed) | balanced (Balanced, default) | full (Quality) | custom | cancel
```

Selecting `minimal` / `balanced` / `full` approves execution immediately. `custom` opens per-task model editing; `cancel` aborts.

---

## Step 5 (DO): Execute Waves

**Pre-wave:** Execute 1 pre-wave trivial task inline; batch 2+ pre-wave trivials into one direct agent dispatch (`Model: "flash"`) using the Batched Trivial Tasks Prompt Template in `./classifying-and-waving-tasks.md`. Record completion in state.

**For each wave:**

### Progress Signal — Wave Start (mandatory, always first)
Emit `[wave-start] wave=N` and chat status; mark previous wave tasks `completed` and current wave tasks `in_progress` in state. Runs even if the wave is skipped or blocked.

### 5a-pre. Pre-wave Guardrail Check (error-severity only)
Skip if `activeGuardrails` is empty. Evaluate each `severity: "error"` (default) guardrail against the wave's task descriptions and cumulative `git diff --stat`:
- All PASS → proceed to 5a.
- Any FAIL:
  - If `--auto` is set: print the violation and STOP (never auto-override guardrails).
  - Otherwise ask via `ask_question`: **override** | **harden** (dispatches `/harden-sdlc` with `--failure-text`, `--skill execute-plan-sdlc`, `--step "5a-pre"`, `--operation "pre-wave guardrail evaluation"`, then re-evaluates) | **cancel**.
- Warning-severity guardrails are evaluated post-wave in Step 5c-ter only.

### 5a. High-Risk Gate
If the wave contains high-risk tasks:
- If `--auto` is set: print `"Auto-approving high-risk wave N."` and proceed.
- Otherwise ask via `ask_question` listing the high-risk tasks: **yes** (execute) | **skip** (skip high-risk tasks) | **cancel** (stop).

### 5b. Dispatch Wave-Runner Agent
Dispatch ONE wave-runner Agent per wave (`Model: "flash"` — required, never omitted; DO NOT pass `Workspace: "branch"` or other workspace isolation):
1. Read `./wave-runner-template.md` for algorithm, contract, and constraints.
2. Inline the per-task template (and batched-trivial template when 2+ Trivials exist) from `./classifying-and-waving-tasks.md`.
3. Write per-task fact sheets before dispatch:
   ```bash
   node "$STATE_SCRIPT" wave-start --wave <N> --tasks-json '<json-array-of-task-objects>' --run-id <run-id>
   ```
   Use the returned `factSheets` paths as `factSheetPath` in the manifest (omit `- [~]` skipped criteria from `acceptanceCriteria`; never write `- [~]` yourself).
4. Include manifest extensions:
   - `guardrails`: `activeGuardrails` (always present, `[]` when empty)
   - `layerBoundaries`: inject rules when expected files match `apps/api/src/facade/` (pure HTTP translation), `apps/api/src/utilities/` (no upward domain imports), or `apps/api/tests/` (deterministic tests, no naked `setTimeout`, use `workerGate`)
   - `expectedFiles`: deterministic union of declared Create/Modify/Test paths across the wave
   - `verificationHint`: optional when all tasks share an identical `Verify:` command
5. Pass bounded `priorWaveSummary` from:
   ```bash
   node "$STATE_SCRIPT" summarize-prior-wave-context
   ```
   (Respecting `priorWaveContextCaps` flags `--max-files`, `--max-decisions`, `--max-interfaces` when configured.)

The wave-runner fans out per-task agents internally with `escalationBudget: 2` (`NEEDS_CONTEXT` retries same model; `FAILED_TESTS`/capability failures escalate Hydrogen → Neon → Argon → Carbon).

### 5c. Collect and Verify

0. **Parse `WAVE_SUMMARY`:** Write `$WAVE_RUNNER_OUTPUT` to a temp file (never a `<<<` here-string) and run:
   ```shell
   node "<PLUGIN_ROOT>/scripts/util/parse-wave.js" --dispatched-ids '<json-array-of-dispatched-task-ids>' < "$TMPFILE"
   ```
   - `missingIds.length > 0` → **CONTEXT_OVERFLOW** (sole discriminant; never substitute `git diff`). Auto-split via:
     ```bash
     node "$STATE_SCRIPT" wave-split \
       --wave <N> \
       --dispatched '<json-dispatched-ids>' \
       --missing-ids '<json-missing-ids>' \
       --split-depth <currentSplitDepth> \
       --max-split-depth 3
     ```
     Re-dispatch `halves[0].tasks` and `halves[1].tasks` independently reusing existing fact sheets. Exit code 2 (`MaxSplitDepthExceededError`) → escalate to user via `ask_question`.
   - `missingIds.length === 0 && !schemaOk` → re-dispatch wave-runner once with format reminder.
   - `missingIds.length === 0 && schemaOk` → proceed.
1. **Filesystem verification (mandatory, always first):** Run `git diff --stat`. Confirm each task's `filesTouched` appear in the diff; missing files = **phantom success** (Step 6).
   - **1a. `expectedFiles` cross-check:** Compute `diffFiles` from `git diff --stat`. If `expectedFiles ≠ ∅` and `diffFiles ∩ expectedFiles = ∅` → **HARD FAILURE** (wave-level phantom success → Step 6). If `diffFiles \ expectedFiles ≠ ∅` → **SOFT WARNING** (`Wave N touched files outside expectedFiles: ...`) and continue.
2. **Canary check:** Grep main context for each task's `VERIFY: <symbol> in <file>` token.
3. **Conflict detection:** Flag any file touched by multiple tasks in the same wave.
4. **Verification suite:** Run plan verification commands (tests, build, lint, plus `npm run preflight` if defined in `package.json`) via:
   ```shell
   node "<PLUGIN_ROOT>/scripts/util/run-truncated.js" "<command>"
   ```
5. **Task status handling:**
   - `DONE` → proceed.
   - `DONE_WITH_CONCERNS` → investigate correctness concerns; note observational ones.
   - `NEEDS_CONTEXT` / `BLOCKED` → re-dispatch recovery wave-runner for failing tasks only, carrying forward prior `attempts[]` so remaining retry budget is decremented.
   - `FAILED` (after 2 retries) → Step 6 recovery.

Never trust agent self-reports without `git diff --stat` and main-context verification.

### 5c-bis. Spec Compliance Review (Standard & Complex tasks only)
Skip for Trivial-only waves or `--quality minimal`. Dispatch one `spec-compliance-reviewer` subagent via `invoke_subagent` with `"Model": "pro"`, using `./spec-compliance-reviewer.md` as the prompt template and passing each non-trivial task spec + `filesTouched`.
- 1–2 minor issues → fix inline in main context.
- Major spec gaps → re-dispatch original task agent with specific fix instructions (counts toward 2-retry budget).

### 5c-ter. Post-wave Guardrail Check
Skip if `activeGuardrails` is empty. Evaluate ALL guardrails (error + warning) against `git diff --stat`, completion checklists, and prior wave context:
- Error FAIL: if `--auto`, print violation and STOP. Otherwise ask via `ask_question`: **fix** (1 inline attempt + re-evaluate) | **override** | **harden** (dispatches `/harden-sdlc` with `--step "5c-ter"`) | **cancel**.
- Warning FAIL: report `⚠ Guardrail warning <id>: <description> — <rationale>` and continue.

### 5c-quater. Per-wave WIP Commit (`commitWaves === true` only)
Fires ONLY after mechanical verify (5c) AND post-wave guardrails (5c-ter) pass, and NEVER on the small-plan path:
1. Run from main context (hooks always run; never `--no-verify`):
   ```bash
   node "<PLUGIN_ROOT>/scripts/util/wave-commit.js" --wave <N> --titles "<title1>|<title2>"
   ```
2. Branch on JSON output:
   - `committed: false, softSuccess: true` → empty diff; print `Wave N produced no diff — no WIP commit recorded.` Persist with empty `--sha ""`.
   - `committed: true, sha: "<sha>"` → persist `<sha>`.
   - Exit 1 (`error` from hook failure or `reason: "empty wave title"`) → hard wave failure → Step 6.
3. Persist SHA:
   ```bash
   node "<PLUGIN_ROOT>/scripts/state/execute.js" wave-committed --branch <slug> --wave <N> --sha "<sha>"
   ```

### 5d. Progress Report, State Persistence & 5d-bis OpenSpec Task Flip
Set `STATE_SCRIPT="<PLUGIN_ROOT>/scripts/state/execute.js"`.
- First wave init (after `node "<PLUGIN_ROOT>/scripts/util/plan-hash.js" <plan-path>`):
  ```bash
  node "<PLUGIN_ROOT>/scripts/state/execute.js" init --branch <branch> --quality <X> --total-tasks <N> --planned-task-ids '<json-array>' --plan-path <plan-path> --plan-hash <plan-hash>
  ```
- Per wave/task updates:
  - `node "<PLUGIN_ROOT>/scripts/state/execute.js" wave-start --wave <N>`
  - `node "<PLUGIN_ROOT>/scripts/state/execute.js" task-done --wave <N> --task <id> --name "<name>" --complexity <c> --risk <r> --files-changed '<json>'` (or `task-fail`)
  - **5d-bis OpenSpec task flip** (main context only, when `refToTaskIds` is non-empty): read completed IDs from `node "<PLUGIN_ROOT>/scripts/state/execute.js" read`; for each unflipped `ref` whose siblings are all completed, run:
    ```shell
    RESULT_JSON=$(node "<PLUGIN_ROOT>/scripts/util/openspec-task-info.js" \
      --change "<change>" \
      --ref "<ref>" \
      [--line "<line>"] \
      [--title "<title>"])
    ```
    Add `ref` to `flippedRefs`. On `not-found` or `io-error`, log to `.sdlc/learnings/log.md` and append to `openspecSyncWarnings` (non-blocking; wave abort on `markTaskDone` failure is FORBIDDEN).
  - `node "<PLUGIN_ROOT>/scripts/state/execute.js" wave-done --wave <N>` (or `wave-fail`)
  - `node "<PLUGIN_ROOT>/scripts/state/execute.js" context --data '<json>'`
- Emit `[wave-complete] wave=N`. On failure, preserve state for `--resume`.

### 5e. Inter-wave Critique & Context Refresh
Check whether any task output deviated from downstream assumptions or OpenSpec delta specs; adjust next-wave task descriptions if needed. Refresh bounded context via `node "$STATE_SCRIPT" summarize-prior-wave-context` and compact verbose wave output on 4+ wave plans.

### 5f. Post-Execution Completeness Invariant
After the final wave completes, run:
```bash
node "$STATE_SCRIPT" verify-completeness
COMPLETENESS_EXIT=$?
if [ "$COMPLETENESS_EXIT" -ne 0 ]; then
  echo "ERROR: execute-plan-sdlc completed all waves but planned tasks are unaccounted." >&2
  exit "$COMPLETENESS_EXIT"
fi
```
Exit code 65 (`{missingIds, totalPlanned, totalAccounted}` on stderr) is a hard gate — do NOT proceed to commit/review/PR. Wave completeness always uses `!missingIds.length` (negation: `missingIds.length > 0`).

---

## Step 6 (RECOVER): Error Recovery

Read `./recovering-from-failures.md` **only when a failure occurs**. Maximum retries per task: **2**.

| Failure Type | Recovery Action |
|---|---|
| Agent error / incomplete output (`flash` task) | `NEEDS_CONTEXT`: same model; `FAILED_TESTS`/capability: escalate to `gemini-4-neon-low` (`pro`) on Retry 1, `gemini-4-argon-low` (`pro`) on Retry 2 |
| Agent error / incomplete output (`pro` task) | `NEEDS_CONTEXT`: same model; `FAILED_TESTS`/capability: escalate Neon → Argon → Carbon across the 2-retry budget (`"Model": "pro"`) |
| File conflict between agents | Resolve manually in main context; re-run affected verification |
| Test failure (1–2 tests) | Fix inline in main context |
| Test failure (3+ tests) | Stop; diagnose root cause before proceeding |
| Build failure | Stop immediately; fix before next wave |
| Lint failure | Fix inline; never block a wave on lint-only failures |
| Phantom success | Re-dispatch with model escalation and Edit-tool-only constraint |
| Persistent failure (2+ retries) | Escalate to user with full context; offer **harden** (`/harden-sdlc`, interactive only) alongside other options |
| `NEEDS_CONTEXT` / `BLOCKED` | Provide missing context, escalate, split task, or escalate to user |
| Malformed/missing checklist | Re-dispatch once with format reminder (no escalation purely for format) |

---

## Step 7 (VERIFY): Final Verification

After all waves:
1. Run full test suite (via `run-truncated.js`)
2. Run build
3. Run linter (if configured)
4. Review changed files: `git diff --stat`

Fix minor integration issues inline in main context.

---

## Step 8 (CRITIQUE): Final Output Critique

Check that every planned task has a completed deliverable, no orphaned files exist, no task drifted from spec, and no unintended `TODO`/`FIXME`/`HACK` markers remain. Fix inline if possible; report otherwise.

### 8-bis. Final Spec Completeness Check (when `openspecSpecs` available)
Skip if `openspecSpecs` is empty, `--quality minimal` was selected, or all per-wave reviews passed cleanly on a ≤3-wave plan. Otherwise dispatch one `spec-compliance-reviewer` subagent via `invoke_subagent` with `"Model": "pro"` using `./spec-compliance-reviewer.md`, passing ALL non-trivial tasks, full `git diff --stat`, and all `openspecSpecs` files to verify cross-wave coverage. Handle verdicts identically to Step 5c-bis.

### 8-ter. Learning Capture
Run Learning Capture (defined in `../SKILL.md`) before proceeding to Step 9 (REPORT).
