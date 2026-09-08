# Rejected Anti-Patterns & Design Decisions

This document records the 10 architectural anti-patterns evaluated and rejected during the design of Lift-SDLC's workflow engine and reliability guardrails (drawing from the Starterpack Export Blueprint §06 and SDLC field testing).

---

### 1. Monolithic State CLI
- **Rejected Pattern:** Maintaining separate, hardcoded state CLIs for every workflow (e.g. `state/ship.js`, `state/execute.js`, `state/review.js`).
- **Why Rejected:** Fragmented schemas, divergent GC implementations, and duplicate file locking logic.
- **Adopted Design:** Single generic `scripts/state/pipeline.js` CLI with dynamic `--pipeline <prefix>` support and backward-compatible delegating shims.

---

### 2. Subagent Tool Invocation (`invoke_subagent`) for Orchestration
- **Rejected Pattern:** Using Antigravity's `invoke_subagent` tool to dispatch pipeline steps.
- **Why Rejected:** `invoke_subagent` cannot specify custom model overrides or workspace isolation per invocation; it is intended for ad-hoc background tasks rather than deterministic pipeline step delegation.
- **Adopted Design:** Antigravity's platform-native `Agent` tool, supporting dynamic `model: step.model` and `isolation: step.isolation` with the `Skill` tool loading `SKILL.md`.

---

### 3. Stdin / Hook Polling Loops
- **Rejected Pattern:** Having the orchestrator poll file status or task status in a loop (`while [ ! -f ... ]`).
- **Why Rejected:** Burns execution turns, drives up latency and API cost, and causes context compaction loops.
- **Adopted Design:** Pure event-driven state transitions, synchronous CLI commands, and reactive wakeup via lifecycle hooks.

---

### 4. Interactive Pauses in Auto Mode (Mid-Turn Pause Hole)
- **Rejected Pattern:** Allowing sub-skills to invoke `ask_question` during unattended (`--auto`) pipeline runs.
- **Why Rejected:** Blocks overnight and CI runs on minor implementation choices, violating automation contracts.
- **Adopted Design:** Targeted `question-suppression.js` hook denying non-approval questions and enforcing the 5-rung autonomous resolution ladder.

---

### 5. Premature Turn-End Stops (Turn-End Hole)
- **Rejected Pattern:** Allowing the LLM to end its turn (`Stop` event) while a step is still `in_progress`.
- **Why Rejected:** Leaves pipelines half-executed, requiring manual user re-invocation.
- **Adopted Design:** `stop-block.js` hook returning `decision: continue` to force the turn to resume until the active step is completed or suspended.

---

### 6. Destructive Merging in Unattended Mode
- **Rejected Pattern:** Executing `git merge` directly during `--auto` runs when branches diverge.
- **Why Rejected:** High probability of merge conflict markers being checked in or corrupting working tree state.
- **Adopted Design:** `pre-tool-git-guard.js` blocks `git merge` under `--auto` and recommends non-destructive linear rebasing (`rebase-onto-base.js`).

---

### 7. Global `git add -A` Without State Directory Exclusions
- **Rejected Pattern:** Allowing `git add -A` or `git add .` indiscriminately.
- **Why Rejected:** Accidentally stages ephemeral execution state files (`.sdlc/execution/*.json`), contaminating git history.
- **Adopted Design:** Git guard rejects `git add -A` unless exclusion patterns (`:!.sdlc/`) or explicit paths are supplied.

---

### 8. Hand-Written JSON State Mutations
- **Rejected Pattern:** Prompting the LLM to directly write or edit `.sdlc/execution/*.json` state files with file-writing tools.
- **Why Rejected:** JSON corruption, lost concurrency locks, missing timestamp formats, and broken recovery schemas.
- **Adopted Design:** All state mutations are strictly managed by `scripts/state/pipeline.js` subcommands.

---

### 9. Indefinite Loop Retries
- **Rejected Pattern:** Retrying failed steps or polling CI indefinitely without bound.
- **Why Rejected:** Unbounded retries cause infinite loops and exhaust API token budgets.
- **Adopted Design:** Bounded retry caps (1 retry for malformed agent returns; max 2 rounds for proxy questions; max 3 iterations for CI repair).

---

### 10. Indiscriminate PostToolUse Context Pollution
- **Rejected Pattern:** Injecting large prompts or execution instructions on every single tool call.
- **Why Rejected:** Overflows context limits, degrades prompt cache hit rates, and hits hook timeouts.
- **Adopted Design:** Fast-path hooks with execution times under 500ms and minimal ephemeral message nudges only when pipeline steps are active.
