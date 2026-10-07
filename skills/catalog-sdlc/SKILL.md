---
name: catalog-sdlc
description: "Scan, index, and visualize delivery plans across workspaces or single projects. Parses plan markdown, reconciles execution runs and TODO blockers, computes DAG dependencies, and generates an interactive, zero-dependency HTML dashboard. Triggers on: plan catalog, delivery dashboard, index plans, view delivery graph, catalog plans, show plan dashboard, /catalog-sdlc."
user-invocable: true
argument-hint: "[--workspace <dir>] [--project <dir>] [--json <path>] [--html <path>]"
---

# Universal Plan Catalog & Delivery Dashboard (catalog-sdlc)

Universal indexing engine and interactive dashboard for machine-readable delivery plans, waves, tasks, and status reconciliation across repositories.

Textual Markdown plans (`docs/plans/*.md`, `docs/TODO/*.md`) remain the **single source of truth (SSOT)**. This skill builds a canonical machine-readable JSON representation (`delivery-graph.json`) and an autonomous, portable HTML dashboard (`delivery_dashboard.html`).

---

## Capabilities

1. **Deterministic Markdown Parsing (Zero-LLM):**
   - Extracts plan goals, architecture summaries, and verification commands.
   - Extracts CPM waves and tasks across 4 formats:
     - Standard `plan-sdlc` (`### Task 1: [Title]`)
     - `trade-robot-alpha` wave definitions (`#### Task W0-T01: [Title]`, `### Wave 0`)
     - `lift-fixed-price` review fixes (`### X1 — [Title]`, `### W1 — [Title]`)
     - MVP and list-style breakdowns (`* **Task 0.1: [Title]**`)
   - Insulates code fences (```) to avoid false task matches.
   - Preserves raw task `markdownSource` chunks for instantaneous zero-disk inspection.

2. **3-Tier Execution & Status Reconciliation:**
   - Scans `.sdlc/execution/execute-*.json` records.
   - Resolves plan runs via:
     1. Exact normalized file path match.
     2. Exact SHA-256 `planHash` match (preserves links if files move to `docs/archived/`).
     3. Basename match.
   - Tolerates markdown checkbox drift (`driftStatus: "pristine" | "drifted"`).
   - Reconciles task completion, failure, and execution evidence.

3. **Blocker Binding & Dispatch Readiness:**
   - Bidirectionally links `docs/TODO/*.md` notes with tasks.
   - Flags tasks blocked by active P0 TODOs.
   - Computes `isReadyToDispatch`: tasks in backlog with all upstream dependencies completed and no active P0 blockers.

4. **Portable Zero-Dependency Dashboard:**
   - Single autonomous HTML file viewable directly via `file://`.
   - SVG-rendered DAG curves with directional arrowheads.
   - Interactive upstream / downstream dependency highlighting.
   - Non-modal task drawer with live status, acceptance criteria, file perimeter, and agent prompt copy.
   - Multi-view layout: DAG Flow, Task Matrix, Blockers & TODOs, Raw JSON.

---

## CLI Usage

Generate catalog JSON and HTML visualization:

```bash
# Scan an entire workspace directory containing multiple projects
node scripts/skill/catalog.js --workspace /path/to/workspace --html docs/visualizations/delivery_dashboard.html

# Scan a single project directory
node scripts/skill/catalog.js --project . --json .sdlc/catalog/delivery-graph.json --html docs/visualizations/delivery_dashboard.html
```

### Command Arguments

| Argument | Description | Default |
|---|---|---|
| `--workspace <dir>` | Directory containing project repositories to scan | None |
| `--project <dir>` | Single project root directory to index | Current directory (`.`) |
| `--json <path>` | Destination path for canonical `delivery-graph.json` | `.sdlc/catalog/delivery-graph.json` |
| `--html <path>` | Destination path for standalone HTML dashboard | `docs/visualizations/delivery_dashboard.html` |

---

## Output Files

- **`schemas/delivery-graph.schema.json`**: Canonical JSON Schema for machine-readable delivery graphs.
- **`.sdlc/catalog/delivery-graph.json`**: Indexed delivery graph data.
- **`delivery_dashboard.html`**: Zero-dependency interactive web dashboard.
