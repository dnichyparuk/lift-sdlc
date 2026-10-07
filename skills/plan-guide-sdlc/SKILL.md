---
name: plan-guide-sdlc
description: "Initialize or update plan authoring guidelines (docs/plans/PLAN_GUIDELINES.md) and link them in AGENTS.md for any project. Ensures human- and agent-authored plans follow the machine-readable schema for catalog-sdlc and the Universal Delivery Dashboard. Triggers on: plan guidelines, init plan guide, add plan guide, setup plan guide, /plan-guide-sdlc."
user-invocable: true
argument-hint: "[--project <dir>] [--force]"
---

# Plan Guide Setup (plan-guide-sdlc)

Initializes standard plan authoring guidelines (`docs/plans/PLAN_GUIDELINES.md`) and updates project instructions (`AGENTS.md`) so that agents and developers produce structured, machine-readable Markdown plans compatible with `catalog-sdlc` and the Universal Delivery Dashboard.

---

## Capabilities

1. **Creates `docs/plans/PLAN_GUIDELINES.md`**:
   - Deploys canonical copy-paste template with waves, tasks, dependencies (`Depends on:`), file perimeters (`Create/Modify/Delete/Test`), and acceptance criteria (`- [ ]`).
   - Documents rules for task ID stability and linking blockers from `docs/TODO/*.md`.

2. **Updates `AGENTS.md`**:
   - Safely injects the **Plan Authoring Standard** section with relative link to `docs/plans/PLAN_GUIDELINES.md`.
   - Idempotent: checks for existing references to avoid duplicate entries.

3. **Initializes `docs/plans/README.md`**:
   - Creates active plans catalog index if the folder was previously empty.

---

## CLI Usage

```bash
# Run for the current project
node scripts/skill/plan-guide.js

# Run for a specific project directory
node scripts/skill/plan-guide.js --project /path/to/project

# Force overwrite of existing PLAN_GUIDELINES.md
node scripts/skill/plan-guide.js --project /path/to/project --force
```

---

## Arguments

| Flag | Description | Default |
|:---|:---|:---|
| `--project <dir>` | Path to the target project directory | Current working directory |
| `--force` | Force overwrite existing `PLAN_GUIDELINES.md` | `false` |
