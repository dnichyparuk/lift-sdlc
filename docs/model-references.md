# Model Usage & References in SDLC Plugin

This document outlines how models are utilized across the SDLC plugin, how the dynamic quality presets behave, and provides a reference map to simplify future model upgrades.

## Overview

The SDLC plugin uses a **quality-tier model routing system** to assign different models based on the complexity, risk, and size of the task. Instead of using a single global model for every action, orchestrators dispatch sub-agents dynamically. 

- **Trivial/Standard Tasks:** Routed to `gemini-3.5-flash-low` or `gemini-3.5-flash-medium` to prioritize speed, low latency, and cost-efficiency.
- **Complex/Architectural Tasks:** Routed to `gemini-3.1-pro-high` (or `gemini-3.1-pro-low` in full mode) to ensure maximum correctness and deep reasoning.

## Quality Presets

The SDLC execution and ship skills expose a `--quality` flag that adjusts the model selection dynamically:

- **`--quality minimal` (Speed):** Forces `gemini-3.5-flash` for all tasks, allocating budgets dynamically: `-low` (Trivial), `-medium` (Standard), and `-high` (Complex). Perfect for rapid prototyping where throughput is prioritized.
- **`--quality balanced` (Default):** Uses dynamic routing. Assigns `gemini-3.5-flash-medium` to standard tasks, and automatically escalates to `gemini-3.1-pro-low` for complex tasks or critical pipeline steps.
- **`--quality full` (Quality):** Forces `gemini-3.1-pro` for non-trivial tasks, assigning `-low` for standard and `-high` for complex tasks, guaranteeing maximum correctness.

## Future Model Upgrades

To upgrade to a new generation of models in the future, you must update the following four areas of the plugin:

1. **Agent & Skill Frontmatters:** Update the `model:` definition at the top of the Markdown files in `agents/` and `skills/`.
2. **Execution Scripts:** Update the programmatic model routing in `scripts/skill/ship.js`, `scripts/skill/plan.js`, and `scripts/skill/review.js`.
3. **Budget Configurations:** Update the token limitations in `scripts/lib/dispatch-budget.js` to match the new models' max input bytes.
4. **Documentation:** Update references in guides (e.g., `classifying-and-waving-tasks.md`) to reflect the new escalation paths.

---

### Inventory Mapping Table

The following table summarizes the explicit model mappings across the SDLC plugin skills, agents, and prompts, including the reasoning for their reasoning budget allocations.

| File Type | Component | Target Model | Reason |
|-----------|-----------|--------------|--------|
| Skill | `harden-sdlc` | `gemini-3.5-flash-high` | High cognitive context for error analysis |
| Skill | `error-report-sdlc` | `gemini-3.5-flash-medium` | Standard routing, formats error reports |
| Skill | `commit-sdlc` | `gemini-3.5-flash-medium` | Standard routine parsing and generation |
| Skill | `ship-sdlc` (Explicit dispatch) | `gemini-3.5-flash-medium` / `-high`| Uses static suffixes assigned in ship.js |
| Skill | `ship-sdlc` (Default pipeline) | `gemini-3.5-flash-medium` | State-machine orchestrator |
| Skill | `plan-sdlc` | `gemini-3.5-flash-medium` | Orchestrator routing and check logic |
| Agent | `error-report-orchestrator` | `gemini-3.5-flash-low` | Enforce fast reasoning bounds natively in frontmatter |
| Agent | `harden-orchestrator` | `gemini-3.5-flash-low` | Enforce fast reasoning bounds natively in frontmatter |
| Agent | `commit-orchestrator` | `gemini-3.5-flash-low` | Enforce fast reasoning bounds natively in frontmatter |
| Agent | `plan-explore-orchestrator`| `gemini-3.5-flash-low` | Enforce fast reasoning bounds natively in frontmatter |
| Agent | `review-orchestrator` | `gemini-3.5-flash-low` | Enforce fast reasoning bounds natively in frontmatter |
| Prompt | `lane-static-structural` | `gemini-3.5-flash-low` | Simple file structure check |
| Prompt | `lens-requirements` | `gemini-3.5-flash-medium` | Needs reasoning buffer for planning |
| Prompt | `lane-guardrail-compliance`| `gemini-3.5-flash-medium` | Needs reasoning buffer for planning |
| Prompt | `lens-risk` | `gemini-3.5-flash-medium` | Needs reasoning buffer for planning |
| Prompt | `lens-architecture` | `gemini-3.5-flash-medium` | Needs reasoning buffer for planning |
| Prompt | `g17-dimension-coverage` | `gemini-3.5-flash-medium` | Needs reasoning buffer for planning |
| Prompt | `lane-file-existence` | `gemini-3.5-flash-low` | Simple check |
| Prompt | `lane-content-coverage` | `gemini-3.5-flash-medium` | Needs reasoning buffer for planning |

---

## File Reference Map

The following tables map exactly where specific models are hardcoded or referenced in the plugin source code.

### Agents
*Orchestrators that manage the lifecycle of sub-agents.*

| Agent Name | File Path | Models Referenced |
|------------|-----------|-------------------|
| `commit-orchestrator` | [agents/commit-orchestrator.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/agents/commit-orchestrator.md) | `gemini-3.5-flash-low` |
| `error-report-orchestrator` | [agents/error-report-orchestrator.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/agents/error-report-orchestrator.md) | `gemini-3.5-flash-low` |
| `harden-orchestrator` | [agents/harden-orchestrator.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/agents/harden-orchestrator.md) | `gemini-3.5-flash-low` |
| `plan-explore-orchestrator` | [agents/plan-explore-orchestrator.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/agents/plan-explore-orchestrator.md) | `gemini-3.5-flash-low` |
| `review-orchestrator` | [agents/review-orchestrator.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/agents/review-orchestrator.md) | `gemini-3.5-flash-low` |

### Skills
*User-facing skills and their associated Markdown templates/documentation.*

| Skill Name | File Path | Models Referenced |
|------------|-----------|-------------------|
| `commit-sdlc` | [skills/commit-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/commit-sdlc/SKILL.md) | `gemini-3.5-flash-medium` |
| `error-report-sdlc` | [skills/error-report-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/error-report-sdlc/SKILL.md) | `gemini-3.5-flash-medium` |
| `execute-plan-sdlc` | [skills/execute-plan-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/execute-plan-sdlc/SKILL.md) | `gemini-3.1-pro-low`, `gemini-3.1-pro-high`, `gemini-3.5-flash-low`, `gemini-3.5-flash-medium`, `gemini-3.5-flash-high` |
| `execute-plan-sdlc` | [skills/execute-plan-sdlc/classifying-and-waving-tasks.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/execute-plan-sdlc/classifying-and-waving-tasks.md) | `gemini-3.1-pro-low`, `gemini-3.1-pro-high`, `gemini-3.5-flash-low`, `gemini-3.5-flash-medium`, `gemini-3.5-flash-high` |
| `execute-plan-sdlc` | [skills/execute-plan-sdlc/recovering-from-failures.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/execute-plan-sdlc/recovering-from-failures.md) | `gemini-3.1-pro-low`, `gemini-3.1-pro-high`, `gemini-3.5-flash-medium`, `gemini-3.5-flash-high` |
| `execute-plan-sdlc` | [skills/execute-plan-sdlc/spec-compliance-reviewer.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/execute-plan-sdlc/spec-compliance-reviewer.md) | `gemini-3.5-flash-medium` |
| `execute-plan-sdlc` | [skills/execute-plan-sdlc/wave-runner-template.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/execute-plan-sdlc/wave-runner-template.md) | `gemini-3.1-pro-low`, `gemini-3.1-pro-high`, `gemini-3.5-flash-low`, `gemini-3.5-flash-medium`, `gemini-3.5-flash-high` |
| `github-sdlc` | [skills/github-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/github-sdlc/SKILL.md) | `gemini-3.5-flash-medium` |
| `harden-sdlc` | [skills/harden-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/harden-sdlc/SKILL.md) | `gemini-3.5-flash-high` |
| `jira-sdlc` | [skills/jira-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/jira-sdlc/SKILL.md) | `gemini-3.5-flash-medium` |
| `plan-sdlc` | [skills/plan-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/plan-sdlc/SKILL.md) | `gemini-3.5-flash-medium`, `gemini-3.1-pro-low` |
| `pr-sdlc` | [skills/pr-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/pr-sdlc/SKILL.md) | `gemini-3.5-flash-high` |
| `received-review-sdlc` | [skills/received-review-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/received-review-sdlc/SKILL.md) | `gemini-3.5-flash-high` |
| `review-sdlc` | [skills/review-sdlc/EXAMPLES.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/review-sdlc/EXAMPLES.md) | `gemini-3.5-flash-medium` |
| `review-sdlc` | [skills/review-sdlc/REFERENCE.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/review-sdlc/REFERENCE.md) | `gemini-3.1-pro-low`, `gemini-3.5-flash-low`, `gemini-3.5-flash-medium` |
| `review-sdlc` | [skills/review-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/review-sdlc/SKILL.md) | `gemini-3.5-flash-medium` |
| `setup-sdlc` | [skills/setup-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/setup-sdlc/SKILL.md) | `gemini-3.5-flash-medium` |
| `ship-sdlc` | [skills/ship-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/ship-sdlc/SKILL.md) | `gemini-3.5-flash-medium`, `gemini-3.5-flash-high` |
| `verify-pipeline-sdlc` | [skills/verify-pipeline-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/verify-pipeline-sdlc/SKILL.md) | `gemini-3.5-flash-high` |
| `version-sdlc` | [skills/version-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/version-sdlc/SKILL.md) | `gemini-3.5-flash-medium` |

### Scripts & Libraries
*JavaScript utility files that handle budget allocation and dynamic model routing.*

| Script Name | File Path | Models Referenced |
|-------------|-----------|-------------------|
| `dispatch-budget.js` | [scripts/lib/dispatch-budget.js](file:///home/dzmitry/.gemini/config/plugins/sdlc/scripts/lib/dispatch-budget.js) | `gemini-3.1-pro`, `gemini-3.5-flash` variants (suffixes stripped at runtime) |
| `plan.js` | [scripts/skill/plan.js](file:///home/dzmitry/.gemini/config/plugins/sdlc/scripts/skill/plan.js) | `gemini-3.5-flash-low`, `gemini-3.5-flash-medium` |
| `review.js` | [scripts/skill/review.js](file:///home/dzmitry/.gemini/config/plugins/sdlc/scripts/skill/review.js) | `gemini-3.5-flash-medium` |
| `ship.js` | [scripts/skill/ship.js](file:///home/dzmitry/.gemini/config/plugins/sdlc/scripts/skill/ship.js) | `gemini-3.5-flash-medium`, `gemini-3.5-flash-high` |

---

## See Also

*   **Architecture & Agent Relations**: For a deeper dive into how models map to specific agent layers, see the [SDLC Plugin Architecture Report](./sdlc-plugin-architecture-report.md).
