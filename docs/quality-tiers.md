# Quality Tiers & Workflow Configuration Guide

This guide explains how quality tiers work within Lift-SDLC, the available options for model routing, and how to configure workflows to enforce different quality presets dynamically or via configuration files.

---

## 1. What are Quality Tiers?

Lift-SDLC uses a **quality-tier model routing system** to balance execution speed, correctness, and API cost. Instead of using a single global model for every action, orchestrators dispatch sub-agents using models tailored to the complexity and risk of each task.

Tasks are categorized as:
- **Trivial / Standard Tasks**: Single-file changes, small edits (< 15 lines), or routine test writing.
- **Complex / Architectural Tasks**: Cross-cutting changes, structural changes touching multiple files, or security-critical paths.

Quality tiers allow you to control which model preset is used for these categories.

---

## 2. Available Quality Tiers

There are three predefined quality tiers available, built on the **Gemini 4** model family (*Hydrogen Hands, Neon-for-Coding, Argon Verification, Carbon Flagship*) mapped to Antigravity (`agy`) runtime enums (`inherit | flash_lite | flash | pro`):

| Tier | Name | Trivial | Standard | Complex | Use Case |
|---|---|---|---|---|---|
| **`minimal`** | Speed | `gemini-4-hydrogen-medium` (`flash`) | `gemini-4-hydrogen-medium` (`flash`) | `gemini-4-hydrogen-high` (`flash`) | Rapid prototyping, mechanical refactoring, 100% Hydrogen throughput (skips per-wave spec review). |
| **`balanced`** | Balanced *(Default)* | `gemini-4-hydrogen-medium` (`flash`) | `gemini-4-neon-low` (`pro`, or `inherit` via `execute.standardWorkerEnum`) | `gemini-4-neon-medium` (`pro`) | Everyday feature work — Hydrogen trivials, Neon-for-Coding Standard & Complex execution, Argon (`pro`) spec compliance review. |
| **`full`** | Quality | `gemini-4-hydrogen-medium` (`flash`) | `gemini-4-neon-medium` (`pro`) | `gemini-4-carbon-medium` (`pro`) | Critical code paths, production releases, architectural work requiring flagship Carbon reasoning and Argon (`pro`) spec compliance review. |

- **`wave-runner` orchestrator:** Locked to `flash` (`gemini-4-hydrogen-medium`) across all tiers.
- **High-risk override:** Tasks tagged `Risk: High` override to Neon (`pro`) regardless of complexity.
- **Failure-aware escalation (`escalateLogicalModel` in `scripts/lib/model-tiers.js`):**
  - `NEEDS_CONTEXT` keeps the current tier and injects missing context.
  - `SPEC_GAP` jumps directly to Argon (`gemini-4-argon-low` / `pro`, or `gemini-4-carbon-medium` if already Argon/Neon-high/Carbon).
  - `FAILED_TESTS` / `FAILED_BUILD` / `BLOCKED` steps along `hydrogen → neon → argon → carbon` (`agy` enums `flash_lite → flash → pro`).

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
    "quality": "balanced"
  },
  "execute": {
    "standardWorkerEnum": "pro"
  }
}
```

> [!NOTE]
> `execute.standardWorkerEnum` accepts `"pro"` (default, ensures Hydrogen sessions still route Balanced Standard tasks to Neon) or `"inherit"` (allows Neon-session users to inherit their active session model). Both `.sdlc/config.json` and `.sdlc/local.json` are validated against [schemas/sdlc-config.schema.json](../schemas/sdlc-config.schema.json) and [schemas/sdlc-local.schema.json](../schemas/sdlc-local.schema.json).

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

If you are developing Lift-SDLC or updating the model definitions, refer to the following source files:

*   **Configuration Schema**: [scripts/lib/ship-fields.js](../scripts/lib/ship-fields.js), [schemas/sdlc-config.schema.json](../schemas/sdlc-config.schema.json), and [schemas/sdlc-local.schema.json](../schemas/sdlc-local.schema.json) define the `quality` and `execute.standardWorkerEnum` fields and validations.
*   **Model Tiers & Escalation**: [scripts/lib/model-tiers.js](../scripts/lib/model-tiers.js) defines `GEMINI4_MODELS`, `toAgyModelEnum`, `escalateAgyModel`, and failure-aware `escalateLogicalModel`.
*   **Resolution and Precedence**: [scripts/skill/ship.js](../scripts/skill/ship.js) handles merging the config files with any command-line options and passes the resolved flag down.
*   **Orchestration Logic**: [skills/execute-plan-sdlc/SKILL.md](../skills/execute-plan-sdlc/SKILL.md) and [skills/execute-plan-sdlc/workflows/execute.py](../skills/execute-plan-sdlc/workflows/execute.py) define how execution reads the `--quality` flag and maps tasks to Gemini 4 profiles (`gemini-4-hydrogen-medium`, `gemini-4-neon-low`, `gemini-4-carbon-medium`) and `agy` enums (`flash`, `pro`).
*   **Architecture & Agent Relations**: For a comprehensive view of how quality tiers integrate across all agent layers, see the [SDLC Plugin Architecture Report](./architecture/sdlc-plugin-architecture-report.md) and [Model References](./model-references.md).

