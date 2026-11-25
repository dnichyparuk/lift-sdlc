# lift-sdlc — Runtime Rules

Universal invariants for projects consuming the `lift-sdlc` plugin:

## 1. Plan Mode Routing
- When Plan mode is active, always invoke `/plan-sdlc` via the Skill tool before authoring or modifying plans.

## 2. Explicit Plan File Gate
- Always pass an explicit plan file path (`--plan <path>`) when invoking `/execute-plan-sdlc` or `/ship-sdlc`.
- Never infer or guess a plan path from conversation context.

## 3. Plan Checkbox Integrity
- Never autonomously add `- [~]` skipped checkboxes to any plan.
- Never add, remove, or alter `*Skipped on YYYY-MM-DD: <reason>*` annotations without explicit user direction.

## 4. Internal State Exclusion
- Never stage `.sdlc/` runtime execution or state artifacts in git commits.
- When staging broadly, explicitly exclude them (e.g., `git add -A -- . ':!.sdlc/'`).
