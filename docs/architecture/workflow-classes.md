# SDLC Workflow Classes & Execution Taxonomy

Lift-SDLC classifies all skills and workflows into three distinct operational classes based on their execution boundaries, context consumption, and state persistence requirements.

---

## 1. Class A: Leaf Workflows (Atomic Operations)

**Definition:** Single-purpose, atomic skills that execute a focused SDLC operation within a single turn or bounded tool loop.

- **Examples:** `/commit-sdlc`, `/version-sdlc`, `/review-sdlc`, `/pr-sdlc`.
- **Characteristics:**
  - Operates on a single repository snapshot or staged diff.
  - Generates a single concrete artifact (git commit, git tag, PR, review findings).
  - Can be invoked standalone by the user or dispatched as an isolated step by an orchestrator.
- **Obligations:**
  - Pre-computes context via dedicated `scripts/skill/<name>.js`.
  - Never mutates execution state of outer pipelines.
  - Implements the 4-part return contract: `(status, summary, artifacts, warnings)`.

---

## 2. Class B: Sweep Workflows (Batch / Evaluative Sweeps)

**Definition:** Workflows that iterate across multiple dimensions, files, or tasks without advancing a linear deployment lifecycle.

- **Examples:** Multi-dimension code review (`/review-sdlc`), completeness validation (`verify-completeness.js`), repo discovery (`/setup-sdlc`).
- **Characteristics:**
  - Evaluates collections of entities (e.g. dimensions, tasks, changed files).
  - Produces aggregate scores, checklists, or structured diagnostics.
  - Supports partial or degraded execution when optional tools are unavailable.
- **Obligations:**
  - Independent evaluation across dimensions (failure in one dimension does not corrupt others).
  - Strictly non-mutating with respect to git working tree.

---

## 3. Class C: Pipeline Workflows (End-to-End Orchestrators)

**Definition:** Stateful, multi-step orchestrators that coordinate a sequence of Class A and Class B workflows to advance software through an SDLC stage.

- **Examples:** `/ship-sdlc`, `/pipeline-sdlc` (replaces `run-workflow` to avoid shadowing `agy`'s built-in `/run-workflow`), `/execute-plan-sdlc`.
- **Characteristics:**
  - Maintains persistent state files in `.sdlc/execution/`.
  - Dispatches sub-skills via isolated `invoke_subagent` calls or flattened native Python `run_workflow` scripts (`skills/ship-sdlc/workflows/ship.py`, `skills/execute-plan-sdlc/workflows/execute.py`, `skills/review-sdlc/workflows/review.py`, `skills/received-review-sdlc/workflows/verify.py`), keeping subagent depth ≤ 1 via `call_tool("run_command", ...)`, `asyncio.gather(..., return_exceptions=True)`, and JSON-schema-enforced `agent()`.
  - Coordinates conditional branching, loops, and terminal cleanup sweeps.
  - Protected by the 9-hook Enforcement Ring (`session-context` on `SessionStart`; `git-guard`, `question-suppression`, `jira-write-guard`, `validation-guard` on `PreToolUse`; `drift-nudge` on `PostInvocation`; `stop-block`, `state-save`, `plan-integrity-guard` on `Stop`).
- **Obligations:**
  - Must define a declarative manifest (`pipeline.json`) and prepare script.
  - Must manage lifecycle transitions through `scripts/state/pipeline.js`.
  - Must enforce bounded retries, proxy caps, and compile a permanent `RUN_AUDIT_<runId>.md`.
