# Model Usage & References in Lift-SDLC

This document outlines how models are utilized across Lift-SDLC, how the dynamic quality presets behave, and provides a reference map to simplify future model upgrades.

## Overview

Lift-SDLC uses a **quality-tier model routing system** to assign different models based on the complexity, risk, and size of the task. Instead of using a single global model for every action, orchestrators dispatch sub-agents dynamically. 

- **Trivial/Standard Tasks:** Routed to `gemini-3.8-flash-low` or `gemini-3.8-flash-medium` to prioritize speed, low latency, and cost-efficiency.
- **Complex Tasks:** In Balanced mode, executed on `gemini-3.8-flash-high` for fast execution and low latency, with automatic escalation to `gemini-3.1-pro-low` upon verification failure. In Full mode, routed directly to `gemini-3.1-pro-high`.
- **Architectural Planning & Auditing:** The plan generation orchestrator uses `gemini-3.1-pro-high`, while security, architecture, and concurrency review dimensions use `gemini-3.1-pro-low` to provide true model diversity.

## Quality Presets

The SDLC execution and ship skills expose a `--quality` flag that adjusts the model selection dynamically:

- **`--quality minimal` (Speed):** Forces `gemini-3.8-flash` for all tasks, allocating budgets dynamically: `-low` (Trivial), `-medium` (Standard), and `-high` (Complex). Perfect for rapid prototyping where throughput is prioritized (100% Flash).
- **`--quality balanced` (Default — Hybrid):** Uses hybrid routing (*Flash Hands, Pro Brain & Eyes*). Assigns `gemini-3.8-flash-low` (Trivial), `gemini-3.8-flash-medium` (Standard), and `gemini-3.8-flash-high` (Complex). If a complex task fails verification, it automatically escalates to `gemini-3.1-pro-low` on Retry 1. Security and architecture review dimensions run on `gemini-3.1-pro-low`.
- **`--quality full` (Quality):** Forces `gemini-3.1-pro` for non-trivial tasks (`-low` for Standard, `-high` for Complex) and routes Trivial to `gemini-3.8-flash-medium`. Runs a spec-compliance review.

## Future Model Upgrades

To upgrade to a new generation of models in the future, you must update the following four areas of the plugin:

1. **Agent & Skill Frontmatters:** Update the `model:` definition at the top of the Markdown files in `agents/` and `skills/`.
2. **Execution Scripts:** Update the programmatic model routing in `scripts/skill/ship.js`, `scripts/skill/plan.js`, and `scripts/skill/review.js`.
3. **Budget Configurations:** Update the token limitations in `scripts/lib/dispatch-budget.js` to match the new models' max input bytes.
4. **Documentation:** Update references in guides (e.g., `classifying-and-waving-tasks.md`) to reflect the new escalation paths.

---

### Inventory Mapping Table

The following table summarizes the explicit model mappings across Lift-SDLC skills, agents, and prompts, including the reasoning for their reasoning budget allocations.

| File Type | Component | Target Model | Reason |
|-----------|-----------|--------------|--------|
| Skill | `harden-sdlc` | `gemini-3.8-flash-high` | High cognitive context for error analysis |
| Skill | `error-report-sdlc` | `gemini-3.8-flash-medium` | Standard routing, formats error reports |
| Skill | `commit-sdlc` | `gemini-3.8-flash-medium` | Standard routine parsing and generation |
| Skill | `ship-sdlc` (Explicit dispatch) | `gemini-3.8-flash-medium` / `-high`| Uses static suffixes assigned in ship.js |
| Skill | `ship-sdlc` (Default pipeline) | `gemini-3.8-flash-medium` | State-machine orchestrator |
| Skill | `plan-sdlc` | `gemini-3.8-flash-medium` | Orchestrator routing and check logic |
| Agent | `error-report-orchestrator` | `gemini-3.8-flash-low` | Enforce fast reasoning bounds natively in frontmatter |
| Agent | `harden-orchestrator` | `gemini-3.8-flash-low` | Enforce fast reasoning bounds natively in frontmatter |
| Agent | `commit-orchestrator` | `gemini-3.8-flash-low` | Enforce fast reasoning bounds natively in frontmatter |
| Agent | `plan-explore-orchestrator`| `gemini-3.8-flash-low` | Enforce fast reasoning bounds natively in frontmatter |
| Agent | `review-orchestrator` | `gemini-3.8-flash-low` | Enforce fast reasoning bounds natively in frontmatter |
| Agent | `plan-execution-validator` | `gemini-3.8-flash-high` | Fast deterministic graph circularity & collision check |
| Agent | `plan-generation-orchestrator` | `gemini-3.1-pro-high` | Deep multi-wave architectural plan drafting |
| Prompt | `lane-static-structural` | `gemini-3.8-flash-low` | Simple file structure check |
| Prompt | `lens-requirements` | `gemini-3.8-flash-medium` | Needs reasoning buffer for planning |
| Prompt | `lane-guardrail-compliance`| `gemini-3.8-flash-medium` | Needs reasoning buffer for planning |
| Prompt | `lens-risk` | `gemini-3.8-flash-medium` | Needs reasoning buffer for planning |
| Prompt | `lens-architecture` | `gemini-3.8-flash-medium` | Needs reasoning buffer for planning |
| Prompt | `g17-dimension-coverage` | `gemini-3.8-flash-medium` | Needs reasoning buffer for planning |
| Prompt | `lane-file-existence` | `gemini-3.8-flash-low` | Simple check |
| Prompt | `lane-content-coverage` | `gemini-3.8-flash-medium` | Needs reasoning buffer for planning |

---

## File Reference Map

The following tables map exactly where specific models are hardcoded or referenced in the plugin source code.

### Agents
*Orchestrators that manage the lifecycle of sub-agents.*

| Agent Name | File Path | Models Referenced |
|------------|-----------|-------------------|
| `commit-orchestrator` | [agents/commit-orchestrator.md](../agents/commit-orchestrator.md) | `gemini-3.8-flash-low` |
| `error-report-orchestrator` | [agents/error-report-orchestrator.md](../agents/error-report-orchestrator.md) | `gemini-3.8-flash-low` |
| `harden-orchestrator` | [agents/harden-orchestrator.md](../agents/harden-orchestrator.md) | `gemini-3.8-flash-low` |
| `plan-execution-validator` | [agents/plan-execution-validator.md](../agents/plan-execution-validator.md) | `gemini-3.8-flash-high` |
| `plan-explore-orchestrator` | [agents/plan-explore-orchestrator.md](../agents/plan-explore-orchestrator.md) | `gemini-3.8-flash-low` |
| `plan-generation-orchestrator` | [agents/plan-generation-orchestrator.md](../agents/plan-generation-orchestrator.md) | `gemini-3.1-pro-high` |
| `review-orchestrator` | [agents/review-orchestrator.md](../agents/review-orchestrator.md) | `gemini-3.8-flash-low` |

### Skills
*User-facing skills and their associated Markdown templates/documentation.*

| Skill Name | File Path | Models Referenced |
|------------|-----------|-------------------|
| `commit-sdlc` | [skills/commit-sdlc/SKILL.md](../skills/commit-sdlc/SKILL.md) | `gemini-3.8-flash-medium` |
| `error-report-sdlc` | [skills/error-report-sdlc/SKILL.md](../skills/error-report-sdlc/SKILL.md) | `gemini-3.8-flash-medium` |
| `execute-plan-sdlc` | [skills/execute-plan-sdlc/SKILL.md](../skills/execute-plan-sdlc/SKILL.md) | `gemini-3.1-pro-low`, `gemini-3.1-pro-high`, `gemini-3.8-flash-low`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-high` |
| `execute-plan-sdlc` | [skills/execute-plan-sdlc/resources/classifying-and-waving-tasks.md](../skills/execute-plan-sdlc/resources/classifying-and-waving-tasks.md) | `gemini-3.1-pro-low`, `gemini-3.1-pro-high`, `gemini-3.8-flash-low`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-high` |
| `execute-plan-sdlc` | [skills/execute-plan-sdlc/resources/recovering-from-failures.md](../skills/execute-plan-sdlc/resources/recovering-from-failures.md) | `gemini-3.1-pro-low`, `gemini-3.1-pro-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-high` |
| `execute-plan-sdlc` | [skills/execute-plan-sdlc/resources/spec-compliance-reviewer.md](../skills/execute-plan-sdlc/resources/spec-compliance-reviewer.md) | `gemini-3.8-flash-medium` |
| `execute-plan-sdlc` | [skills/execute-plan-sdlc/resources/wave-runner-template.md](../skills/execute-plan-sdlc/resources/wave-runner-template.md) | `gemini-3.1-pro-low`, `gemini-3.1-pro-high`, `gemini-3.8-flash-low`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-high` |
| `github-sdlc` | [skills/github-sdlc/SKILL.md](../skills/github-sdlc/SKILL.md) | `gemini-3.8-flash-medium` |
| `harden-sdlc` | [skills/harden-sdlc/SKILL.md](../skills/harden-sdlc/SKILL.md) | `gemini-3.8-flash-high` |
| `jira-sdlc` | [skills/jira-sdlc/SKILL.md](../skills/jira-sdlc/SKILL.md) | `gemini-3.8-flash-medium` |
| `plan-sdlc` | [skills/plan-sdlc/SKILL.md](../skills/plan-sdlc/SKILL.md) | `gemini-3.8-flash-medium`, `gemini-3.1-pro-low` |
| `pr-sdlc` | [skills/pr-sdlc/SKILL.md](../skills/pr-sdlc/SKILL.md) | `gemini-3.8-flash-medium` |
| `received-review-sdlc` | [skills/received-review-sdlc/SKILL.md](../skills/received-review-sdlc/SKILL.md) | `gemini-3.8-flash-high` |
| `review-sdlc` | [skills/review-sdlc/resources/EXAMPLES.md](../skills/review-sdlc/resources/EXAMPLES.md) | `gemini-3.8-flash-medium` |
| `review-sdlc` | [skills/review-sdlc/resources/REFERENCE.md](../skills/review-sdlc/resources/REFERENCE.md) | `gemini-3.1-pro-low`, `gemini-3.8-flash-low`, `gemini-3.8-flash-medium` |
| `review-sdlc` | [skills/review-sdlc/SKILL.md](../skills/review-sdlc/SKILL.md) | `gemini-3.8-flash-medium` |
| `run-workflow` | [skills/run-workflow/SKILL.md](../skills/run-workflow/SKILL.md) | `gemini-3.8-flash-medium` |
| `setup-sdlc` | [skills/setup-sdlc/SKILL.md](../skills/setup-sdlc/SKILL.md) | `gemini-3.8-flash-medium` |
| `ship-sdlc` | [skills/ship-sdlc/SKILL.md](../skills/ship-sdlc/SKILL.md) | `gemini-3.8-flash-medium`, `gemini-3.8-flash-high` |
| `verify-pipeline-sdlc` | [skills/verify-pipeline-sdlc/SKILL.md](../skills/verify-pipeline-sdlc/SKILL.md) | `gemini-3.8-flash-medium` |
| `version-sdlc` | [skills/version-sdlc/SKILL.md](../skills/version-sdlc/SKILL.md) | `gemini-3.8-flash-medium` |

### Scripts & Libraries
*JavaScript utility files that handle budget allocation and dynamic model routing.*

| Script Name | File Path | Models Referenced |
|-------------|-----------|-------------------|
| `dispatch-budget.js` | [scripts/lib/dispatch-budget.js](../scripts/lib/dispatch-budget.js) | `gemini-3.1-pro`, `gemini-3.8-flash` variants (suffixes stripped at runtime) |
| `plan.js` | [scripts/skill/plan.js](../scripts/skill/plan.js) | `gemini-3.8-flash-low`, `gemini-3.8-flash-medium` |
| `review.js` | [scripts/skill/review.js](../scripts/skill/review.js) | `gemini-3.8-flash-medium` |
| `ship.js` | [scripts/skill/ship.js](../scripts/skill/ship.js) | `gemini-3.8-flash-medium`, `gemini-3.8-flash-high` |

---

## See Also

*   **Architecture & Agent Relations**: For a deeper dive into how models map to specific agent layers, see the [SDLC Plugin Architecture Report](./sdlc-plugin-architecture-report.md).
