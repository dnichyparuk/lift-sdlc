# `lift-sdlc` Documentation Index

This directory is organized by document lifecycle and audience:

## Core Reference Docs (`docs/`)
Live operational documentation kept in sync with the codebase and CI validators:
- [`configuration.md`](./configuration.md) — `.sdlc/config.json`, `.sdlc/local.json`, permissions, and plugin install paths
- [`model-references.md`](./model-references.md) — Gemini 4 model routing, `agy` runtime enums, and escalation ladders *(CI-validated by `npm run check:tiers`)*
- [`quality-tiers.md`](./quality-tiers.md) — Execution quality presets (`minimal`, `balanced`, `full`) and Neon-for-Coding
- [`plugin-api-specs.md`](./plugin-api-specs.md) — Antigravity CLI (`agy` v1.5+) manifest, frontmatter, hook, and workflow contracts
- [`telemetry-and-state-tracking.md`](./telemetry-and-state-tracking.md) — Execution state files, hook enforcement ring, and token budgets
- [`openspec-integration.md`](./openspec-integration.md) — OpenSpec delta specs and lifecycle integration
- [`changes-log.md`](./changes-log.md) — Release history and changelog

## Executable Plans (`docs/plans/`)
Canonical implementation plans following `PLAN_GUIDELINES.md` (consumable by `/execute-plan-sdlc`, `/ship-sdlc`, and `/catalog-sdlc`):
- [`plans/README.md`](./plans/README.md) — Index of active and completed plans
- [`plans/2026-11-25-phase2-agy-native-optimization.md`](./plans/2026-11-25-phase2-agy-native-optimization.md) — Phase 2 (`agy`-Native Optimization) implementation plan (4 waves, 15 tasks)

## Architecture (`docs/architecture/`)
System architecture reports, reviews, workflow taxonomy, and ADRs:
- [`architecture/sdlc-plugin-architecture-report.md`](./architecture/sdlc-plugin-architecture-report.md) — Four-layer plugin architecture & native `run_workflow` topology
- [`architecture/2026-11-25-agy-v1.5-architecture-review.md`](./architecture/2026-11-25-agy-v1.5-architecture-review.md) — Ground-truth architecture inventory & `agy` v1.5.17 evaluation (Phase 1 baseline)
- [`architecture/workflow-classes.md`](./architecture/workflow-classes.md) — Workflow class taxonomy and dispatch rules
- [`architecture/rejected-patterns.md`](./architecture/rejected-patterns.md) — Documented anti-patterns and rejected designs

## Feature Design & Historical Records
- [`self-learning/`](./self-learning/) — Self-learning loop ADR, proposal, external-harness review, and finalization plan
- [`analysis/`](./analysis/) — Point-in-time platform and feature analysis reports (`antigravity-skills-migration-analysis.md`, `native-features-report.md`, `ship-analysis.md`, `skill-size-efficiency.md`)
- [`optimizations/`](./optimizations/) — Skill optimization and script migration studies
- [`delivery-dashboard/`](./delivery-dashboard/) — Delivery dashboard mockup, schema, and plan
