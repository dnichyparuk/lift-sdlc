---
name: plan-sdlc
description: "Use when writing an implementation plan from requirements, a spec, a design doc, or a user description. ALWAYS use when plan mode is active — this is the designated plan-mode skill. Analyzes scope, maps file structure, decomposes into classified tasks with dependencies, and produces a plan ready for execute-plan-sdlc. Triggers on: write plan, create plan, plan this, break this into tasks, implementation plan, plan mode."
user-invocable: true
argument-hint: "[--spec] [--from-openspec <change-name>] [spec-file-path]"
---

# Plan (SDLC)

Write an implementation plan from requirements, a spec, or a user description in the format consumed by `execute-plan-sdlc` (with per-task complexity/risk/dependency metadata embedded).

**Announce at start:** "I'm using plan-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder (omit parenthetical if absent).

## Context Optimization Constraints

1. **Targeted File Reads:** Use `node "<PLUGIN_ROOT>/scripts/util/outline-file.js" <file>` instead of reading massive files in full.
2. **Enforced Parallelism:** Issue independent read/search/outline calls and multi-target `invoke_subagent` dispatches together in a single message — never sequentially.
3. **Strict Thought Protocol:** Keep internal reasoning in `thought` blocks and execute the next logical step immediately.

## Step 0: Mode Detection, Routing, and Setup

**Mode detection:** If a system-reminder contains `"Plan mode is active"`, extract the designated plan file path from `"You should create your plan at <path>"` — that path is the only writable file.

**Gather requirements:** If no spec or requirements document is in context, use `ask_question`:
> What do you want to implement? (describe in free form, bullet points, or provide a file path)

**Complexity routing:**

| Scope Signal | Normal Mode | Plan Mode |
|---|---|---|
| 1 file, clear change | Stop — no plan needed. Tell the user. | Lightweight plan |
| 2–3 files, clear scope | Lightweight: skip exploration and review loop | Lightweight |
| 4+ files or unclear scope | Full pipeline (Steps 1–7) | Full pipeline |
| Multiple independent subsystems | Decompose into separate plans | Decompose |

**Session recovery (full pipeline):** If the designated plan file already has content, overwrite in-place and start fresh (no prompt).

**Initialize plan file:** Write the skeleton header immediately:

```markdown
# [Feature Name] Implementation Plan

**Goal:** [TBD]
**Architecture:** [TBD]
**Source:** [Spec file path or "conversation context"]
**Verification:** [TBD]

---
```

**Context detection and guardrail loading (`skill/plan.js`):**

> **VERBATIM** — Run this command exactly as written, invoking `node` directly on the absolute `<PLUGIN_ROOT>/scripts/<group>/<script-name>.js` path (`group` ∈ `skill|util|lib|state|ci`).

```shell
PREPARE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/plan.js" --output-file)
EXIT_CODE=$?
echo "PREPARE_OUTPUT_FILE: $PREPARE_OUTPUT_FILE"
echo "EXIT_CODE: $EXIT_CODE"
```
> **Contract:** No input (append `--from-openspec <name>` if passed). Prints the temp JSON manifest path to stdout.

If `EXIT_CODE` is non-zero, print errors from the JSON output and stop. Otherwise read the manifest, print the context detection summary (`OpenSpec`, `Branch match`, `--from-openspec`, `Guardrails`), store `guardrails` as `activeGuardrails`, and delete the temp manifest (`rm -f "$PREPARE_OUTPUT_FILE"`).

**OpenSpec integration (opt-in):** Driven solely by `openspec` / `fromOpenspec` from `plan.js` above. If `openspec.present` is false, skip. If `fromOpenspec.valid` is true, set `fromOpenspecDirect = true`, read `openspec/changes/<name>/{proposal.md,design.md,specs/*.md,tasks.md}` in parallel into `openspecContext`, update `**Source:**`, and proceed to Step 1. For contradictory-signal override, functional vs non-functional gate check, and multi-change resolution rules, read `./resources/openspec-and-handoff-details.md`.

**Path resolution:** In plan mode, use the designated plan file path. In normal mode, resolve in order: (1) user-specified path, (2) project `.gemini/antigravity-cli/settings.json` `plansDirectory`, (3) global `~/.gemini/antigravity-cli/settings.json` `plansDirectory`, (4) `~/.gemini/plans/`. Naming: `YYYY-MM-DD-<feature-name>.md`.

**`planFile` marker (enforced by `hooks/stop-plan-integrity.js`):** Run in both modes (each `--mark` command spells out `<PLUGIN_ROOT>` because shell variables do not persist across invocations; swallow errors so markers never block):

```shell
node "<PLUGIN_ROOT>/scripts/skill/plan.js" --mark plan-file --path "<resolved-plan-path>" 2>/dev/null || true
```

## Step 1 (CONSUME): Requirements Discovery and Exploration

**`fromOpenspecDirect` enrichment:** When true, use `tasks.md` as the primary decomposition skeleton, skip "Structured discovery", and treat delta specs as authoritative requirements. (See `./resources/openspec-and-handoff-details.md` for general `openspecContext` enrichment.)

**Cleanup trap (install unconditionally with null guard before branching):**

```bash
MANIFEST_FILE="<explorePack.manifestPath>"
if [ -n "$MANIFEST_FILE" ]; then
  trap 'rm -rf "$(dirname "$MANIFEST_FILE")"' EXIT INT TERM
fi
```

- **Full pipeline** (`explorePack.manifestPath` non-null AND 4+ files / unclear scope):
  1. Dispatch `plan-explore-orchestrator` once via `invoke_subagent` with `Model: "flash"` and inputs: `MANIFEST_FILE`, `PROJECT_ROOT` (`<cwd>`), `USER_PROMPT` (verbatim — authoritative), `OPENSPEC_CONTEXT` (space-separated paths or `"none"`).
  2. Read the returned `Brief file:` absolute path.
  3. **Brief validation:** Grep the brief for `F-[A-Z0-9_-]+-[0-9]+`. If zero matches, fall back to the **Error fallback** path below (prevents G15 failure).
  4. **Brief consumption:** Step 2 tasks MUST cite at least one `F-<DIM>-<n>` ID or be explicitly marked `"out-of-scope addition"` with rationale; Key Decisions MUST explicitly ADOPT / REJECT-with-rationale / mark NOT-APPLICABLE any `## Best-Practice Synthesis` findings.
- **Lightweight scope** (`explorePack.scopeHintCount` ≤ 3 OR `explorePack.manifestPath` is null): skip orchestrator; use inline exploration.
- **Error fallback** (`explorePack.error` non-null, orchestrator non-zero, or zero `F-<DIM>-<n>` matches): append `## <YYYY-MM-DD> — plan-sdlc orchestrator skipped: <reason>` to `.sdlc/learnings/log.md` and fall back to inline exploration.

**Structured discovery:** When requirements are vague (and not already answered by OpenSpec), use `ask_question` with 2–3 targeted questions (Scope, Integration, Success) and wait for answers.

**Inline codebase exploration (skip for lightweight):** Issue parallel read-only calls (`find_by_name`, `grep_search`, `outline-file.js`, `view_file`) to map affected files, interfaces, test patterns, build/lint/test commands, and conventions.

## Step 2 (PLAN): Orchestrate Plan Generation

**Scope check:** If requirements span independent subsystems with no shared state, use `ask_question` to confirm splitting vs one plan.

**Orchestrator dispatch:** Dispatch `plan-generation-orchestrator` once via `invoke_subagent` with `Model: "pro"` and inputs:
```text
USER_PROMPT: <verbatim user request>
PLAN_FILE_PATH: <absolute path to plan file>
BRIEF_FILE: <absolute path to discovery-brief.md, or "none">
OPENSPEC_CONTEXT: <space-separated path list, or "none">
PROJECT_ROOT: <cwd>
FROM_OPENSPEC_DIRECT: <"true" or "false">
```

Mandate an **Architectural Boundary Contract** for every generated task: target directory & layer classification, permitted imports, prohibited imports, and verification command. Wait for completion before Step 3.

## Step 3 (CRITIQUE): Deterministic Static Gate + Semantic Lane Fan-Out

**Re-anchor:** Re-read the plan file before running critique. The file — not memory — is the source of truth. Do NOT edit the plan file in Step 3.

All 17 quality gates (`G1`–`G17`) are evaluated by combining one deterministic Node check (`{G3, G4, G10, G12}`, 0 LLM calls) with up to 4 semantic LLM lanes from `lanes[]` (`static-structural`, `content-coverage`, `guardrail-compliance`, `dimension-coverage`; there is NO `file-existence` LLM lane).

**3a. Deterministic static critique (`{G3, G4, G10, G12}` — 0 LLM calls):**

> **VERBATIM** — Run deterministically before or alongside the semantic lane fan-out:

```shell
node "<PLUGIN_ROOT>/scripts/skill/plan.js" --critique-static --plan "<PLAN_FILE_PATH>"
```
> **Contract:** Evaluates `G3` (DAG cycles), `G4` (unsequenced shared `Modify:` files), `G10` (`Modify:` file existence on disk or in earlier `Create:`), and `G12` (missing `Depends on:` targets). Emits JSON `{ "gateIds": ["G3","G4","G10","G12"], "issues": [...], "passes": [...], "laneStatus": "ok"|"failed" }`.

**3b. Semantic lane fan-out (`lanes[]`):** Dispatch all lanes in `lanes[]` together in parallel via `invoke_subagent`. Source `TypeName`, `Model`, and `promptTemplatePath` verbatim from each `lane` in `lanes[]` (do NOT hardcode or assume array indices — select by `lane.name`, since `guardrail-compliance` and `dimension-coverage` are conditional):
- `static-structural` (`{G1, G2, G7}`, plus `G14` if no guardrails / `G17` if no dimensions)
- `content-coverage` (`{G5, G6, G8, G9, G11, G13, G15, G16}`)
- `guardrail-compliance` (`{G14}`, when `guardrails[]` is non-empty)
- `dimension-coverage` (`{G17}`, when review dimensions exist)

For each `lane` in `lanes[]`:
- `TypeName`: `lane.subagentType`
- `Role`: `lane.name + " gate evaluator"`
- `Model`: `lane.agyModel` (or map `lane.model`: `neon`/`argon`/`carbon`/`pro` → `"pro"`; `hydrogen-low`/`flash-low`/`flash_lite` → `"flash_lite"`; `hydrogen`/`flash` → `"flash"`; else `"inherit"`)
- `Workspace`: `"inherit"` (**no worktree/branch isolation** — forbidden per #370/#372)
- `Prompt`: Read `lane.promptTemplatePath` and substitute:
  - All lanes: `{PLAN_FILE_PATH}`, `{PROJECT_ROOT}`
  - Non-G17 lanes (`lane.name !== "dimension-coverage"`): `{REQUIREMENTS_SUMMARY}` (numbered Step 1 list), `{ACTIVE_GUARDRAILS}` (`guardrails[]`), `{OPENSPEC_TASKS}` (`openspecContext.tasks` or null), `{BRIEF_FINDING_IDS}` (or null)
  - `dimension-coverage` (`G17`): `{DIMENSIONS_DIR}` (`.sdlc/review-dimensions/`), `{COPILOT_DIR}` (`.github/instructions/`), `{GITHUB_HOSTING_DETECTED}` (`githubHosting.detected`), `{LEARNINGS_LOG_PATH}` (`.sdlc/learnings/log.md`), `{PR_COMMIT_WINDOW}` (`"last 14 days"` fallback)

**Null `promptTemplatePath`:** Skip dispatch and add synthetic blocking issue `{ laneStatus: "failed", gateIds: lane.gateIds, issues: [{ gateId: lane.gateIds[0], severity: "error", message: "Lane <name> skipped — promptTemplatePath null", blocking: true }], passes: [] }`. **Exception:** `dimension-coverage` (`G17`) is advisory — treat as empty findings and log to `.sdlc/learnings/log.md`.

**3c. Collect and merge across `{G1..G17}`:**
Combine the `--critique-static` JSON (`{G3, G4, G10, G12}`) with every semantic lane's JSON (`{ gateIds, issues, passes, laneStatus }`), matching by `lane.name` / gate ID:
- Capture `guardrailCompliancePayload` from `guardrail-compliance` (when present) and `g17Findings` from `dimension-coverage` (when present) for Step 4.
- `allIssues` = union of `issues[]` from `--critique-static` and all dispatched lanes, deduped by `(gateId, taskRef, message-normalized-prefix)`.
- `allPasses` = union of `passes[]`.
- `coverageCheck`: union of all `gateIds[]` MUST equal `{G1..G17}` exactly; any missing gate ID adds a blocking error `{ gateId: "<missing>", severity: "error", message: "Gate <missing> not evaluated by any lane", blocking: true }`.
- Any source with `laneStatus !== "ok"` appends a blocking `lane-failure` error — **exception:** `dimension-coverage` (`G17`) failure is advisory.

**JOIN barrier — `guardrailsEvaluated`:** Only after the lane covering `G14` (`guardrail-compliance`, or `static-structural` when `guardrails[]` is empty) returns and is merged:

```shell
node "<PLUGIN_ROOT>/scripts/skill/plan.js" --mark guardrailsEvaluated 2>/dev/null || true
```

**JOIN barrier — `critiqueRan`:** Only after `--critique-static` AND ALL dispatched lanes in `lanes[]` have returned and merged:

```shell
node "<PLUGIN_ROOT>/scripts/skill/plan.js" --mark critiqueRan 2>/dev/null || true
```

## Step 4 (IMPROVE): Revise Plan

Fix all issues from Step 3 by editing the plan file in-place (do not append duplicates).
- **G16 failure resolution:** Resolve uncovered OpenSpec tasks by either adding a plan task with the missing `openspec-task` `ref`, or listing the title under `## Out-of-scope OpenSpec tasks` with a one-line rationale.
- **Guardrail Compliance:** If `activeGuardrails` is non-empty, append `## Guardrail Compliance` (see `./resources/openspec-and-handoff-details.md` for table format). Resolve all `error`-severity failures before continuing; if unresolvable, offer **harden** (`/harden-sdlc`, interactive mode only) alongside user-revision options.
- **Suggested Review Dimensions (`G17`):** When `g17Findings.findings` is non-empty, splice `g17Findings.rendering` verbatim immediately after `## Guardrail Compliance` (or after the last `### Task N:` block). Empty/fallback is a no-op.

Step 4 is autonomous (single user touchpoint is Step 7) — proceed directly to Step 5 unless blocked by an unresolvable `error`-severity guardrail.

## Step 5 (CRITIQUE): Plan Review Loop — Multi-Lens Fan-Out

Skip for lightweight plans (2–3 file scope).

**For plans with ≥5 tasks — Multi-lens fan-out:** Dispatch all entries in `lensReviewers[]` (`i = 0..2`) together in parallel via `invoke_subagent`:
- `TypeName`: `lensReviewers[i].subagentType`
- `Role`: `"Plan Reviewer - " + lensReviewers[i].lens`
- `Model`: Cross-Family Pro Diversity — `architecture` → `gemini-4-neon-medium`, `requirements` → `gemini-4-argon-low`, `risk` → `gemini-4-argon-low` (all mapped to `Model: "pro"`). Do NOT downgrade Pro lenses to `flash`.
- `Workspace`: `"inherit"` (**no `"branch"` or worktree isolation** — forbidden per #370/#372)
- `Prompt`: Read `lensReviewers[i].promptTemplatePath` and substitute `{PLAN_FILE_PATH}`, `{LENS}`, `{LENS_FOCUS}` (bullet list), `{REQUIREMENTS_CHECKLIST}`, `{SOURCE_REQUIREMENTS}`, `{BRIEF_FILE}` (or `"none — orchestrator skipped"`), `{OPENSPEC_TASKS}` (or `"none — plan not from OpenSpec"`), `{GUARDRAILS}` (or `"none configured"`). If `promptTemplatePath` is null, skip that lens, log to `.sdlc/learnings/log.md`, and continue.

**Merge per iteration:** `status = "Approved"` iff every lens returns `"Approved"`; union and dedup `issues[]` by `(taskRef, message-normalized-prefix)` and `recommendations[]` by first 60 chars; increment iteration counter by 1 per fan-out.

**For plans with <5 tasks — Single reviewer:** Dispatch one reviewer with `{LENS}=all` using `./resources/plan-reviewer-prompt.md`.

**Review loop:**
- Approved → proceed to Step 6.5 (Step 6 is a no-op).
- Issues found → go to Step 6.
- Max 3 iterations → use `ask_question` to surface unresolved issues and offer **harden** (`/harden-sdlc`, interactive only — see `./resources/openspec-and-handoff-details.md`).

## Step 6 (IMPROVE): Apply Review Fixes

Fix every blocking issue identified by the reviewer(s), rewrite the plan file in-place, and loop back to Step 5 (cap at 3 iterations).

## Step 6.5 (LINK VERIFICATION): Validate URLs — HARD GATE

Validate every URL in the finalized plan via stdin or `--file` (auto-derives repo/Jira context — do NOT construct ctx JSON):

```shell
node "<PLUGIN_ROOT>/scripts/util/plan-validate-links.js" --file "<resolved-plan-path>"
```
> **Contract:** Prints violations to stderr and exits non-zero on broken links (`SDLC_LINKS_OFFLINE=1` skips network reachability in sandboxed CI).

On non-zero exit: do NOT proceed to Step 7; surface violations verbatim and stop (do not retry, auto-edit URLs, or bypass).

## Step 6.6 (FORMAT VALIDATION): Validate Plan Structure — HARD GATE

```shell
node "<PLUGIN_ROOT>/scripts/ci/validate-plan-format.js" --file "<resolved-plan-path>" --markdown
```
> **Contract:** Prints PF1–PF5 (plus PF6 if `- [~]` present). Exit 0 = pass, 1 = format issues, 2 = script error.

On non-zero exit: do NOT proceed to Step 7; surface the violation report verbatim and stop (do not retry, auto-edit, or bypass).

## Step 7: Handoff

**Context-heaviness advisory:** Run the advisory script first; if it prints text, prepend it verbatim above the handoff menu (silent no-op otherwise; see `./resources/openspec-and-handoff-details.md`):

```shell
node "<PLUGIN_ROOT>/scripts/skill/plan-handoff-advisory.js"
```

**Plan mode:** Announce the plan path and propose execution (end the turn to leave plan mode; do NOT invoke `execute-plan-sdlc` or `ship-sdlc` in this turn):

> Plan written to `<path>`. On approval:
>   ship    — run the full pipeline: execute → commit → review → version → PR (/ship-sdlc --plan <path>)
>   execute — execute the plan only (/execute-plan-sdlc <path>)

**Normal mode:** Announce the plan path and present the continuation menu:

```text
What would you like to do next?
  ship     — execute, commit, review, version, and PR (/ship-sdlc --plan <path>)
  execute  — execute the plan only (/execute-plan-sdlc <path>)
  done     — stop here

Select:
```

On selection, invoke the chosen skill with `<path>` explicitly (`execute-plan-sdlc` and `ship-sdlc` never read the plan from conversation context), or recommend the corresponding slash command with `<path>`. On `done`, stop.

## DO NOT

- Write implementation code in the plan (pattern snippets are fine; full implementations are not)
- Mandate TDD for every task — match verification to task type
- Create plans with fewer than 2 tasks (just do the work directly)
- Use absolute file paths that only work on one machine
- Put plans in `$TMPDIR` — plans must survive session boundaries
- Put plans in plugin-branded directories (no `docs/superpowers/plans/`)
- Ignore plan mode's designated file path when plan mode is active — always write to it
- Skip the plan review loop (Step 5) unless lightweight routing applies

## See Also

- `./resources/openspec-and-handoff-details.md` — OpenSpec edge matrix, guardrail compliance format, harden escalation, error recovery, gotchas, learning capture
- `./resources/plan-reviewer-prompt.md` — plan review subagent template
- `./resources/plan-format-reference.md` — plan document format specification
- [`/execute-plan-sdlc`](../execute-plan-sdlc/SKILL.md) — skill that executes the plans this skill produces
