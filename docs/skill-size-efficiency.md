# SDLC Skill Size & Context Efficiency Report

This document outlines the sizes of the core SDLC skills and validates their efficiency concerning Gemini token footprints and dynamic context management.

## Size Metrics

The sizes of the `SKILL.md` files (as of the Gemini model migration) are listed below.

### The Heaviest Orchestrators
- `execute-plan-sdlc`: 895 lines / ~75 KB
- `ship-sdlc`: 970 lines / ~64 KB
- `jira-sdlc` & `setup-sdlc`: ~600-700 lines / ~40 KB
- `plan-sdlc`: 540 lines / ~39 KB

### The Lightest Utilities
- `commit-sdlc`: 339 lines / ~21 KB
- `harden-sdlc`: 357 lines / ~17 KB
- `error-report-sdlc`: 176 lines / ~8 KB
- `verify-pipeline-sdlc`: 79 lines / ~4 KB

## Efficiency Validation

These sizes are highly optimized and well within safe limits for modern Gemini models.

### 1. Token Footprint is Negligible
A general rule of thumb is 1 token ≈ 4 bytes. The absolute largest skill (`execute-plan-sdlc` at 75KB) translates to roughly **~18,000 tokens**. Given Gemini 3.5 Flash and Gemini 3.1 Pro's native multi-hundred-thousand to 1M+ token context windows, the system instructions consume **less than 2%** of the available context. This leaves massive headroom for user code, diffs, and CI logs.

### 2. Perfect Alignment with `-low` Mappings
The skills mapped to `gemini-3.8-flash-low` natively in their orchestrator frontmatters (`commit-sdlc`, `harden-sdlc`, `error-report-sdlc`) are remarkably compact (between 8KB and 21KB, or roughly **2K–5K tokens**). This validates the mapping strategy: they act as extremely tight, fast-executing system prompts that will never hit context limits even on strict `-low` bounds, unless a user passes an impossibly large git diff.

### 3. High Density where it Counts
`ship-sdlc` and `execute-plan-sdlc` are the largest files because they contain dense state-machine logic, retry mechanisms, and complex pipeline routing. These are the skills that natively receive `-medium` or `pro` mappings, perfectly handling their slightly heavier system prompts while leaving ample context for pipeline logs and execution traces.

---

## See Also

*   **Architecture & Agent Relations**: To understand how these efficient skills fit into the broader Layer 1/Layer 2 agent architecture, see the [SDLC Plugin Architecture Report](./sdlc-plugin-architecture-report.md).
