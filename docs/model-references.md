# Model Usage & References in Lift-SDLC

This document serves as the canonical reference for how Gemini 4 model profiles and `agy` runtime enums are assigned and dynamically routed across Lift-SDLC skills, agents, pipeline steps, review dimensions, and scripts.

---

## 1. Overview & Core Philosophy

Lift-SDLC employs a **quality-tier model routing system** (*«Hydrogen Hands, Neon/Argon/Carbon Brain & Eyes»*) mapped onto the Antigravity CLI (`agy`) 4-level subagent `Model` enum (`inherit | flash_lite | flash | pro`) via `scripts/lib/model-tiers.js`:

- **Gemini 4 Hydrogen (`gemini-4-hydrogen-low` → `flash_lite`; `medium` / `high` / `xhigh` → `flash`)**: Optimized for throughput, deterministic checks, and low latency. Used by thin orchestrators (`flash`), file discovery, trivial code edits, Speed-tier tasks, and standard review dimensions (`flash`).
- **Gemini 4 Neon (`gemini-4-neon-*` → `pro`)**: Primary coding and architectural review tier mapped to `pro`. Used as the **Neon-for-Coding** baseline (`balanced` Standard & Complex tasks), high-risk overrides, spec compliance review, `architecture` plan lens, and security/data/API review dimensions.
- **Gemini 4 Argon (`gemini-4-argon-*` → `pro`)**: Specialized cross-family reasoning tier mapped to `pro`. Used for `requirements` and `risk` plan review lenses (cross-family diversity alongside Neon), capability escalations, and `spec-compliance-review` / `concurrency-review` / `api-contract-review` dimensions.
- **Gemini 4 Carbon (`gemini-4-carbon-*` → `pro`)**: Flagship reasoning tier reserved for deep multi-wave architectural planning (`plan-generation-orchestrator`), Quality-tier (`--quality full`) Complex tasks, and top-tier capability escalation.

---

## 2. Quality Presets (`--quality`)

The SDLC execution and ship skills expose a `--quality` flag (configurable via CLI, `.sdlc/config.json`, or `.sdlc/local.json`) controlling task worker routing during plan execution:

| Preset | Flag Value | Trivial Tasks | Standard Tasks | Complex Tasks | Typical Use Case |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Speed** | `--quality minimal` | `gemini-4-hydrogen-medium` (`flash`) | `gemini-4-hydrogen-medium` (`flash`) | `gemini-4-hydrogen-high` (`flash`) | Rapid prototyping, mechanical refactoring, 100% Hydrogen throughput |
| **Balanced** *(Default)* | `--quality balanced` | `gemini-4-hydrogen-medium` (`flash`) | `gemini-4-neon-low` (`pro`)* | `gemini-4-neon-medium` (`pro`) | Daily development; Hydrogen trivials with Neon-for-Coding Standard & Complex execution |
| **Quality** | `--quality full` | `gemini-4-hydrogen-medium` (`flash`) | `gemini-4-neon-medium` (`pro`) | `gemini-4-carbon-medium` (`pro`) | High-stakes architectural tasks, critical infrastructure, flagship Carbon reasoning |

*\* `execute.standardWorkerEnum: "pro" | "inherit"` (default `"pro"`): Neon-session users may set `"inherit"` in `.sdlc/config.json` or `.sdlc/local.json` so Balanced Standard tasks inherit the session's Neon model; `"pro"` ensures Hydrogen sessions still route Standard tasks to Neon.*

### High-Risk Task Override
Any task with `Risk: High` (authentication, authorization, session management, cryptography, database migrations, credentials, destructive file/functionality removal, shared mutable state) automatically escalates to `gemini-4-neon-low` / `gemini-4-neon-medium` (`pro`), regardless of its complexity class.

### Failure-Aware Task Recovery Escalation Ladder
When a task fails verification in `execute-plan-sdlc`, retry routing (`escalateLogicalModel` in `scripts/lib/model-tiers.js`) depends on the failure signal (`escalationBudget: 2`, granting every starting tier — including `pro` — its full 2 retries before user escalation):
- **`NEEDS_CONTEXT`**: Re-dispatch on the **same** model (`assignedModel` / same `agy` enum) with missing context supplied.
- **`SPEC_GAP`**: Jump directly to Argon (`gemini-4-argon-low` / `pro`), or `gemini-4-carbon-medium` if already Argon, `neon-high`/`xhigh`, or Carbon (preserving `gemini-4-carbon-high`).
- **`FAILED_TESTS` / `FAILED_BUILD` / `BLOCKED` / capability failures**: Escalate one step per retry along the Gemini 4 ladder:
```
gemini-4-hydrogen-low (flash_lite) → gemini-4-hydrogen-medium/high (flash) → gemini-4-neon-low/medium (pro) → gemini-4-argon-low/medium (pro) → gemini-4-carbon-medium/high (pro) → User Escalation
```
At the `agy` runtime level (`scripts/lib/model-tiers.js::escalateAgyModel`), enums advance `flash_lite → flash → pro`, while logical `hydrogen → neon → argon → carbon` escalation continues across both `pro` retries.

---

## 3. User-Facing Skills (`skills/*/SKILL.md`)

`agy` ignores `model:` frontmatter on `SKILL.md` files; skills run in the caller's active session model (`inherit`) and pass `Model:` explicitly when invoking subagents via `invoke_subagent`. `model:` frontmatter has been removed from skills (this table is informational and tracked by `scripts/ci/validate-cost-tiers.js`).

| Skill Name | Location | Frontmatter Model | Purpose & Execution Context |
| :--- | :--- | :--- | :--- |
| **`catalog-sdlc`** | [skills/catalog-sdlc/SKILL.md](../skills/catalog-sdlc/SKILL.md) | `none (inherited)` | Indexes delivery plans and generates `delivery-graph.json` and the HTML dashboard |
| **`commit-sdlc`** | [skills/commit-sdlc/SKILL.md](../skills/commit-sdlc/SKILL.md) | `none (inherited)` | Analyzes staged diffs and drafts conventional commit messages |
| **`error-report-sdlc`** | [skills/error-report-sdlc/SKILL.md](../skills/error-report-sdlc/SKILL.md) | `none (inherited)` | Prepares and formats sanitized bug reports |
| **`execute-plan-sdlc`** | [skills/execute-plan-sdlc/SKILL.md](../skills/execute-plan-sdlc/SKILL.md) | `none (inherited)` | Coordinates wave-based plan execution with adaptive budgeting |
| **`github-sdlc`** | [skills/github-sdlc/SKILL.md](../skills/github-sdlc/SKILL.md) | `none (inherited)` | GitHub CLI operations, issue and PR interaction |
| **`harden-sdlc`** | [skills/harden-sdlc/SKILL.md](../skills/harden-sdlc/SKILL.md) | `none (inherited)` | Deep error analysis and guardrail synthesis following pipeline failure |
| **`jira-sdlc`** | [skills/jira-sdlc/SKILL.md](../skills/jira-sdlc/SKILL.md) | `none (inherited)` | Jira issue lifecycle management via MCP tools |
| **`learn-sdlc`** | [skills/learn-sdlc/SKILL.md](../skills/learn-sdlc/SKILL.md) | `none (inherited)` | Self-learning loop: assimilates recurrent patterns into guardrails |
| **`pipeline-sdlc`** | [skills/pipeline-sdlc/SKILL.md](../skills/pipeline-sdlc/SKILL.md) | `none (inherited)` | Generic pipeline engine executing declarative workflow manifests |
| **`plan-guide-sdlc`** | [skills/plan-guide-sdlc/SKILL.md](../skills/plan-guide-sdlc/SKILL.md) | `none (inherited)` | Initializes `PLAN_GUIDELINES.md` and links it in `AGENTS.md` |
| **`plan-sdlc`** | [skills/plan-sdlc/SKILL.md](../skills/plan-sdlc/SKILL.md) | `none (inherited)` | Manages discovery, plan generation, gates, and critique |
| **`pr-sdlc`** | [skills/pr-sdlc/SKILL.md](../skills/pr-sdlc/SKILL.md) | `none (inherited)` | Generates structured PR descriptions and labels |
| **`received-review-sdlc`** | [skills/received-review-sdlc/SKILL.md](../skills/received-review-sdlc/SKILL.md) | `none (inherited)` | Evaluates, verifies, and fixes incoming PR review feedback |
| **`review-sdlc`** | [skills/review-sdlc/SKILL.md](../skills/review-sdlc/SKILL.md) | `none (inherited)` | Multi-dimension code review orchestrator |
| **`setup-sdlc`** | [skills/setup-sdlc/SKILL.md](../skills/setup-sdlc/SKILL.md) | `none (inherited)` | Interactive project setup and configuration wizard |
| **`ship-sdlc`** | [skills/ship-sdlc/SKILL.md](../skills/ship-sdlc/SKILL.md) | `none (inherited)` | State-machine driving end-to-end execution through PR creation |
| **`verify-pipeline-sdlc`** | [skills/verify-pipeline-sdlc/SKILL.md](../skills/verify-pipeline-sdlc/SKILL.md) | `none (inherited)` | Investigates failed CI workflows and proposes/applies fixes |
| **`version-sdlc`** | [skills/version-sdlc/SKILL.md](../skills/version-sdlc/SKILL.md) | `none (inherited)` | Semantic versioning, changelog generation, and tag creation |

---

## 4. Orchestrator & Worker Subagents (`agents/*.md`)

Subagents run in isolated contexts via `invoke_subagent` to keep the main user conversation compact. The `Dispatch Model` column shows the 4-level `agy` runtime enum (`inherit | flash_lite | flash | pro`) mapped from Gemini 4 profiles by `toAgyModelEnum`:

| Agent Name | File Path | Frontmatter Model | Gemini 4 Profile | Primary Role |
| :--- | :--- | :--- | :--- | :--- |
| **`commit-orchestrator`** | [agents/commit-orchestrator.md](../agents/commit-orchestrator.md) | `flash_lite` | `gemini-4-hydrogen-low` | Generates conventional commit subject and body from staged diff |
| **`error-report-orchestrator`** | [agents/error-report-orchestrator.md](../agents/error-report-orchestrator.md) | `flash` | `gemini-4-hydrogen-medium` | Assembles formatted defect report |
| **`harden-orchestrator`** | [agents/harden-orchestrator.md](../agents/harden-orchestrator.md) | `pro` | `gemini-4-argon-low` | Classifies failure causes and proposes guardrail strengthenings |
| **`learn-review-only`** | [agents/learn-review-only.md](../agents/learn-review-only.md) | `flash` | `gemini-4-hydrogen-high` | Pre-screen assessment of synthesized guardrails against regressions |
| **`learn-synthesis-orchestrator`** | [agents/learn-synthesis-orchestrator.md](../agents/learn-synthesis-orchestrator.md) | `pro` | `gemini-4-argon-medium` | Synthesizes candidate guardrails from recurring learning signatures |
| **`plan-execution-validator`** | [agents/plan-execution-validator.md](../agents/plan-execution-validator.md) | `pro` | `gemini-4-argon-low` | Validates plan integrity (DAG cycles, vague tasks, file conflicts) |
| **`plan-explore-orchestrator`** | [agents/plan-explore-orchestrator.md](../agents/plan-explore-orchestrator.md) | `flash` | `gemini-4-hydrogen-high` | Derives 3–7 dynamic discovery dimensions and fans out research |
| **`plan-generation-orchestrator`** | [agents/plan-generation-orchestrator.md](../agents/plan-generation-orchestrator.md) | `pro` | `gemini-4-carbon-medium` / `carbon-high` / `argon-medium` | **Deep multi-wave architectural plan generation** |
| **`received-review-orchestrator`** | [agents/received-review-orchestrator.md](../agents/received-review-orchestrator.md) | `flash` | `gemini-4-hydrogen-medium` | Clusters PR comments and coordinates thread verifiers |
| **`review-orchestrator`** | [agents/review-orchestrator.md](../agents/review-orchestrator.md) | `flash` | `gemini-4-hydrogen-high` | Coordinates parallel review dimension subagents |
| **`spec-compliance-reviewer`** | [agents/spec-compliance-reviewer.md](../agents/spec-compliance-reviewer.md) | `pro` | `gemini-4-argon-low` / `argon-medium` | Verifies wave and cross-wave implementations against plan specs and OpenSpec deltas |
| **`task-implementer`** | [agents/task-implementer.md](../agents/task-implementer.md) | `flash` | `gemini-4-hydrogen-medium` / `neon-*` (`flash` / `pro`) | Executes individual plan tasks from fact sheets under quality-tier routing |

---

## 5. SDLC End-to-End Pipeline Steps (`ship-sdlc` / `pipeline.json`)

When `ship-sdlc` runs, steps are dispatched according to [pipeline.json](../skills/ship-sdlc/pipeline.json) and [ship.js](../scripts/skill/ship.js):

| Pipeline Step ID | Dispatched Skill / Handler | Mode | Default Model (`agy` enum) | Notes / Escalation |
| :--- | :--- | :--- | :--- | :--- |
| **`execute`** | `execute-plan-sdlc` | `agent` | `inherit` | Forwards `--quality` flag to wave execution |
| **`commit`** | `commit-sdlc` | `agent` | `gemini-4-hydrogen-medium` (`flash`) | Creates isolated commit for implemented plan |
| **`review`** | `review-sdlc` | `agent` | `gemini-4-hydrogen-medium` (`flash`) | Dispatches active review dimensions |
| **`received-review`** | `received-review-sdlc` | `agent` | `gemini-4-neon-low` (`pro`) | Conditional: triggered if review findings ≥ threshold |
| **`commit-fixes`** | `commit-sdlc` | `agent` | `gemini-4-hydrogen-medium` (`flash`) | Conditional: commits fixes applied during review |
| **`version`** | `version-sdlc` | `agent` | `gemini-4-hydrogen-medium` (`flash`) | Calculates semver bump and tags release |
| **`archive-openspec`** | `inlineHandler: openspec-archive` | `inline` | — | Inline deterministic: archives completed OpenSpec change specs (`defaultModel: null`) |
| **`pr`** | `pr-sdlc` | `agent` | `gemini-4-hydrogen-high` (`flash`) | Creates structured PR description and labels |
| **`verify-pipeline`** | `inlineHandler: ci-polling` | `inline loop` | — | Inline deterministic: polls remote CI checks (`defaultModel: null`) |
| ↳ *subDispatch 1* | `verify-pipeline-sdlc` | `agent` | `gemini-4-neon-low` (`pro`) | Analyzes CI logs upon failure |
| ↳ *subDispatch 2* | `commit-sdlc` | `agent` | `gemini-4-hydrogen-medium` (`flash`) | Commits CI fix patch |
| **`await-remote-review`** | `inlineHandler: remote-review-polling` | `inline loop` | — | Inline deterministic: polls for remote bot reviews (`defaultModel: null`) |
| ↳ *subDispatch 1* | `received-review-sdlc` | `agent` | `gemini-4-neon-low` (`pro`) | Processes bot comments |
| ↳ *subDispatch 2* | `commit-sdlc` | `agent` | `gemini-4-hydrogen-medium` (`flash`) | Commits bot review fixes |
| **`learnings-commit`** | `inlineHandler: learnings` | `inline` | — | Inline deterministic: appends learnings log and commits (`defaultModel: null`) |
| **`cleanup`** | `inlineHandler: cleanup` | `inline` | — | Inline deterministic: terminal state cleanup and worktree prune (`defaultModel: null`) |

---

## 6. Planning Sub-Agents, Gates & Lenses (`plan-sdlc`)

### A. Dynamic Discovery Fan-Out (`plan-explore-orchestrator`)
When deriving dynamic discovery dimensions, models are assigned based on task nature:
- **Surface scan (`code`)**: `gemini-4-hydrogen-medium` (`flash`)
- **Standard analysis (`code` / `web`)**: `gemini-4-hydrogen-high` (`flash`)
- **Complex tracing (`hybrid` / architecture)**: `gemini-4-neon-high` / `gemini-4-carbon-high` (`pro`)

### B. Quality Gate Lanes (Deterministic Static Check + Parallel Fan-Out via `lanes[]`)
Plan validation gates G1–G17 are partitioned across 1 deterministic static check (`--critique-static`, 0 LLM calls) and up to 4 parallel LLM lanes (`scripts/skill/plan.js`):
- `--critique-static` (G3, G4, G10, G12): deterministic Node.js check (0 LLM calls)
- `static-structural` (G1, G2, G7; plus rolled-in G14/G17 when guardrails/dimensions are absent): `gemini-4-hydrogen-medium` (`flash`)
- `content-coverage` (G5, G6, G8, G9, G11, G13, G15, G16): `gemini-4-hydrogen-high` (`flash`)
- `guardrail-compliance` (G14): `gemini-4-hydrogen-medium` (`flash`)
- `dimension-coverage` (G17): `gemini-4-hydrogen-medium` (`flash`)

### C. Multi-Lens Critique Reviewers (`lensReviewers[]`)
Evaluates plan quality across 3 lenses using **Cross-Family Pro Diversity** (`architecture`: `gemini-4-neon-medium` / `pro`, `requirements`: `gemini-4-argon-low` / `pro`, `risk`: `gemini-4-argon-low` / `pro`):
- **Plans < 5 tasks**: Single reviewer using `gemini-4-hydrogen-medium` (`flash`).
- **Plans ≥ 5 tasks**: Parallel 3-lens fan-out with **Cross-Family Pro Diversity**:
  - `architecture` → `gemini-4-neon-medium` (`Model: "pro"`)
  - `requirements` → `gemini-4-argon-low` (`Model: "pro"`)
  - `risk` → `gemini-4-argon-low` (`Model: "pro"`)
  - Pro lenses are never downgraded to `flash`; pairing Neon with Argon preserves cross-family diversity at Pro quality.

---

## 7. Review Dimensions Catalog Model Mappings

As defined in [skills/setup-sdlc/resources/dimension-catalog.md](../skills/setup-sdlc/resources/dimension-catalog.md) and checked by `scripts/lib/dimensions.js`:

| Dimension Category | Dimension Name | Default Severity | Target Model |
| :--- | :--- | :--- | :--- |
| **Core High-Risk** | `security-review` | high | `gemini-4-neon-medium` (`pro`) |
| | `data-integrity-review` | high | `gemini-4-neon-low` (`pro`) |
| | `concurrency-review` | high | `gemini-4-argon-medium` (`pro`) |
| | `database-migrations-review` | high | `gemini-4-neon-low` (`pro`) |
| | `spec-compliance-review` | high | `gemini-4-argon-medium` (`pro`) |
| **Architectural & Contracts** | `api-contract-review` | high | `gemini-4-argon-low` (`pro`) |
| | `api-review` | high | `gemini-4-neon-low` (`pro`) |
| | `plugin-architecture-review` | medium | `gemini-4-hydrogen-high` (`flash`) |
| | `sdk-library-design-review` | high | `gemini-4-hydrogen-high` (`flash`) |
| | `data-pipeline-review` | high | `gemini-4-hydrogen-high` (`flash`) |
| | `microservices-review` | medium | `gemini-4-hydrogen-high` (`flash`) |
| **Component & Engineering** | `code-quality-review` | medium | `gemini-4-hydrogen-medium` (`flash`) |
| | `test-coverage-review` | medium | `gemini-4-hydrogen-medium` (`flash`) |
| | `performance-review` | medium | `gemini-4-hydrogen-medium` (`flash`) |
| | `type-safety-review` | medium | `gemini-4-hydrogen-medium` (`flash`) |
| | `dependency-management-review` | medium | `gemini-4-hydrogen-medium` (`flash`) |
| | `error-handling-review` | medium | `gemini-4-hydrogen-medium` (`flash`) |
| | `ui-review` | medium | `gemini-4-hydrogen-medium` (`flash`) |
| | `state-management-review` | medium | `gemini-4-hydrogen-medium` (`flash`) |
| | `infrastructure-review` | medium | `gemini-4-hydrogen-medium` (`flash`) |
| | `ci-cd-pipeline-review` | medium | `gemini-4-hydrogen-medium` (`flash`) |
| | `configuration-management-review`| medium | `gemini-4-hydrogen-medium` (`flash`) |
| | `accessibility-review` | medium | `gemini-4-hydrogen-medium` (`flash`) |
| | `logging-observability-review` | medium | `gemini-4-hydrogen-medium` (`flash`) |
| | `cli-ux-review` | medium | `gemini-4-hydrogen-medium` (`flash`) |
| | `monorepo-governance-review` | medium | `gemini-4-hydrogen-medium` (`flash`) |
| | `mobile-app-review` | medium | `gemini-4-hydrogen-medium` (`flash`) |
| | `ml-ai-review` | medium | `gemini-4-hydrogen-medium` (`flash`) |
| **Low-Risk & Documentation** | `documentation-review` | low | `gemini-4-hydrogen-medium` (`flash`) |
| | `naming-conventions-review` | low | `gemini-4-hydrogen-medium` (`flash`) |
| | `documentation-quality-review` | low | `gemini-4-hydrogen-medium` (`flash`) |
| | `internationalization-review` | low | `gemini-4-hydrogen-medium` (`flash`) |

---

## 8. Received Review Thread Verifiers (`received-review-sdlc`)

When verifying outstanding review threads via [received-review-orchestrator.md](../agents/received-review-orchestrator.md):
- Any thread in the group has `severity: "critical"` or `"high"` → Dispatched to **`pro`** (`gemini-4-neon-low`)
- Otherwise → Dispatched to **`flash`** (`gemini-4-hydrogen-*`)

---

## 9. Scripts & Runtime Implementation References

| Script / Library | Path | Role in Model Routing |
| :--- | :--- | :--- |
| **`model-tiers.js`** | [scripts/lib/model-tiers.js](../scripts/lib/model-tiers.js) | Canonical Gemini 4 tier list (`GEMINI4_MODELS`), `toAgyModelEnum` (`inherit \| flash_lite \| flash \| pro`), `escalateAgyModel` (`flash_lite -> flash -> pro`), and failure-aware `escalateLogicalModel`. |
| **`dispatch-budget.js`** | [scripts/lib/dispatch-budget.js](../scripts/lib/dispatch-budget.js) | Strips budget suffixes (`-low`, `-medium`, `-high`, `-xhigh`) to Gemini 4 base models (`gemini-4-hydrogen`, `gemini-4-neon`, `gemini-4-argon`, `gemini-4-carbon`) and calculates adaptive wave concurrency limits based on 1M token input windows (25% output reserve default; 35% for `-xhigh` and `gemini-4-carbon-high`). |
| **`dimensions.js`** | [scripts/lib/dimensions.js](../scripts/lib/dimensions.js) | Validates review dimension frontmatter and `model:` overrides. |
| **`ship.js`** | [scripts/skill/ship.js](../scripts/skill/ship.js) | Emits structured step manifests assigning target models from `pipeline.json` to pipeline stages. |
| **`plan.js`** | [scripts/skill/plan.js](../scripts/skill/plan.js) | Prepares `lanes[]` and `lensReviewers[]` metadata with Gemini 4 models and `agyModel` enums. |
| **`review.js`** | [scripts/skill/review.js](../scripts/skill/review.js) | Ingests frontmatter `model` from active dimensions, falling back to `subagent_model` (`gemini-4-hydrogen-medium`). |
| **`run-workflow.js`** | [scripts/skill/run-workflow.js](../scripts/skill/run-workflow.js) | Dispatches pipeline steps as subagents honoring `step.model` mapped to `agy` enums. |
| **Native `run_workflow` scripts** | `skills/{ship-sdlc,execute-plan-sdlc,review-sdlc,received-review-sdlc}/workflows/*.py` | Flattened Python workflow scripts (`ship.py`, `execute.py`, `review.py`, `verify.py`) that keep subagent depth ≤ 1 via `call_tool("run_command", ...)`, `asyncio.gather(..., return_exceptions=True)`, and JSON-schema-enforced `agent()`. |
| **`validate-cost-tiers.js`** | [scripts/ci/validate-cost-tiers.js](../scripts/ci/validate-cost-tiers.js) | CI verification script (`npm run check:tiers`) checking frontmatter model drift, `pipeline.json` models, and caller model mismatches against this document. |
