# Plan Authoring Guidelines (Руководство по оформлению планов)

> **Purpose:** Canonical standard for authoring implementation plans under `docs/plans/`. Ensures plans remain human-readable (SSOT) while enabling automatic parsing by `catalog-sdlc`, DAG dependency visualization, critical path computation (CPM), and execution tracking in the Universal Delivery Dashboard.

---

## 1. Quick Minimal Template (Copy-Paste)

Save as `docs/plans/<topic>_plan.md` (or `docs/plans/YYYY-MM-DD-<slug>.md`):

```markdown
# [Feature Name] Implementation Plan

**Goal:** [Concise 1-2 sentence statement of what this plan delivers and why]
**Architecture:** [Key architectural components, layers, or patterns affected]
**Verification:** [Single command or test suite verifying the change, e.g. npm test or pytest]

---

### Wave 1: [Wave Title, e.g. Foundation & Contracts]

### Task 1: [Task Title]
- **Complexity:** Standard          # Trivial | Standard | Complex
- **Risk:** Low                     # Low | Medium | High
- **Depends on:** none              # none or comma-separated Task IDs
- **Files:**
  - Create: src/domain/feature.ts
  - Test: tests/unit/feature.test.ts
- **Acceptance criteria:**
  - [ ] Domain contracts and models defined
  - [ ] Unit tests pass with 100% coverage

---

### Wave 2: [Wave Title, e.g. Integration & Services]

### Task 2: [Dependent Task Title]
- **Complexity:** Complex
- **Risk:** Medium
- **Depends on:** Task 1            # Creates an edge in the DAG dependency graph
- **Files:**
  - Modify: src/services/manager.ts
  - Test: tests/integration/manager.test.ts
- **Acceptance criteria:**
  - [ ] Service integrates with Task 1 models
  - [ ] All integration test suites pass
```

---

## 2. Mandatory Rules for Agents & Developers

### 2.1. Task Identification
* Use explicit H3 or H4 headers: `### Task <ID>: <Title>` (e.g. `### Task 1: Initialize Database`).
* Alternative recognized styles:
  - Wave tasks: `#### Task W1-T01: <Title>`
  - Review fixes: `### X1 — <Title>`
  - Bulleted tasks: `* **Task 0.1: <Title>**`
* Task IDs must remain stable across edits — dependencies and blockers reference this ID.

### 2.2. Dependencies (`Depends on:`)
* Declare explicit preceding tasks: `- **Depends on:** Task 1, Task 2`.
* If a task has no dependencies and can be picked up immediately, write: `- **Depends on:** none`.
* **Dashboard Impact:** This field powers the Directed Acyclic Graph (DAG), Critical Path Method (CPM) calculation, and the **"Ready to Execute"** actionable filter.

### 2.3. Acceptance Criteria Checklists
* Define criteria as standard Markdown checkboxes: `- [ ] <Criterion>`. Any list marker (`-`, `*`, `+`, `1.`) and nesting level works; boxes inside fenced code blocks are ignored.
* As work progresses, mark items completed: `- [x] <Criterion>`.
* A criterion deliberately not done can be marked **skipped**: `- [~] <Criterion>`. Rules:
  - **Who ticks:** a person, or an agent at a person's request. Planning and execution agents never set `- [~]` on their own; new criteria always start as `- [ ]`.
  - **Required comment:** an italic line right below the box, indented deeper than the list marker, with no blank line in between: `*Skipped on YYYY-MM-DD: <reason>*`. The date must be a real calendar date and the reason at least 15 characters once Markdown markup is stripped. A comment on the box line itself does not count.
  - **Counting:** a skipped box is **closed**, like `- [x]`. A task whose boxes are all `[x]` or `[~]` counts as done.
  - **Validation:** the plan validator (`validate-plan-format.js`) fails a `- [~]` without a valid comment (PF6). Before execution, PF5 still needs at least one open `- [ ]` per task: `[x]` and `[~]` are closed, so a finished task fails PF5 by design.
  - Do not use `- [~]` for work that is still meant to be done; that box stays `- [ ]`.
  ```markdown
  - [~] Load test passes on the staging cluster.
    *Skipped on 2026-10-06: staging is retired; the production canary in Task 4 covers it.*
  ```
* **Dashboard Impact:** Scope completion percentages and wave progress bars update automatically based on closed items (`[x]` and `[~]`). The dashboard shows a skipped criterion as **skipped** with its date and reason, and flags a missing or invalid skip comment.

### 2.4. File Operations Perimeter (`Files:`)
* Group file paths by operation:
  ```markdown
  - **Files:**
    - Create: path/to/new_file.ts
    - Modify: path/to/existing_file.ts
    - Delete: path/to/obsolete_file.ts
    - Test: path/to/test_file.test.ts
  ```
* **Dashboard Impact:** Enables full-text search across touched files in the Task Matrix and Drawer.

### 2.5. Blocker Linking with `docs/TODO/`
* If a task is blocked by an external requirement, bug, or deferred decision, create a note under `docs/TODO/NNN-*.md` and link it:
  ```markdown
  | Blocks | Task 2 |
  | Related | feature_plan |
  ```
  or frontmatter line: `**Blocks:** Task 2`.
* **Dashboard Impact:** The blocked task is automatically highlighted with a **Blocked** badge and bi-directionally linked to the TODO item.
