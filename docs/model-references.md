# Model Usage & References in Lift-SDLC

This document serves as the canonical reference for how models and reasoning budgets are assigned and dynamically routed across Lift-SDLC skills, agents, pipeline steps, review dimensions, and scripts.

---

## 1. Overview & Core Philosophy

Lift-SDLC employs a **quality-tier model routing system** (*«Flash Hands, Pro Brain & Eyes»*). Rather than using a single global model for every action, orchestrators dynamically dispatch subagents using reasoning budgets tailored to task complexity, risk, and cognitive demand:

- **Flash (low / medium)**: Optimized for throughput, deterministic checks, and low latency. Used by primary orchestrators, file discovery, routine code edits, unit test authoring, and documentation reviews.
- **Flash (high)**: Used for high-speed cross-file pattern analysis, complex PR descriptions, graph circularity/wave validation, and API/pipeline contracts.
- **Pro (low / high)**: Reserved for deep architectural planning, critical review dimensions (security, data integrity, concurrency), and automated failure recovery escalation.

---

## 2. Quality Presets (`--quality`)

The SDLC execution and ship skills expose a `--quality` flag (configurable via CLI or `.sdlc/config.json`) controlling task worker routing during plan execution:

| Preset | Flag Value | Trivial Tasks | Standard Tasks | Complex Tasks | Typical Use Case |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Speed** | `--quality minimal` | `gemini-3.8-flash-medium` | `gemini-3.8-flash-medium` | `gemini-3.8-flash-high` | Rapid prototyping, mechanical refactoring, 100% Flash throughput |
| **Balanced** *(Default)* | `--quality balanced` | `gemini-3.8-flash-medium` | `gemini-3.8-flash-medium` | `gemini-3.8-flash-high`* | Daily development; fast Flash execution with automatic Pro escalation on retry |
| **Quality** | `--quality full` | `gemini-3.8-flash-medium` | `gemini-3.1-pro-low` | `gemini-3.1-pro-high` | High-stakes architectural tasks, critical infrastructure, deep reasoning |

*\* In Balanced mode, Complex tasks start on `gemini-3.8-flash-high`. If verification fails, Retry 1 automatically escalates to `gemini-3.1-pro-low`, and Retry 2 escalates to `gemini-3.1-pro-high`.*

### High-Risk Task Override
Any task with `Risk: High` (authentication, authorization, session management, cryptography, database migrations, credentials, destructive file/functionality removal, shared mutable state) automatically escalates to `gemini-3.1-pro-low` (`pro`), regardless of its complexity class.

### Task Recovery Escalation Ladder
When a task fails verification in `execute-plan-sdlc`, the retry mechanism advances the assigned model exactly one step along the ladder:
```
gemini-3.8-flash-low → gemini-3.8-flash-medium → gemini-3.8-flash-high → gemini-3.1-pro-low → gemini-3.1-pro-high → User Escalation
```

---

## 3. User-Facing Skills (`skills/*/SKILL.md`)

Each skill defines its base orchestrator model in its frontmatter:

| Skill Name | Location | Frontmatter Model | Purpose & Execution Context |
| :--- | :--- | :--- | :--- |
| **`commit-sdlc`** | [skills/commit-sdlc/SKILL.md](../skills/commit-sdlc/SKILL.md) | `gemini-3.8-flash-medium` | Analyzes staged diffs and drafts conventional commit messages |
| **`error-report-sdlc`** | [skills/error-report-sdlc/SKILL.md](../skills/error-report-sdlc/SKILL.md) | `gemini-3.8-flash-medium` | Prepares and formats sanitized bug reports |
| **`execute-plan-sdlc`** | [skills/execute-plan-sdlc/SKILL.md](../skills/execute-plan-sdlc/SKILL.md) | `gemini-3.8-flash-medium` | Coordinates wave-based plan execution with adaptive budgeting |
| **`github-sdlc`** | [skills/github-sdlc/SKILL.md](../skills/github-sdlc/SKILL.md) | `gemini-3.8-flash-medium` | GitHub CLI operations, issue and PR interaction |
| **`harden-sdlc`** | [skills/harden-sdlc/SKILL.md](../skills/harden-sdlc/SKILL.md) | `gemini-3.8-flash-high` | Deep error analysis and guardrail synthesis following pipeline failure |
| **`jira-sdlc`** | [skills/jira-sdlc/SKILL.md](../skills/jira-sdlc/SKILL.md) | `gemini-3.8-flash-medium` | Jira issue lifecycle management via MCP tools |
| **`learn-sdlc`** | [skills/learn-sdlc/SKILL.md](../skills/learn-sdlc/SKILL.md) | `gemini-3.8-flash-medium` | Self-learning loop: assimilates recurrent patterns into guardrails |
| **`plan-sdlc`** | [skills/plan-sdlc/SKILL.md](../skills/plan-sdlc/SKILL.md) | `gemini-3.8-flash-medium` | Manages discovery, plan generation, gates, and critique |
| **`pr-sdlc`** | [skills/pr-sdlc/SKILL.md](../skills/pr-sdlc/SKILL.md) | `gemini-3.8-flash-medium` | Generates structured PR descriptions and labels |
| **`received-review-sdlc`** | [skills/received-review-sdlc/SKILL.md](../skills/received-review-sdlc/SKILL.md) | `gemini-3.8-flash-high` | Evaluates, verifies, and fixes incoming PR review feedback |
| **`review-sdlc`** | [skills/review-sdlc/SKILL.md](../skills/review-sdlc/SKILL.md) | `gemini-3.8-flash-medium` | Multi-dimension code review orchestrator |
| **`run-workflow`** | [skills/run-workflow/SKILL.md](../skills/run-workflow/SKILL.md) | `gemini-3.8-flash-medium` | Generic pipeline engine executing declarative workflow manifests |
| **`setup-sdlc`** | [skills/setup-sdlc/SKILL.md](../skills/setup-sdlc/SKILL.md) | `gemini-3.8-flash-medium` | Interactive project setup and configuration wizard |
| **`ship-sdlc`** | [skills/ship-sdlc/SKILL.md](../skills/ship-sdlc/SKILL.md) | `gemini-3.8-flash-medium` | State-machine driving end-to-end execution through PR creation |
| **`verify-pipeline-sdlc`** | [skills/verify-pipeline-sdlc/SKILL.md](../skills/verify-pipeline-sdlc/SKILL.md) | `gemini-3.8-flash-medium` | Investigates failed CI workflows and proposes/applies fixes |
| **`version-sdlc`** | [skills/version-sdlc/SKILL.md](../skills/version-sdlc/SKILL.md) | `gemini-3.8-flash-medium` | Semantic versioning, changelog generation, and tag creation |

---

## 4. Orchestrator Subagents (`agents/*.md`)

Orchestrator subagents run in isolated contexts via `invoke_subagent` to keep the main user conversation compact. The `Dispatch Model` column shows the 4-level platform enum passed to `invoke_subagent`:

| Agent Name | File Path | Frontmatter Model | Dispatch Model (`invoke_subagent`) | Primary Role |
| :--- | :--- | :--- | :--- | :--- |
| **`commit-orchestrator`** | [agents/commit-orchestrator.md](../agents/commit-orchestrator.md) | `gemini-3.8-flash-low` | `flash_lite` | Generates conventional commit subject and body from staged diff |
| **`error-report-orchestrator`** | [agents/error-report-orchestrator.md](../agents/error-report-orchestrator.md) | `gemini-3.8-flash-low` | `flash_lite` | Assembles formatted defect report |
| **`harden-orchestrator`** | [agents/harden-orchestrator.md](../agents/harden-orchestrator.md) | `gemini-3.8-flash-low` | `flash_lite` | Classifies failure causes and proposes guardrail strengthenings |
| **`learn-review-only`** | [agents/learn-review-only.md](../agents/learn-review-only.md) | `gemini-3.8-flash-low` | `flash_lite` | Pre-screen assessment of synthesized guardrails against regressions |
| **`learn-synthesis-orchestrator`** | [agents/learn-synthesis-orchestrator.md](../agents/learn-synthesis-orchestrator.md) | `gemini-3.8-flash-low` | `flash_lite` | Synthesizes candidate guardrails from recurring learning signatures |
| **`plan-execution-validator`** | [agents/plan-execution-validator.md](../agents/plan-execution-validator.md) | `gemini-3.8-flash-high` | `flash` | Validates plan integrity (DAG cycles, vague tasks, file conflicts) |
| **`plan-explore-orchestrator`** | [agents/plan-explore-orchestrator.md](../agents/plan-explore-orchestrator.md) | `gemini-3.8-flash-low` | `flash` | Derives 3–7 dynamic discovery dimensions and fans out research |
| **`plan-generation-orchestrator`** | [agents/plan-generation-orchestrator.md](../agents/plan-generation-orchestrator.md) | `gemini-3.1-pro-high` | `pro` | **Deep multi-wave architectural plan generation** |
| **`received-review-orchestrator`** | [agents/received-review-orchestrator.md](../agents/received-review-orchestrator.md) | `gemini-3.8-flash-low` | `flash_lite` | Clusters PR comments and coordinates thread verifiers |
| **`review-orchestrator`** | [agents/review-orchestrator.md](../agents/review-orchestrator.md) | `gemini-3.8-flash-low` | `flash_lite` | Coordinates parallel review dimension subagents |

---

## 5. SDLC End-to-End Pipeline Steps (`ship-sdlc` / `pipeline.json`)

When `ship-sdlc` runs, steps are dispatched according to [pipeline.json](../skills/ship-sdlc/pipeline.json) and [ship.js](../scripts/skill/ship.js):

| Pipeline Step ID | Dispatched Skill / Handler | Mode | Default Model | Notes / Escalation |
| :--- | :--- | :--- | :--- | :--- |
| **`execute`** | `execute-plan-sdlc` | `agent` | `gemini-3.8-flash-medium` | Forwards `--quality` flag to wave execution |
| **`commit`** | `commit-sdlc` | `agent` | `gemini-3.8-flash-medium` | Creates isolated commit for implemented plan |
| **`review`** | `review-sdlc` | `agent` | `gemini-3.8-flash-medium` | Dispatches active review dimensions |
| **`received-review`** | `received-review-sdlc` | `agent` | `gemini-3.8-flash-high` | Conditional: triggered if review findings ≥ threshold |
| **`commit-fixes`** | `commit-sdlc` | `agent` | `gemini-3.8-flash-medium` | Conditional: commits fixes applied during review |
| **`version`** | `version-sdlc` | `agent` | `gemini-3.8-flash-medium` | Calculates semver bump and tags release |
| **`archive-openspec`** | `inlineHandler: openspec-archive` | `inline` | `gemini-3.8-flash-medium` | Archives completed OpenSpec change specs |
| **`pr`** | `pr-sdlc` | `agent` | `gemini-3.8-flash-high` | Higher-tier model ensures comprehensive PR description |
| **`verify-pipeline`** | `inlineHandler: ci-polling` | `inline loop` | — | Polls remote CI checks |
| ↳ *subDispatch 1* | `verify-pipeline-sdlc` | `agent` | `gemini-3.8-flash-high` | Analyzes CI logs upon failure |
| ↳ *subDispatch 2* | `commit-sdlc` | `agent` | `gemini-3.8-flash-medium` | Commits CI fix patch |
| **`await-remote-review`** | `inlineHandler: remote-review-polling` | `inline loop` | — | Polls for remote bot reviews (e.g. Copilot) |
| ↳ *subDispatch 1* | `received-review-sdlc` | `agent` | `gemini-3.8-flash-high` | Processes bot comments |
| ↳ *subDispatch 2* | `commit-sdlc` | `agent` | `gemini-3.8-flash-medium` | Commits bot review fixes |
| **`learnings-commit`** | `inlineHandler: learnings` | `inline` | `gemini-3.8-flash-medium` | Appends learnings log and commits |
| **`cleanup`** | `inlineHandler: cleanup` | `inline` | `gemini-3.8-flash-medium` | Terminal state cleanup and worktree prune |

---

## 6. Planning Sub-Agents, Gates & Lenses (`plan-sdlc`)

### A. Dynamic Discovery Fan-Out (`plan-explore-orchestrator`)
When deriving dynamic discovery dimensions, models are assigned based on task nature:
- **Surface scan (`code`)**: `gemini-3.8-flash-medium` (file enumeration, regex/pattern matching, caller locations)
- **Standard analysis (`code` / `web`)**: `gemini-3.8-flash-medium` (API usage, cross-file reasoning, docs lookup)
- **Complex tracing (`hybrid` / architecture)**: `gemini-3.1-pro-high` (deep architectural integration, multi-hop dependency tracing)

### B. Quality Gate Lanes (Parallel Fan-Out via `lanes[]`)
Plan validation gates G1–G17 are partitioned across 5 parallel lanes:
- `static-structural` (G1–G3, G7, G12): `gemini-3.8-flash-low`
- `file-existence` (G4, G10): `gemini-3.8-flash-low`
- `content-coverage` (G5, G6, G8, G9, G11, G13, G15, G16): `gemini-3.8-flash-medium`
- `guardrail-compliance` (G14): `gemini-3.8-flash-medium`
- `dimension-coverage` (G17): `gemini-3.8-flash-medium`

### C. Multi-Lens Critique Reviewers (`lensReviewers[]`)
Evaluates plan quality across 3 lenses: `architecture`, `requirements`, and `risk`:
- **Plans < 5 tasks**: Single reviewer using `gemini-3.8-flash-medium`.
- **Plans ≥ 5 tasks**: Parallel 3-lens fan-out with **Cross-Model Override**:
  - If plan was authored by Flash (`gemini-3.8-flash-medium`) → review with **`gemini-3.1-pro-low`**
  - If plan was authored by Pro (`gemini-3.1-pro-*`) → review with **`gemini-3.8-flash-high`**

---

## 7. Review Dimensions Catalog Model Mappings

As defined in [skills/setup-sdlc/resources/dimension-catalog.md](../skills/setup-sdlc/resources/dimension-catalog.md) and checked by `scripts/lib/dimensions.js`:

| Dimension Category | Dimension Name | Default Severity | Target Model |
| :--- | :--- | :--- | :--- |
| **Core High-Risk** | `security-review` | high | `gemini-3.1-pro-low` |
| | `data-integrity-review` | high | `gemini-3.1-pro-low` |
| | `concurrency-review` | high | `gemini-3.1-pro-low` |
| | `database-migrations-review` | high | `gemini-3.1-pro-low` |
| | `spec-compliance-review` | high | `gemini-3.1-pro-low` |
| **Architectural & Contracts** | `api-contract-review` | high | `gemini-3.8-flash-high` |
| | `plugin-architecture-review` | medium | `gemini-3.8-flash-high` |
| | `sdk-library-design-review` | high | `gemini-3.8-flash-high` |
| | `data-pipeline-review` | high | `gemini-3.8-flash-high` |
| | `microservices-review` | medium | `gemini-3.8-flash-high` |
| **Component & Engineering** | `code-quality-review` | medium | `gemini-3.8-flash-medium` |
| | `api-review` | high | `gemini-3.8-flash-medium` |
| | `test-coverage-review` | medium | `gemini-3.8-flash-medium` |
| | `performance-review` | medium | `gemini-3.8-flash-medium` |
| | `type-safety-review` | medium | `gemini-3.8-flash-medium` |
| | `dependency-management-review` | medium | `gemini-3.8-flash-medium` |
| | `error-handling-review` | medium | `gemini-3.8-flash-medium` |
| | `ui-review` | medium | `gemini-3.8-flash-medium` |
| | `state-management-review` | medium | `gemini-3.8-flash-medium` |
| | `infrastructure-review` | medium | `gemini-3.8-flash-medium` |
| | `ci-cd-pipeline-review` | medium | `gemini-3.8-flash-medium` |
| | `configuration-management-review`| medium | `gemini-3.8-flash-medium` |
| | `accessibility-review` | medium | `gemini-3.8-flash-medium` |
| | `logging-observability-review` | medium | `gemini-3.8-flash-medium` |
| | `cli-ux-review` | medium | `gemini-3.8-flash-medium` |
| | `monorepo-governance-review` | medium | `gemini-3.8-flash-medium` |
| | `mobile-app-review` | medium | `gemini-3.8-flash-medium` |
| | `ml-ai-review` | medium | `gemini-3.8-flash-medium` |
| **Low-Risk & Documentation** | `documentation-review` | low | `gemini-3.8-flash-medium` |
| | `naming-conventions-review` | low | `gemini-3.8-flash-medium` |
| | `documentation-quality-review` | low | `gemini-3.8-flash-medium` |
| | `internationalization-review` | low | `gemini-3.8-flash-medium` |

---

## 8. Received Review Thread Verifiers (`received-review-sdlc`)

When verifying outstanding review threads via [received-review-orchestrator.md](../agents/received-review-orchestrator.md):
- Any thread in the group has `severity: "critical"` → Dispatched to **`pro`** (`gemini-3.1-pro-*`)
- Otherwise → Dispatched to **`flash`** (`gemini-3.8-flash-*`)

---

## 9. Scripts & Runtime Implementation References

| Script / Library | Path | Role in Model Routing |
| :--- | :--- | :--- |
| **`dispatch-budget.js`** | [scripts/lib/dispatch-budget.js](../scripts/lib/dispatch-budget.js) | Strips budget suffixes (`-low`, `-medium`, `-high`) to base models (`gemini-3.8-flash`, `gemini-3.1-pro`) and calculates adaptive wave concurrency limits based on 1M token input windows (75% reserve). |
| **`dimensions.js`** | [scripts/lib/dimensions.js](../scripts/lib/dimensions.js) | Canonical validator maintaining `VALID_MODELS`: `gemini-3.8-flash-low`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-high`, `gemini-3.1-pro-low`, `gemini-3.1-pro-high`. |
| **`ship.js`** | [scripts/skill/ship.js](../scripts/skill/ship.js) | Emits structured step manifests assigning target models to pipeline stages (`execute`, `pr`, `received-review`, etc.). |
| **`plan.js`** | [scripts/skill/plan.js](../scripts/skill/plan.js) | Prepares `lanes[]` and `lensReviewers[]` metadata with their respective model configurations. |
| **`review.js`** | [scripts/skill/review.js](../scripts/skill/review.js) | Ingests frontmatter `model` from active dimensions, falling back to `subagent_model` (`gemini-3.8-flash-medium`). |
| **`run-workflow.js`** | [scripts/skill/run-workflow.js](../scripts/skill/run-workflow.js) | Dispatches pipeline steps as subagents honoring `step.model`. |
| **`validate-cost-tiers.js`**| [scripts/ci/validate-cost-tiers.js](../scripts/ci/validate-cost-tiers.js) | CI verification script checking frontmatter model drift against documentation. |
