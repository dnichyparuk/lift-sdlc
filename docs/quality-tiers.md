# Quality Tiers & Workflow Configuration Guide

This guide explains how quality tiers work within the SDLC plugin, the available options for model routing, and how to configure workflows to enforce different quality presets dynamically or via configuration files.

---

## 1. What are Quality Tiers?

The SDLC plugin uses a **quality-tier model routing system** to balance execution speed, correctness, and API cost. Instead of using a single global model for every action, orchestrators dispatch sub-agents using models tailored to the complexity and risk of each task.

Tasks are categorized as:
- **Trivial / Standard Tasks**: Single-file changes, small edits (< 15 lines), or routine test writing.
- **Complex / Architectural Tasks**: Cross-cutting changes, structural changes touching multiple files, or security-critical paths.

Quality tiers allow you to control which model preset is used for these categories.

---

## 2. Available Quality Tiers

There are three predefined quality tiers available:

| Tier | Name | Dynamic Routing Behavior | Use Case |
|---|---|---|---|
| **`minimal`** | Speed | Forces `gemini-3.5-flash` for all tasks, but dynamically allocates reasoning budgets: `-low` (Trivial), `-medium` (Standard), `-high` (Complex). | Rapid prototyping, mechanical refactoring, or low-cost runs. |
| **`balanced`** | Balanced (Default) | Matches model architecture and reasoning loop to task complexity. Trivial: `gemini-3.5-flash-medium`, Standard: `gemini-3.5-flash-high`, Complex: `gemini-3.1-pro-low`. | General day-to-day development. |
| **`full`** | Quality | Forces `gemini-3.1-pro` for non-trivial tasks (`-low` for Standard, `-high` for Complex) and routes Trivial to `gemini-3.5-flash-medium`. Runs a spec-compliance review. | Critical code paths, production deployments, or complex features requiring maximum reasoning capability. |

---

## 3. Workflow Configuration Options

You can configure quality tiers at multiple levels:

### A. Command-Line Interface (CLI) Flags
You can override the execution tier on a per-run basis by passing the `--quality` flag to the `ship-sdlc` or `execute-plan-sdlc` skills.

```bash
# Ship the current branch using maximum capability
/ship-sdlc --quality full

# Execute the local plan with speed optimization
/execute-plan-sdlc --quality minimal
```

> [!NOTE]
> Passing the `--quality` flag via the CLI explicitly overrides any configurations stored in JSON files.

### B. Project-Level Configuration (`.sdlc/config.json`)
You can define a project-wide default quality tier so that all developers on the repository share the same baseline.

Add the `quality` property under the `ship` section in your `.sdlc/config.json`:

```json
{
  "ship": {
    "quality": "full"
  }
}
```

### C. Developer/Local Configuration (`.sdlc/local.json`)
If you want to customize the quality tier for your local environment only (e.g., to use `minimal` during testing to save costs/time), you can set it in `.sdlc/local.json`. This file is git-ignored and overrides the project-wide `.sdlc/config.json`.

```json
{
  "ship": {
    "quality": "minimal"
  }
}
```

---

## 4. Interactive Configuration Wizard (`/setup-sdlc`)

The project configuration wizard fully supports configuring the quality tier. If you run the setup wizard, it will prompt you for the default execution quality tier:

```bash
/setup-sdlc
```

During the wizard setup, you will be prompted with:
```
Default execution quality tier:
  - minimal (Speed)
  - balanced (Balanced, default)
  - full (Quality)
```
Selecting an option will automatically save it to your local config file.

---

## 5. Code & Implementation References

If you are developing the SDLC plugin or updating the model definitions, refer to the following source files:

*   **Configuration Schema**: [scripts/lib/ship-fields.js](file:///home/dzmitry/.gemini/config/plugins/sdlc/scripts/lib/ship-fields.js) is the single source of truth defining the `quality` config field schema, option validations, and description text.
*   **Resolution and Precedence**: [scripts/skill/ship.js](file:///home/dzmitry/.gemini/config/plugins/sdlc/scripts/skill/ship.js#L277-L290) handles merging the config files with any command-line options and passes the resolved flag down.
*   **Orchestration Logic**: [skills/execute-plan-sdlc/SKILL.md](file:///home/dzmitry/.gemini/config/plugins/sdlc/skills/execute-plan-sdlc/SKILL.md#L247-L283) defines how the executing agent reads the `--quality` flag and dynamically maps tasks to model engines (e.g., `gemini-3.5-flash-low` vs `gemini-3.1-pro-low`).
*   **Architecture & Agent Relations**: For a comprehensive view of how quality tiers integrate across all agent layers, see the [SDLC Plugin Architecture Report](./sdlc-plugin-architecture-report.md).

