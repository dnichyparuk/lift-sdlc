# Specification and Implementation Plan: Universal Plan Indexing System (JSON) and Dynamic Dashboard

> **Location:** `lift-sdlc/docs/delivery-dashboard/plan.md`  
> **Status:** Approved for execution in an isolated subagent  
> **Goal:** A universal system for a machine-readable representation of plans (JSON) and an interactive dashboard for all current (`trade-robot-alpha`, `lift-fixed-price`) and future projects.

---

## 1. Concept and the 4-Level Plan Hierarchy

Text plans in Markdown format (`docs/plans/*.md`, `docs/TODO/*.md`) are kept as the **single source of truth (SSOT)**. The machine-readable JSON is built as an up-to-date projection.

The system links 4 levels of artifacts together:
1. **Level 0: Preliminary / Strategic plans (`docs/plans/*.md`, `docs/webapp-concept/mvp/05-*.md`):**
   - Macro goals, invariants, architectural layers, CPM waves.
2. **Level 1: Agent execution plans (`plan-sdlc`):**
   - Tasks with exact `Complexity`, `Risk`, `Depends on`, `Files`, `Acceptance criteria` fields.
   - In the header, the `**Source:**` field explicitly references Level 0.
3. **Level 2: Actual execution by agents (`.sdlc/execution/execute-*.json`, `task-*.md`):**
   - The `planPath` field points to the Level 0/1 plan file.
   - The `planHash` field records the SHA-256 hash of the plan at launch time.
   - The `waves[].tasks[]` field holds the actual execution statuses (`completed`, `failed`), the timing and the real `filesChanged`.
4. **Level 3: Notes and deferred work (`docs/TODO/*.md`):**
   - The `Blocks:` and `Related:` fields link a deferred task to a wave or a plan.
   - Statuses: `open`, `in-progress`, `blocked`, `promoted`, `done`, `wont-do`.

---

## 2. Plan Formats and Extraction Algorithms (Parsing Rules)

The parser `scripts/lib/plan-indexer/markdown-parser.js` extracts data without using LLM tokens (deterministically), supporting 4 main styles:

### 2.1. Document Header
* H1 heading: `^#\s+(.+)$`
* Meta fields:
  - `**Goal:**\s*(.+)`
  - `**Architecture:**\s*(.+)`
  - `**Source:**\s*(.+)`
  - `**Verification:**\s*(.+)`
  - `**Version:**\s*(.+)` or `> \*\*Plan version:\*\*\s*([^\s,]+)`

### 2.2. Tasks: Syntax Patterns
1. **Standard `plan-sdlc`:**
   - Pattern: `^###\s+Task\s+([A-Za-z0-9_.-]+):\s*(.+)$`
   - Metadata:
     - `\*\*Complexity:\*\*\s*(Trivial|Standard|Complex)`
     - `\*\*Risk:\*\*\s*(Low|Medium|High)`
     - `\*\*Depends on:\*\*\s*(.+)` (split on commas, "none" $\to$ `[]`)
     - `\*\*Files:\*\*` with lines `- (?:Create|Modify|Test):\s*`
     - `\*\*Acceptance criteria:\*\*` with lines `- \[([ xX])\]\s*(.+)`
2. **`trade-robot-alpha` wave format:**
   - Pattern: `^####\s+Task\s+([A-Za-z0-9_.-]+):\s*(.+)$`
   - Binding to waves: search for the preceding `^###?\s+(Wave\s+[A-Za-z0-9_.-]+)` or the `SHIPMENT SCOPE` table.
3. **`lift-fixed-price` Review-Fix format:**
   - Pattern: `^###\s+([XW][0-9]+)\s+[—-]\s*(.+)$`
   - Metadata:
     - `\*\*Severity:\*\*\s*([A-Za-z]+)`
     - `\*\*Batch:\*\*\s*([A-Za-z0-9_-]+)`
     - `\*\*Files to modify\*\*`
4. **`docs/TODO/*.md` notes:**
   - Extraction of the metadata table:
     - `\|\s*Status\s*\|\s*([^|]+)\|`
     - `\|\s*Priority\s*\|\s*([^|]+)\|`
     - `\|\s*Blocks\s*\|\s*([^|]+)\|`
     - `\|\s*Related\s*\|\s*([^|]+)\|`
   - Or frontmatter lines: `\*\*Status:\*\*\s*(.+)`, `\*\*Trigger:\*\*\s*(.+)`.

### 2.3. Preserving the Task's Markdown Fragment (Chunking)
For each task, the parser stores the exact line range of the source file (`markdownSource`), which lets the dashboard show rich details without re-reading the disk.

---

## 3. Status Reconciliation Module (Reconciler Engine)

The module `scripts/lib/plan-indexer/reconciler.js` computes the final status of a task:
1. If the task is present in `.sdlc/execution/execute-*.json` with status `completed` $\to$ status `done`.
2. If all checkboxes in the markdown are ticked `- [x]` and/or there is a commit in Git $\to$ status `done`.
3. If the task is marked as blocked or is linked to a `TODO` with status `blocked`/`P0` $\to$ status `blocked`.
4. If there are intermediate file changes or WIP commits $\to$ status `in_progress`.
5. Otherwise $\to$ status `todo`.

Status of the plan itself:
* If the path contains `/archived/` $\to$ `archived`.
* If all tasks are `done` $\to$ `done`.
* If there are `done` or `in_progress` tasks $\to$ `in_progress`.
* Otherwise $\to$ `proposed`.

---

## 4. Dashboard Architecture: Option B with a Transition to Option A

### Option B (Initial):
* A standalone `delivery_dashboard.html` file;
* Embedded JSON `<script id="delivery-data" type="application/json">`;
* Plain Vanilla JS + CSS (no external CDNs, opens via `file://`);
* Modular UI architecture:
  - `DAG Flow` (SVG link curves, upstream/downstream highlighting);
  - `Task Matrix` (sortable task table);
  - `TODOs & Blockers` (blocker matrix);
  - `Raw JSON` (viewer with a copy button);
  - `Task Inspector Drawer` (slide-out panel with the checklist, files and Markdown).

### Transition to Option A (Future Vite + React SPA):
* The `delivery-model.js` data model is already written as pure ESM;
* React components simply replace the DOM rendering, consuming the same `DeliveryGraph` via `fetch('/api/delivery-graph')`.

---

## 5. Implementation File Structure in `lift-sdlc`

```text
lift-sdlc/
├── schemas/
│   └── delivery-graph.schema.json         # Canonical JSON schema
├── scripts/
│   ├── lib/
│   │   └── plan-indexer/
│   │       ├── markdown-parser.js         # Deterministic plan parser
│   │       ├── reconciler.js              # Status reconciliation with git and .sdlc/execution
│   │       ├── model.js                   # DAG graph and filtering logic
│   │       ├── markdown-parser.test.js    # Parser unit tests
│   │       └── reconciler.test.js         # Reconciliation unit tests
│   └── skill/
│       ├── catalog.js                     # CLI script for scanning and JSON generation
│       ├── catalog-build-html.js          # Builder of the standalone HTML dashboard
│       └── catalog.test.js                # CLI integration test
├── templates/
│   └── dashboard/
│       └── index.html                     # Dashboard template
├── skills/
│   └── catalog-sdlc/
│       └── SKILL.md                       # User skill /catalog-sdlc
└── docs/
    └── delivery-dashboard/                # Architecture artifacts and mockup
        ├── README.md                      # Directory index
        ├── plan.md                        # This document
        ├── delivery-graph.schema.json     # Copy of the schema
        ├── sample-delivery-graph.json     # Sample data
        └── mockup.html                    # Interactive HTML mockup
```

---

## 6. Verification Plan

1. **Unit tests:**
   - `node --test scripts/lib/plan-indexer/*.test.js scripts/skill/catalog.test.js` (23 tests, 4 suites, 100% pass).
   - Check extraction of tasks `T0`, `P0`, `A1`, `B0` from `trade-robot-alpha`.
   - Check extraction of tasks `X1..X6` and `05-mvp` from `lift-fixed-price`.
   - JSON schema validation via Ajv.
2. **CLI integration run:**
   - `node scripts/skill/catalog.js --workspace /home/dzmitry/projects --html delivery_dashboard.html`
3. **Manual check:**
   - Opening `delivery_dashboard.html` in a browser;
   - Checking clicks on graph nodes, the drawer and project switching.

---

## 7. Resolution of Expert Reviews (UX / PM / Architecture) and Implemented Improvements

Following a parallel audit by isolated agents, the following decisions were implemented:

### 7.1. Architectural Fixes (System Architecture)
- **Eliminating the "planHash mutation paradox":** The SHA-256 hash of the Markdown file changes when `- [x]` checkboxes are ticked. Linking runs to plans was moved to a 3-level matcher (normalized `planPath` path $\to$ hash $\to$ base name), and `planHash` is kept as an attestation stamp with a computed `driftStatus: "pristine" | "drifted"`.
- **DOM identifier safety:** Task names like `Task 0.1` are converted to a slug (`node-task-0-1`), preventing syntax errors in `querySelector` CSS selectors.
- **Robust lexer with code-block protection:** Code blocks (```` ``` ```` and `~~~`) are isolated before task parsing, which prevents false positives on `# Task ...` comments. Middot separators (`·`), list tasks `* **Task N**` and parenthetical notes are supported.
- **Pure headless model (`model.js`):** The `DeliveryGraphModel` class is fully isolated from the DOM and implements the graph algorithms (topological sort, critical path, computing tasks ready to run).

### 7.2. UX/UI Improvements (UX Design)
- **Non-modal Drawer:** The overlay was made transparent (`pointer-events: none`), which lets you interact with the graph and see the highlighted links while the task panel is open.
- **Directional arrows on SVG curves:** Markers `<marker id="arrow-upstream">` and `<marker id="arrow-downstream">` were added to clearly visualize the direction of dependencies.
- **Toast notifications instead of `alert()`:** Blocking system dialogs were replaced with smooth pop-up toasts that hide automatically.
- **Extended search:** Full-text filtering now checks not only titles but also file paths (`create`, `modify`, `delete`, `test`).

### 7.3. Delivery Management and Metrics (Product Management)
- **Critical path computation (Critical Path / CPM):** The model computes the longest chain of unfinished dependencies (`getCriticalPath`).
- **"Ready to Execute" filter:** Highlighting tasks whose upstream dependencies are all done and that have no blocking P0 TODOs.
- **"Copy Agent Prompt" action:** Quick copying of the agent launch command (`/execute-plan-sdlc --task <id>`) right from the task inspector.
- **KPI correction:** The "Delivery Velocity" metric was renamed to the accurate "Scope Completion".

