# Plan: Finalization of Self-Learning Loop in Lift-SDLC

**Status:** Approved by Architect Review  
**Target:** Lift-SDLC Plugin (`/root/.gemini/config/plugins/lift-sdlc`)  
**Context:** Based on codebase inspection (159 passing unit/regression tests in `feat/learn-sdlc-self-learning-loop`, merged in PR #10) and adversarial review by `architect` (`pro` model).

---

## 1. Executive Summary & Ground Truth

### 1.1 Current State (Verified via Code & Test Suite)
The core assimilation engine of `learn-sdlc` is **fully implemented and tested**:
- **Preparation & Filtering:** [`scripts/skill/learn-prepare.js`](../scripts/skill/learn-prepare.js) validates frontmatter, applies negative cache filtering against `config.rejected_guardrails`, enforces `recurrenceThreshold` (default 3), snapshots `preImage` of `.sdlc/config.json`, verifies clean tree (`checkCleanTree`), and creates isolated branch `sdlc/assimilation-<ts>`.
- **Synthesis & Pre-Screen:** Read-only subagents [`learn-synthesis-orchestrator.md`](../agents/learn-synthesis-orchestrator.md) and [`learn-review-only.md`](../agents/learn-review-only.md) are defined with dual-host read-only tool whitelists.
- **Mechanical Regression Gate:** [`scripts/ci/validate-guardrail-regression.js`](../scripts/ci/validate-guardrail-regression.js) guarantees **strengthen-only** evolution (existing guardrails must remain byte-identical; only pure appends permitted).
- **Application & Safe Rollback:** [`scripts/skill/learn-apply.js`](../scripts/skill/learn-apply.js) handles `--validate`, `--abort` (safe return to `initialBranch` without data loss), and `--ship` (PR creation via `gh`, post-PR cleanup of pending files).
- **Negative Cache & Rejection:** [`scripts/skill/learn-reject.js`](../scripts/skill/learn-reject.js) parses PR bodies, records rejected signatures into `config.rejected_guardrails`, and closes PRs.
- **Guardrail Consumers:** Both [`plan-sdlc`](../skills/plan-sdlc/SKILL.md) (`plan.guardrails`) and [`execute-plan-sdlc`](../skills/execute-plan-sdlc/SKILL.md) (`execute.guardrails` via [`execute-context-advisory.js`](../scripts/util/execute-context-advisory.js)) actively load and enforce active guardrails.

### 1.2 The Missing Pieces (Gaps Identified)
1. **The Ingestion Gap (Critical):** No agent or skill currently creates files in `.sdlc/learnings/pending/*.md`. Skills only write human-readable freeform text to `.sdlc/learnings/log.md`. Without automated ingestion, `learn-prepare.js` never finds files to process unless manually created by a developer.
2. **Lifecycle & Trigger Gap:** `learn-sdlc` can only be launched manually via `/learn-sdlc`. There is no proactive notification or advisory when pending changesets reach the recurrence threshold.
3. **Setup Onboarding Gap:** [`skills/setup-sdlc/SKILL.md`](../skills/setup-sdlc/SKILL.md) has no interactive flow for the `learn` section (`recurrenceThreshold`, `staleAfterCycles`).
4. **Staleness Telemetry Weakness:** [`scripts/util/learn-stale.js`](../scripts/util/learn-stale.js) relies solely on git commit age and regex search in `log.md`. It lacks a direct signal indicating when a guardrail was actually evaluated during plan/execute.

---

## 2. Architectural Guardrails & Invariants

1. **Strengthen-Only Invariant:** Never modify, reorder, or delete existing guardrails. Assimilation is strictly additive.
2. **Decoupled Execution:** Observation capture must never block or complicate active feature shipping. Ingestion writes untracked local pending files; assimilation runs asynchronously on its own branch.
3. **Negative Cache Honored Everywhere:** If a signature exists in `rejected_guardrails`, ingestion and status checks must immediately suppress it.
4. **Safe Ingestion API (Architect Finding):** Never pass freeform text/evidence as shell CLI arguments. All ingestion inputs must be consumed via structured JSON payloads (via `stdin` or temporary JSON file) to eliminate command injection and shell-escaping failures.
5. **Clean Working Tree Precondition:** Assimilation branches are never created if untracked changes (outside `pending/`) or uncommitted modifications exist.
6. **Zero External Runtime Dependencies:** All new utilities must use Node.js built-in modules (`fs`, `path`, `crypto`, `child_process`).
7. **Dual-Host Compatibility:** Agent definitions and tool calls must function equally under Antigravity and Claude Code.

---

## 3. Implementation Phases & Tasks

### Phase 1: Automated Learning Ingestion Engine
**Goal:** Create a robust, zero-dependency, injection-safe mechanism for agents and skills to record structured pending changesets.

#### Task 1.1: Ingestion Utility Script & Library
- **Target File:** `scripts/util/capture-learning.js`
- **Companion Test:** `scripts/util/capture-learning.test.js`
- **Input Protocol (Safe via JSON / stdin):**
  - Accepts JSON payload either via `stdin` or `--file <path-to-json>`:
    ```bash
    # Via stdin
    echo '{"signature":"auth-layer-raw-sql","rationale":"...","evidence":"...","impact":"high"}' | node scripts/util/capture-learning.js --stdin
    
    # Or via file
    node scripts/util/capture-learning.js --file /path/to/payload.json
    ```
  - Schema:
    ```typescript
    interface LearningPayload {
      signature: string;        // matches /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
      rationale: string;        // max 2000 chars
      evidence: string;         // max 2000 chars
      impact?: string | null;   // max 80 chars
      sourceSkill?: string;     // e.g. "execute-plan-sdlc"
      sourceRef?: string;       // e.g. task ID or wave number
    }
    ```
- **Validation & Business Logic:**
  - `signature`: strictly matches kebab-case regex `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/`.
  - Content limits: `rationale` ≤ 2000 chars, `evidence` ≤ 2000 chars, `impact` ≤ 80 chars.
  - **Negative Cache Check:** Reads `config.rejected_guardrails` (using `scripts/lib/config.js` `readSection('rejected_guardrails')`). If `signature` is present, exit 0 with notice: `[learning-capture] Suppressed: signature '<sig>' is in rejected_guardrails.`
  - **Directory Cap & Inode Hygiene:** Enforce maximum of 100 pending files in `.sdlc/learnings/pending/`. If exceeded, log warning and skip capture (prevent unbounded disk growth in runaway loops).
  - **Run/Task Deduplication:** Within the same task/wave execution, avoid duplicate pending files for the exact same signature.
- **Storage:** Writes to `.sdlc/learnings/pending/<timestamp>-<signature>.md` with canonical YAML frontmatter:
  ```markdown
  ---
  signature: auth-layer-raw-sql
  rationale: Raw SQL string concatenation detected during query assembly in auth module.
  evidence: Task 3 failed with SQL syntax error and unescaped input in auth-dao.ts:42.
  impact: high
  source: execute-plan-sdlc
  ---
  ```

---

### Phase 2: Ingestion Hooking across SDLC Skills
**Goal:** Wire the capture utility into skills where friction, errors, and review findings occur.

#### Task 2.1: Hooking `execute-plan-sdlc`
- **Target File:** `skills/execute-plan-sdlc/SKILL.md`
- **Trigger Points:**
  - **Task Recovery Failure / Non-Trivial Fix:** When a task agent fails verification, triggers recovery, or requires a retry due to a missed project convention.
  - **Post-Wave Guardrail Violation:** When Step 5c-ter detects a violation that required correction.
- **Action:** Generate payload file in temp directory, then invoke `node scripts/util/capture-learning.js --file <temp-file>`.

#### Task 2.2: Hooking `received-review-sdlc`
- **Target File:** `skills/received-review-sdlc/SKILL.md`
- **Trigger Points:**
  - When addressing PR review comments where a reviewer points out a recurring anti-pattern, naming issue, missing boundary check, or security lapse.
- **Action:** In Step 6 (Learnings Capture), in addition to logging to `log.md`, invoke `capture-learning.js` if the finding represents a generalizable rule.

#### Task 2.3: Hooking `harden-sdlc`
- **Target File:** `skills/harden-sdlc/SKILL.md`
- **Trigger Points:**
  - In Step 5: If a proposal is skipped or cannot be immediately converted into a guardrail due to ambiguity, or when a user-code defect is classified.
- **Action:** Option to capture candidate signature into `pending/` for long-term recurrence tracking.

---

### Phase 3: Proactive Assimilation & Pipeline Integration
**Goal:** Close the feedback loop so developers don't have to guess when to run `/learn-sdlc`.

#### Task 3.1: Lightweight Status Checker (`learn-status.js`)
- **Target File:** `scripts/util/learn-status.js` (+ test)
- **Specification:**
  - Reads `pending/`, parses frontmatter via `scripts/lib/learnings.js`.
  - **Negative Cache Filtering:** Reuses `filterRejected` from `scripts/lib/learnings.js` against `config.rejected_guardrails` (prevents false positive notifications for rejected rules).
  - Groups by signature and applies `selectEligible` using `config.learn.recurrenceThreshold`.
  - Outputs JSON: `{ eligibleCount, waitingCount, eligibleSignatures: [...], waitingSignatures: [...] }`.
  - Fast, read-only, runs in <50ms without creating git branches.

#### Task 3.2: Post-Ship Advisory in `ship-sdlc`
- **Target File:** `skills/ship-sdlc/SKILL.md`
- **Location:** In the final completion report (Step 6 REPORT / PR opened).
- **Behavior:**
  - Run `node scripts/util/learn-status.js`.
  - If `eligibleCount > 0`: Display a prominent non-blocking notice:
    > 💡 **Self-Learning Opportunity:** {eligibleCount} recurring pattern(s) have met the recurrence threshold ({threshold}). Run `/learn-sdlc` to generate an automated guardrail proposal PR.

#### Task 3.3: Configuration Support in `setup-sdlc`
- **Target Files:** `scripts/skill/setup.js`, `skills/setup-sdlc/SKILL.md`, `skills/setup-sdlc/resources/`
- **Additions:**
  - Add `learn` section to interactive setup menu:
    - `recurrenceThreshold` (default: 3, prompt: "Minimum occurrences before proposing a guardrail").
    - `staleAfterCycles` (default: null, prompt: "Days/cycles before flagging inactive guardrails").

---

### Phase 4: Structured Telemetry & Staleness Refinement (Closing D9)
**Goal:** Replace crude regex scraping in `log.md` with structured evaluation telemetry.

#### Task 4.1: Dedicated Telemetry Store
- **Target Store:** `.sdlc/learnings/evaluations.json` (untracked, local telemetry)
- **Schema:**
  ```json
  {
    "evaluations": {
      "no-console-log": "2026-09-20T13:00:00.000Z",
      "auth-layer-raw-sql": "2026-09-20T13:15:00.000Z"
    }
  }
  ```
- **Writers:**
  - [`scripts/util/execute-context-advisory.js`](../scripts/util/execute-context-advisory.js) and `scripts/skill/plan.js` record timestamps when guardrails are loaded/checked.
- **Reader:**
  - Update [`scripts/util/learn-stale.js`](../scripts/util/learn-stale.js) to check `.sdlc/learnings/evaluations.json` directly. If a guardrail has not been evaluated for `staleAfterCycles` days, it is flagged as stale.

---

### Phase 5: Verification & End-to-End Simulation
**Goal:** Validate the entire closed loop end-to-end.

#### Task 5.1: Unit Tests
- `capture-learning.test.js`: test JSON input via stdin/file, validation, limits, negative cache suppression, directory caps.
- `learn-status.test.js`: test counting, threshold evaluation, negative cache exclusion.
- `setup.test.js`: test `learn` section parsing and generation.

#### Task 5.2: End-to-End Integration Scenario
- Simulate writing 3 pending files sharing signature `test-anti-pattern` using `capture-learning.js`.
- Run `learn-status.js` -> verify `eligibleCount === 1`.
- Execute `learn-prepare.js` -> verify branch and manifest.
- Run `learn-synthesis-orchestrator` -> verify JSON proposal.
- Apply proposal -> verify `validate-guardrail-regression.js` passes.
- Run `learn-review-only` -> verify assessment generated.
- Run `learn-apply.js --abort` -> verify clean rollback to original branch.

---

## 4. Risks & Mitigations (Updated Post-Review)

| Risk | Impact | Mitigation |
|---|---|---|
| Command injection / syntax errors from arbitrary LLM strings | High | All ingestion uses JSON payloads via `stdin` or temporary files. No CLI string interpolation. |
| Negative cache desync in status checker | Medium | `learn-status.js` reuses `filterRejected()` from `lib/learnings.js` against `config.rejected_guardrails`. |
| Unbounded pending directory growth | Low | Hard cap of 100 pending files enforced in `capture-learning.js`. |
| Working tree dirty during branch checkout | Medium | Pre-flight check (`checkCleanTree`) in `learn-prepare.js` fails closed if untracked/modified files exist. |
| Fragile telemetry scraping | Medium | Dedicated `.sdlc/learnings/evaluations.json` file replaces markdown regex scraping. |
