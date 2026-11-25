# Plan SDLC — OpenSpec, Guardrail & Handoff Details

Reference details extracted from `skills/plan-sdlc/SKILL.md` for cold branches, OpenSpec edge cases, guardrail formatting, and handoff/recovery procedures.

## OpenSpec Integration & Edge Matrix (Step 0 & Step 1)

All OpenSpec decisions are driven by the `openspec` and `fromOpenspec` fields returned by `scripts/skill/plan.js --output-file` — never run a separate detection pass.

### Contradictory-Signal Override

After reading the prepare output, IF `openspec.authoritative.path` is set AND the current session-start `<system-reminder>` contains a line matching `/openspec.*not initialized|not initialized.*openspec/i`, print exactly one line:

```text
Ignoring contradictory 'not initialized' signal in session context — openspec/config.yaml exists (authoritative source: SDLC's own check via plan.js prepare output).
```

Then continue the flow. If the contradictory phrase is absent, emit nothing.

### Gate Check Matrix (When `openspec.present` is true and no valid `--from-openspec`)

| Condition | Action |
|---|---|
| `fromOpenspec.valid === true` | Fast path: active change is already resolved. Set `fromOpenspecDirect = true`, bypass gate check, read artifacts below, and proceed to Step 1. |
| `fromOpenspec` present, `valid === false` | Display `fromOpenspec` errors and stop. |
| `--spec` passed or user provided a path into `openspec/changes/` | Skip gate check; resolve change and read artifacts below. |
| Neither `--spec` nor `openspec/changes/` path — **non-functional** request (refactoring, config, docs, CI/CD, dependency updates, formatting, infrastructure) | Print `"OpenSpec detected — pass --spec to include spec context in planning."` Leave `openspecContext` empty and continue. |
| Neither `--spec` nor `openspec/changes/` path — **functional** request (new features, behavior/API changes, integrations, capability additions) and `openspec.branchMatch` is set | Treat `openspec.branchMatch` as resolved and read artifacts below. |
| Neither `--spec` nor `openspec/changes/` path — **functional** request and no `openspec.branchMatch` | Prompt user with `ask_question` (options below). |

**Functional-change `ask_question` prompt:**

> This looks like a functional change. This project uses OpenSpec for spec-driven development.
>
> Options:
> 1. **Start OpenSpec flow** — run `/opsx:propose` to spec this out first (recommended for non-trivial features)
> 2. **Continue planning directly** — skip spec workflow, plan from conversation context
> 3. **Use existing spec** — pass `--spec`, or re-invoke with `/plan-sdlc --from-openspec <name>` if `openspec.branchMatch` matched a change at stage `ready-for-plan`
>
> Select (1/2/3):

- On **1**: Stop `plan-sdlc`. Tell the user to run `/opsx:propose "<their description>"`. In plan mode, leave plan mode by ending the turn.
- On **2**: Skip the rest of the OpenSpec block; `openspecContext` remains empty.
- On **3**: Resolve the change per below, then read artifacts.

### Change Resolution & Artifact Reading

1. **Resolve the change** (when not already resolved):
   - If the user provided a path inside `openspec/changes/<name>/`, use `<name>`.
   - Otherwise inspect `openspec.activeChanges`: if 1 entry, use it; if multiple, prefer `openspec.branchMatch`; if still ambiguous, use `ask_question` listing `openspec.activeChanges`.
2. **Read artifacts in parallel**: `openspec/changes/<name>/proposal.md`, `design.md` (optional), all `specs/*.md`, and `tasks.md` (optional). Store as `openspecContext` for Steps 1–5. Update the plan header `**Source:**` to `openspec/changes/<name>/`.

### Step 1 OpenSpec Enrichment

When `openspecContext` is available:
- Use `proposal.md` for goal and scope understanding (what's in, what's out).
- Use delta specs (`specs/*.md`) with their ADDED/MODIFIED/REMOVED sections as authoritative requirements — each delta entry is a requirement.
- Use `design.md` for architecture constraints and technical approach decisions.
- Use `tasks.md` as a coarse decomposition reference (unless `fromOpenspecDirect` is true, in which case `tasks.md` is the primary decomposition skeleton).
- Skip the "Structured discovery" `ask_question` when the proposal and delta specs already provide scope, integration, and success criteria.

## Step 4 — Guardrail Compliance Format & Harden Offer

When `activeGuardrails` is non-empty, append a `## Guardrail Compliance` section to the plan file:

```markdown
## Guardrail Compliance

| Guardrail | Severity | Status | Rationale |
|---|---|---|---|
| no-direct-db-access | error | PASS | No tasks modify database schema files |
| prefer-composition | warning | PASS | No class hierarchies proposed |
```

**Harden escalation (Step 4 error-severity block & Step 5 max-iteration cap):**
- Only offer **harden** in interactive mode (suppress when `--auto` is set).
- **Step 4 error-severity block:** When an error-severity guardrail cannot be resolved by plan revision, offer **harden** (opt-in, no surface edited without user approval) alongside user-revision options. If selected, dispatch `Skill(harden-sdlc)` with:
  - `--failure-text "Plan blocked by error-severity guardrail <id>: <description> — <rationale>"`
  - `--skill plan-sdlc --step "Step 4 — IMPROVE" --operation "error-severity guardrail block"`
- **Step 5 max iterations (3):** If the reviewer loop has not converged after 3 iterations, offer **harden** alongside escalation options. If selected, dispatch `Skill(harden-sdlc)` with:
  - `--failure-text "Plan reviewer loop did not converge after 3 iterations. Outstanding issues: <union-of-blocking-issues-across-all-lenses>"`
  - `--skill plan-sdlc --step "Step 5 — review loop" --operation "reviewer-loop max iterations"`

## Step 7 — Context-Heaviness Advisory Details

`scripts/skill/plan-handoff-advisory.js` reads `$TMPDIR/sdlc-context-stats.json` (optional context-stats sidecar) and emits a `/compact` advisory only when transcript usage is ≥60% of the model budget; when the sidecar is absent, it degrades to a silent no-op. Pipeline state is preserved across `/compact` via the plugin's hooks, so re-invoking after compaction is safe.

## Error Recovery

| Error | Recovery |
|---|---|
| Spec/requirements not found | Ask user to provide path or paste content |
| Codebase exploration fails (too large) | Ask user to point to relevant directories |
| Plan reviewer loop exceeds 3 iterations | Surface to user for guidance (offer `/harden-sdlc`) |
| Requirements are contradictory | Flag specific contradictions, ask user to resolve |
| User approves but output path fails | Retry with a different path; offer to print plan to screen |

## Gotchas

- **Vague task descriptions produce hallucinated implementations.** Every task needs an exact file and behavior — "add JWT validation middleware at `src/middleware/auth.ts`", not "add authentication".
- **Complexity classification drift.** Classify by full description, not title — "add a config key" can be Standard if it needs a schema, migration, and downstream changes.
- **Implicit dependencies.** Tasks with no shared file can still depend on each other (barrel files, type re-exports, config registrations, route ordering) — check during Step 3 critique.
- **Over/under-decomposition.** Mostly-Trivial tasks means over-decomposed; a task touching >5 files or implementing 3+ independent behaviors is under-decomposed — split it.
- **Plan-execution format mismatch.** Every task needs Complexity, Risk, Depends on, and Verify fields — `execute-plan-sdlc` consumes these for wave building.
- **Plan file is the single source of truth.** No temp files, scratchpads, or side documents — exploration findings belong in the plan file's Requirements section.

## Learning Capture

After writing the plan, append notable observations to `.sdlc/learnings/log.md` (requirements that needed significant clarification, scope decisions, codebase patterns that shaped tasks, or over/under-decomposition corrections):

```markdown
## YYYY-MM-DD — plan-sdlc: <feature name>
<what was learned>
```
