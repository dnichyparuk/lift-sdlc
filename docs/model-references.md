# Model Usage & References in SDLC Plugin

This document outlines how models are utilized across the SDLC plugin, how the dynamic quality presets behave, and provides a reference map to simplify future model upgrades.

## Overview

The SDLC plugin uses a **quality-tier model routing system** to assign different models based on the complexity, risk, and size of the task. Instead of using a single global model for every action, orchestrators dispatch sub-agents dynamically. 

- **Trivial/Standard Tasks:** Routed to `gemini-3.5-flash` to prioritize speed, low latency, and cost-efficiency.
- **Complex/Architectural Tasks:** Routed to `gemini-3.1-pro` to ensure maximum correctness and deep reasoning.

## Quality Presets

The SDLC execution and ship skills expose a `--quality` flag that adjusts the model selection dynamically:

- **`--quality minimal` (Speed):** Overrides all task dispatches to use `gemini-3.5-flash`. Perfect for rapid prototyping or mechanical refactoring where throughput is prioritized over deep reasoning.
- **`--quality balanced` (Default):** Uses dynamic routing. Assigns `gemini-3.5-flash` to trivial and standard tasks, and automatically escalates to `gemini-3.1-pro` for complex tasks or critical pipeline steps.
- **`--quality full` (Quality):** Overrides all task dispatches to use `gemini-3.1-pro`. Forces the highest reasoning capability across every single subagent, guaranteeing maximum correctness for critical deployments.

## Future Model Upgrades

To upgrade to a new generation of models in the future, you must update the following four areas of the plugin:

1. **Agent & Skill Frontmatters:** Update the `model:` definition at the top of the Markdown files in `agents/` and `skills/`.
2. **Execution Scripts:** Update the programmatic model routing in `scripts/skill/ship.js`, `scripts/skill/plan.js`, and `scripts/skill/review.js`.
3. **Budget Configurations:** Update the token limitations in `scripts/lib/dispatch-budget.js` to match the new models' max input bytes.
4. **Documentation:** Update references in guides (e.g., `classifying-and-waving-tasks.md`) to reflect the new escalation paths.

---

## File Reference Map

The following tables map exactly where specific models are hardcoded or referenced in the plugin source code.

### Agents
*Orchestrators that manage the lifecycle of sub-agents.*

| Agent Name | File Path | Models Referenced |
|------------|-----------|-------------------|
| `commit-orchestrator` | [agents/commit-orchestrator.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/agents/commit-orchestrator.md) | `gemini-3.5-flash` |
| `error-report-orchestrator` | [agents/error-report-orchestrator.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/agents/error-report-orchestrator.md) | `gemini-3.5-flash` |
| `harden-orchestrator` | [agents/harden-orchestrator.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/agents/harden-orchestrator.md) | `gemini-3.5-flash` |
| `plan-explore-orchestrator` | [agents/plan-explore-orchestrator.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/agents/plan-explore-orchestrator.md) | `gemini-3.5-flash` |
| `review-orchestrator` | [agents/review-orchestrator.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/agents/review-orchestrator.md) | `gemini-3.5-flash` |

### Skills
*User-facing skills and their associated Markdown templates/documentation.*

| Skill Name | File Path | Models Referenced |
|------------|-----------|-------------------|
| `commit-sdlc` | [skills/commit-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/commit-sdlc/SKILL.md) | `gemini-3.5-flash` |
| `error-report-sdlc` | [skills/error-report-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/error-report-sdlc/SKILL.md) | `gemini-3.5-flash` |
| `execute-plan-sdlc` | [skills/execute-plan-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/execute-plan-sdlc/SKILL.md) | `gemini-3.1-pro`, `gemini-3.5-flash` |
| `execute-plan-sdlc` | [skills/execute-plan-sdlc/classifying-and-waving-tasks.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/execute-plan-sdlc/classifying-and-waving-tasks.md) | `gemini-3.1-pro`, `gemini-3.5-flash` |
| `execute-plan-sdlc` | [skills/execute-plan-sdlc/recovering-from-failures.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/execute-plan-sdlc/recovering-from-failures.md) | `gemini-3.1-pro`, `gemini-3.5-flash` |
| `execute-plan-sdlc` | [skills/execute-plan-sdlc/spec-compliance-reviewer.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/execute-plan-sdlc/spec-compliance-reviewer.md) | `gemini-3.5-flash` |
| `execute-plan-sdlc` | [skills/execute-plan-sdlc/wave-runner-template.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/execute-plan-sdlc/wave-runner-template.md) | `gemini-3.1-pro`, `gemini-3.5-flash` |
| `github-sdlc` | [skills/github-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/github-sdlc/SKILL.md) | `gemini-3.5-flash` |
| `harden-sdlc` | [skills/harden-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/harden-sdlc/SKILL.md) | `gemini-3.5-flash` |
| `jira-sdlc` | [skills/jira-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/jira-sdlc/SKILL.md) | `gemini-3.5-flash` |
| `plan-sdlc` | [skills/plan-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/plan-sdlc/SKILL.md) | `gemini-3.1-pro` |
| `pr-sdlc` | [skills/pr-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/pr-sdlc/SKILL.md) | `gemini-3.5-flash` |
| `received-review-sdlc` | [skills/received-review-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/received-review-sdlc/SKILL.md) | `gemini-3.1-pro` |
| `review-sdlc` | [skills/review-sdlc/EXAMPLES.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/review-sdlc/EXAMPLES.md) | `gemini-3.5-flash` |
| `review-sdlc` | [skills/review-sdlc/REFERENCE.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/review-sdlc/REFERENCE.md) | `gemini-3.1-pro`, `gemini-3.5-flash` |
| `review-sdlc` | [skills/review-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/review-sdlc/SKILL.md) | `gemini-3.5-flash` |
| `setup-sdlc` | [skills/setup-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/setup-sdlc/SKILL.md) | `gemini-3.5-flash` |
| `ship-sdlc` | [skills/ship-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/ship-sdlc/SKILL.md) | `gemini-3.5-flash` |
| `verify-pipeline-sdlc` | [skills/verify-pipeline-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/verify-pipeline-sdlc/SKILL.md) | `gemini-3.5-flash` |
| `version-sdlc` | [skills/version-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/version-sdlc/SKILL.md) | `gemini-3.5-flash` |

### Scripts & Libraries
*JavaScript utility files that handle budget allocation and dynamic model routing.*

| Script Name | File Path | Models Referenced |
|-------------|-----------|-------------------|
| `dispatch-budget.js` | [scripts/lib/dispatch-budget.js](file:///home/dzmitry/.gemini/config/plugins/sdlc/scripts/lib/dispatch-budget.js) | `gemini-3.1-pro`, `gemini-3.5-flash` |
| `plan.js` | [scripts/skill/plan.js](file:///home/dzmitry/.gemini/config/plugins/sdlc/scripts/skill/plan.js) | `gemini-3.5-flash` |
| `review.js` | [scripts/skill/review.js](file:///home/dzmitry/.gemini/config/plugins/sdlc/scripts/skill/review.js) | `gemini-3.5-flash` |
| `ship.js` | [scripts/skill/ship.js](file:///home/dzmitry/.gemini/config/plugins/sdlc/scripts/skill/ship.js) | `gemini-3.1-pro`, `gemini-3.5-flash` |
