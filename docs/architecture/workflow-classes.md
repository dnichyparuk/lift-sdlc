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

- **Examples:** `/ship-sdlc`, `/run-workflow`, `/execute-plan-sdlc`.
- **Characteristics:**
  - Maintains persistent state files in `.sdlc/execution/`.
  - Dispatches sub-skills via isolated Agent tool calls with dynamic model selection.
  - Coordinates conditional branching, loops, and terminal cleanup sweeps.
  - Protected by the Auto-Mode Enforcement Hook Ring (`stop-block`, `question-suppression`, `drift-nudge`, `pre-tool-git-guard`).
- **Obligations:**
  - Must define a declarative manifest (`pipeline.json`) and prepare script.
  - Must manage lifecycle transitions through `scripts/state/pipeline.js`.
  - Must enforce bounded retries, proxy caps, and compile a permanent `RUN_AUDIT_<runId>.md`.
