# SDLC Plugin Changes Log

## Model Mapping & Suffix Refactoring

**Date:** 2026-06-13

### Overview
We successfully transitioned Lift-SDLC from a dynamic byte-budgeting model reasoning-depth approach to explicit, hardcoded static model assignments. 

Previously, the plugin dynamically calculated byte budgets using `compute_context_suffix.js` and `dispatch-budget.js`, appending `-low`, `-medium`, or `-high` suffixes to models at runtime. This logic was deprecated because all models in the Antigravity 4 family now uniformly share a 1M token context window, meaning byte-based calculations for context limits are obsolete. The suffixes now purely control the model's reasoning/computation budget.

### Changes Made

#### 1. Removal of Legacy Calculation Scripts
- **`compute_context_suffix.js`**: Completely deleted from `skills/ship-sdlc/scripts/`.
- **`dispatch-budget.js`**: Removed the `contextSuffix` calculation and return. The utility now purely computes wave-size caps without modifying the target execution model.

#### 2. Static Routing in `ship-sdlc` Pipeline
Replaced generic `gemini-3.5-flash` base model placeholders in `ship.js` with explicitly appended static suffixes that define the reasoning depth natively required per step:
- **`gemini-3.1-pro-low`**: `execute` (requires pro logic for DAG sorting, but skips extended thinking loops to minimize orchestration latency)
- **`gemini-3.5-flash-medium`**: `review`, `received-review` (needs moderate reasoning budget to analyze requirements and guardrails)
- **`gemini-3.5-flash-low`**: `commit`, `commit-fixes`, `version`, `pr`, `cleanup`, `archive-openspec`, `learnings-commit` (simple tasks requiring maximum speed).

#### 3. Static Routing in `plan-sdlc` Subagents
Assigned static logic depths to `plan.js` critique subagents previously sharing a generic base flash model:
- **`gemini-3.5-flash-medium`**: Applied to `content-coverage`, `guardrail-compliance`, `dimension-coverage`, and all three `lensReviewers` (Architecture, Requirements, Risk).
- **`gemini-3.5-flash-low`**: Applied to `static-structural` and `file-existence` checks.

- **Orchestrator Lock:** Permanently locked the `wave-runner` orchestrator Agent to `gemini-3.5-flash-low`. It performs mechanical string parsing and looping, and thus never needs deep reasoning loops.
- **Worker Suffix Presets:** Attached explicit reasoning suffixes directly to the workers in the Model Presets table to match the Quality presets (`-low`, `-medium`, `-high`), forming a perfect continuum of cost vs capability.
- **Dynamic Retry Escalation:** Per-task retries now actively escalate the reasoning budget before escalating the model architecture. (e.g., `gemini-3.5-flash-medium` -> `gemini-3.5-flash-high` -> `gemini-3.1-pro-low`).

#### 5. Documentation Upgrades
- **`docs/model-references.md`**: Updated the Inventory Mapping table to replace "Bypasses dynamic suffix" with "Uses static suffixes assigned in ship.js" and updated default pipeline mappings.
- **`docs/sdlc-plugin-architecture-report.md`**: Updated the Model Routing section to clarify that suffixes define reasoning budgets and are now handled via hardcoded static assignments.

### Impact
This change guarantees stable, predictable cost modeling across all pipeline stages, eliminates the disk I/O penalty of querying git histories for byte budgets, and properly aligns the model execution with computational reasoning bounds instead of outdated token context limits.
