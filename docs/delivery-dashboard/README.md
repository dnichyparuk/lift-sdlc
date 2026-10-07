# Delivery Dashboard & Universal Plan Catalog

A catalog of project plans, specifications and artifacts for building a machine-readable plan graph (`delivery-graph.json`) and an interactive dashboard (`delivery_dashboard.html`).

## Artifacts in this directory:

1. [**`plan.md`**](./plan.md) — The full technical specification, the 4-level plan hierarchy, the Markdown parsing algorithms, the status reconciliation logic and the verification plan.
2. [**`mockup.html`**](./mockup.html) — An interactive HTML mockup of the dashboard (Option B) with real data from the `trade-robot-alpha` and `lift-fixed-price` projects.
3. [**`delivery-graph.schema.json`**](./delivery-graph.schema.json) — The canonical JSON schema of the `DeliveryGraph` standard.
4. [**`sample-delivery-graph.json`**](./sample-delivery-graph.json) — A sample generated graph of plans, waves, tasks and TODO notes for both projects.

## Purpose of the subsystem:
* Building an up-to-date graph of links between strategic plans (`docs/plans/*.md`), execution plans (`plan-sdlc`), agent runs (`.sdlc/execution/execute-*.json`) and deferred tasks (`docs/TODO/*.md`).
* Providing a visual interactive dashboard for developers and project teams while keeping Markdown as the single source of truth (SSOT).
