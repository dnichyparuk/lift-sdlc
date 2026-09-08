# Lift-SDLC Skill Optimization Plan

## 1. Objective & Validation
*See the full evidence and raw analysis in the [Skill Optimization Report](./skill-optimization-report.md).*

Reduce the token footprint of all 14 `lift-sdlc` skill prompts by 40–60% without losing any architectural safety nets, quality gates, or core agent capabilities. Reductions exclusively target instructional bloat, repetitive defensive prompting, and raw shell orchestration logic.

## 2. Identified Anti-Patterns

1. **The "Shell Orchestrator" Anti-Pattern**: 
   - *Issue*: Instructing the LLM to write multi-step, brittle git/bash sequences (e.g., handling `git rebase` failures or atomic tag deletion).
   - *Fix*: Encapsulate these sequences into headless Node.js helpers (`scripts/*.js`). The prompt should execute one script and read a JSON output.
2. **The "Defensive Repetition" Anti-Pattern**:
   - *Issue*: Stating a rule in the "Quality Gates", and then repeating it identically in the "Best Practices", "DO NOT", and "Gotchas" lists.
   - *Fix*: Centralize constraints. State a rule once in the operational step and aggressively prune trailing Gotchas/DO NOTs.
3. **The "Developer Lore & Traceability" Anti-Pattern**:
   - *Issue*: Prompts contain internal issue numbers (`Fixes #418`), requirement tags (`R1`), and historical design rationales meant for human maintainers.
   - *Fix*: Strip all internal tracking metadata and architectural exposition from runtime prompts.
4. **The "JSON Schema & Data Mapping" Anti-Pattern**:
   - *Issue*: Forcing the LLM to memorize and apply complex data mappings (e.g., field mappings, branch-to-label rules) that can be deterministically calculated.
   - *Fix*: Offload evaluation logic to the `prepare.js` setup layer, outputting the computed result directly to the LLM.

---

## 3. Implementation Plan (Phased Roadmap)

### Phase 1: Script Offloading (Moving Logic out of Prompts)
*Target: Move multi-step shell logic described in prompts into robust Node.js scripts.*
- [ ] **`execute-plan-sdlc`**: Offload wave WIP commits and resume-detection logic into Node scripts (e.g., `check-resume.js` and `wave-commit.js`).
- [ ] **`ship-sdlc`**: Consolidate `git rebase` fallback, worktree cleanup, and OpenSpec archive git loops into dedicated Node helpers via `child_process.execSync`.
- [ ] **`commit-sdlc`**: Wrap `git reset --soft` and `stash` pop logic into a single `squash-wip.js` wrapper.
- [ ] **`version-sdlc`**: Create a deterministic `retag-helper.js` to handle atomic tag rollback/creation.

### Phase 2: Schema & Data Mapping Delegation
*Target: Move prompt-based evaluation tables into JS layers.*
- [ ] **`pr-sdlc`**: Move branch-to-label deterministic mapping into `scripts/skill/pr.js`.
- [ ] **`harden-sdlc`**: Offload `--failure-text`/`--from-issue` argument exclusivity and issue fetching to `harden-prepare.js`.
- [ ] **`verify-pipeline-sdlc`**: Consolidate `gh` auth checks and log extraction branching into the JS layer.

### Phase 3: Defensive Repetition Pruning
*Target: Delete duplicate constraints from trailing lists.*
- [ ] **Global**: Review all 14 `SKILL.md` files. Identify constraints listed in the main execution steps.
- [ ] **Global**: Delete redundant matching items from `Gotchas`, `DO NOT`, and `Best Practices` sections.
- [ ] **`jira-sdlc`**: Consolidate MCP failure telemetry blocks into a single reference section.

### Phase 4: Developer Lore Eradication
*Target: Strip human-targeted background context from LLM context.*
- [ ] **Global**: Search and destroy all requirement tags (e.g. `R1`, `C5`), GitHub issue cross-references (`Fixes #123`), and design rationales.
- [ ] **`plan-sdlc` & `ship-sdlc`**: Remove multi-paragraph explanations of background engine hook lifecycles.

