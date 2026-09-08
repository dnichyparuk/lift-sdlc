---
name: plan-sdlc
description: "Use when writing an implementation plan from requirements, a spec, a design doc, or a user description. ALWAYS use when plan mode is active — this is the designated plan-mode skill. Analyzes scope, maps file structure, decomposes into classified tasks with dependencies, and produces a plan ready for execute-plan-sdlc. Triggers on: write plan, create plan, plan this, break this into tasks, implementation plan, plan mode."
user-invocable: true
argument-hint: "[--spec] [--from-openspec <change-name>] [spec-file-path]"
model: gemini-3.8-flash-medium
---

# Plan (SDLC)

Write an implementation plan from requirements, a spec, or a user description. Produces a plan in the format consumed by execute-plan-sdlc — with per-task complexity/risk/dependency metadata embedded.

**Announce at start:** "I'm using plan-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

## Context Optimization Constraints

To prevent context bloat and token exhaustion:
1. **Targeted File Reads:** Avoid reading entire large codebase files directly into memory. When exploring the codebase, use `node "<PLUGIN_ROOT>/scripts/util/outline-file.js" <file>` to extract file structure (classes, interfaces, functions) instead of using the `view_file` tool on massive files.
2. **Enforced Parallelism (applies everywhere below):** Any set of independent Glob/Grep/Read/Outline calls, and any multi-target Agent dispatch (orchestrator fan-out, review lanes, lens reviewers, inline exploration), MUST be issued together in a single message as parallel tool calls — never sequentially. Per-step notes below flag *where* this applies; they don't restate the rule.
3. **Strict Thought Protocol:** Do not return an empty chat response just to explain intermediate thoughts. All internal reasoning must remain in the `thought` block. You must execute the next logical step immediately.

## Step 0: Mode Detection, Routing, and Setup

**Mode detection:** Check whether a system-reminder contains "Plan mode is active". If yes, extract the designated plan file path from "You should create your plan at `<path>`". That path is the only writable file.

**Gather requirements:** If no spec or requirements document is in context, use AskUserQuestion:
> What do you want to implement? (describe in free form, bullet points, or provide a file path)

**Complexity routing:**

| Scope Signal | Normal Mode | Plan Mode |
|---|---|---|
| 1 file, clear change | Stop — no plan needed. Tell the user. | Lightweight plan (user explicitly chose to plan) |
| 2–3 files, clear scope | Lightweight: skip exploration and review loop | Lightweight |
| 4+ files or unclear scope | Full pipeline (Steps 1–7) | Full pipeline |
| Multiple independent subsystems | Decompose into separate plans | Decompose |

**TodoWrite setup (full pipeline only):** Create TodoWrite items for Steps 1–7. Skip TodoWrite for lightweight plans.

**Session recovery (full pipeline only):** When the designated plan file already has content, restart and overwrite — do NOT prompt (single-touchpoint default for Step 0). Clear the file in-place and begin fresh. If the user wants to preserve the prior draft, they can `cp` the file before invoking the skill.

**Initialize plan file:** Write the skeleton header immediately:

```markdown
# [Feature Name] Implementation Plan

**Goal:** [TBD]
**Architecture:** [TBD]
**Source:** [Spec file path or "conversation context"]
**Verification:** [TBD]

---
```

**Context detection and guardrail loading (skill/plan.js):**

> **VERBATIM** — Run this command exactly as written, invoking the script with `node` and its absolute path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin. Note the strict script location pattern: `<PLUGIN_ROOT>/scripts/<group>/<script-name>.js`, where `<group>` is one of `skill`, `util`, `lib`, `state`, or `ci`). There is no shell wrapper — always call `node` on the `.js` file directly.

```shell
PREPARE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/plan.js" --output-file)
EXIT_CODE=$?
echo "PREPARE_OUTPUT_FILE: $PREPARE_OUTPUT_FILE"
echo "EXIT_CODE: $EXIT_CODE"
```
> **Contract (Input/Output):**
> - **Input**: None.
> - **Output**: Prints the path of a temp JSON manifest (via `writeOutput`) describing current branch state. `--output-file` makes stdout the manifest path; capture it into `PREPARE_OUTPUT_FILE`.

If `--from-openspec <name>` was passed to plan-sdlc, append it to the same command: `PREPARE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/plan.js" --output-file --from-openspec <name>)`.

If `EXIT_CODE` is non-zero, print the errors from the JSON output and stop. If `EXIT_CODE` is 0, read the JSON output file. Print context detection summary:
```
Context detection (from skill/plan.js):
  OpenSpec:          [detected, N active changes | not present]
  Branch match:      [yes (<name>) | no]
  --from-openspec:   [valid, N delta specs, tasks.md present | not passed | invalid: <error>]
  Guardrails:        N loaded (N error, N warning)
```

Extract `guardrails` from the output → store as `activeGuardrails`. If the array is non-empty, print: "Loaded N plan guardrails." If empty: "No plan guardrails configured."

Once the manifest has been read, delete it: `rm -f "$PREPARE_OUTPUT_FILE"`.

**Contradictory-signal override:** After reading the prepare output, IF `openspec.authoritative.path` is set AND the current session-start `<system-reminder>` contains a line matching `/openspec.*not initialized|not initialized.*openspec/i`, print exactly one line:
`Ignoring contradictory 'not initialized' signal in session context — openspec/config.yaml exists (authoritative source: SDLC's own check via plan.js prepare output).`
Then continue the flow. If the contradictory phrase is absent, emit nothing.

**OpenSpec integration (opt-in — requires `--spec` flag or explicit spec path):** Fully driven by the `openspec` / `fromOpenspec` fields already returned by `skill/plan.js` above — no separate detection pass.

If `openspec.present` is false, skip this entire block — no OpenSpec in this project.

- **`--from-openspec` fast path:** If `fromOpenspec.valid` is true, the active change is already resolved — go straight to "Read artifacts" below, set `fromOpenspecDirect = true`, and bypass the gate check entirely (skip to Step 1 once artifacts are read). If `fromOpenspec` is present but `valid` is false with errors, display them and stop.
- **Gate check** (only when no valid `--from-openspec`): If neither `--spec` was passed nor the user provided a path into `openspec/changes/`:
  a. **Classify the request:** functional (new features, behavior/API changes, integrations, capability additions) vs non-functional (refactoring, config, docs, CI/CD, dependency updates, formatting, infrastructure).
  b. **Non-functional:** Print "OpenSpec detected — pass `--spec` to include spec context in planning." Skip the rest of this block; `openspecContext` remains empty.
  c. **Functional:** If `openspec.branchMatch` is set, treat that change as resolved and go to "Read artifacts". Otherwise use AskUserQuestion:
     > This looks like a functional change. This project uses OpenSpec for spec-driven development.
     >
     > Options:
     > 1. **Start OpenSpec flow** — run `/opsx:propose` to spec this out first (recommended for non-trivial features)
     > 2. **Continue planning directly** — skip spec workflow, plan from conversation context
     > 3. **Use existing spec** — pass `--spec`, or re-invoke with `/plan-sdlc --from-openspec <name>` if `openspec.branchMatch` matched a change at stage `ready-for-plan`
     >
     > Select (1/2/3):
     - On **1**: Stop plan-sdlc. Tell the user to run `/opsx:propose "<their description>"`. In plan mode, call ExitPlanMode first.
     - On **2**: Skip the rest of the OpenSpec block. `openspecContext` remains empty. Continue with standard planning.
     - On **3**: Resolve the change per the next bullet, then go to "Read artifacts".
- **Resolve the change** (when not already resolved above): If the user provided a spec file path into `openspec/changes/<name>/`, use `<name>`. Otherwise use `openspec.activeChanges` from the prepare output: if exactly one entry, use it; if multiple, prefer `openspec.branchMatch`; if still ambiguous, use AskUserQuestion listing the change names from `openspec.activeChanges`.
- **Read artifacts:** Once the active change is identified, Read in parallel `openspec/changes/<name>/proposal.md`, `design.md` (optional), all `specs/*.md`, and `tasks.md` (optional). Store as `openspecContext` for use in Steps 1–5. Update the plan file header `**Source:**` to `openspec/changes/<name>/`.

**Normal mode path resolution:** Resolve the output path before writing:
1. User-specified path (if provided in conversation)
2. Project `.gemini/antigravity-cli/settings.json` → `plansDirectory` (relative paths resolve from workspace root)
3. Global `~/.gemini/antigravity-cli/settings.json` → `plansDirectory`
4. Default fallback: `~/.gemini/plans/`

Naming convention: `YYYY-MM-DD-<feature-name>.md`. Create the directory if needed.

**Plan mode:** Write to the designated plan file path. Skip path resolution.

**planFile marker (intended to be consumed by a `hooks/stop-plan-integrity.js` Stop hook):** After path resolution, record the resolved plan path in the plan integrity state. Run in both plan-mode and normal-mode branches. Marker writes are best-effort — swallow any error (`2>/dev/null || true`) so a failed marker never blocks plan creation. **`hooks/stop-plan-integrity.js` does not exist in this repo and is not registered in `hooks.json`** — the marker file is currently written but never read back; no Stop hook verifies plan integrity today. See `resources/state-format.md` for the designed (not-yet-built) contract.

Each `--mark` block below spells out the full `<PLUGIN_ROOT>` path — SKILL.md bash blocks run as separate Bash tool invocations, so shell variables do NOT persist between them. Marker failures are silent (`2>/dev/null || true`), so a hoisted variable would drop `guardrailsEvaluated`/`critiqueRan` without any error.

```shell
node "<PLUGIN_ROOT>/scripts/skill/plan.js" --mark plan-file --path "<resolved-plan-path>" 2>/dev/null || true
```
> **Contract (Input/Output):**
> - **Input**: Plan file path.
> - **Output**: Tags plan file for execution.

Replace `<resolved-plan-path>` with the actual absolute path: in plan mode it is the designated plan file path extracted at the top of Step 0; in normal mode it is the path resolved above (from `plansDirectory` or the default fallback).

## Step 1 (CONSUME): Requirements Discovery and Exploration

**`fromOpenspecDirect` enrichment:** When `fromOpenspecDirect` is true (set by `--from-openspec` handling in Step 0):
- Use `tasks.md` as the PRIMARY decomposition skeleton — OpenSpec tasks were deliberately authored
- Skip the "Structured discovery" AskUserQuestion below — the proposal and delta specs already provide scope, integration, and success criteria
- Delta specs remain the authoritative requirements for Step 3 coverage validation

**Orchestrator dispatch (full pipeline only):**

After the `fromOpenspecDirect` enrichment block, determine which exploration path to take.

**Cleanup trap (install unconditionally before branching, with null guard):** The prepare script always creates a per-invocation tempdir on success — including for lightweight scopes — so cleanup MUST run regardless of which exploration path is taken. The null guard prevents `rm -rf "$(dirname "")"` (which resolves to `rm -rf .`) when `manifestPath` is null.

```bash
MANIFEST_FILE="<explorePack.manifestPath>"
if [ -n "$MANIFEST_FILE" ]; then
  trap 'rm -rf "$(dirname "$MANIFEST_FILE")"' EXIT INT TERM
fi
```

- **Full pipeline** (`explorePack.manifestPath` is non-null AND scope is 4+ files / unclear scope):

  1. Spawn `sdlc:plan-explore-orchestrator` Agent exactly once with inputs:
     ```
     MANIFEST_FILE: <explorePack.manifestPath>
     PROJECT_ROOT: <cwd>
     USER_PROMPT: <verbatim user request>
     OPENSPEC_CONTEXT: <space-separated path list, or "none">
     ```
     `USER_PROMPT` is authoritative — the orchestrator re-derives web-research dimensions
     independently from the manifest's `webResearchSignal` (which is a best-effort hint;
     plan.js may not have stdin when invoked from a TTY).
  2. Read the orchestrator's returned `Brief file:` absolute path. Use `Read` to load the brief into context. The brief is the source of truth for Step 2 task provenance.
  3. **Brief validation:** After loading the brief, grep its content for the pattern `F-[A-Z0-9_-]+-[0-9]+` (the `F-<DIM>-<n>` finding ID format). If zero matches are found, treat the orchestrator as if it had failed: append one line to `.sdlc/learnings/log.md`: `## <YYYY-MM-DD> — plan-sdlc orchestrator returned brief without F-DIM-N findings; using fallback inline exploration`, then proceed via the **Error fallback** path below. Rationale: a brief with no findings cannot satisfy G15 (Brief citation coverage) and would force every task into "out-of-scope addition" — better to fall back cleanly.

  **Brief consumption (when brief is present AND validation passed):**
  - Step 2 tasks MUST cite at least one `F-<DIM>-<n>` finding ID from the brief OR be explicitly marked "out-of-scope addition" with rationale
  - When the brief contains a `## Best-Practice Synthesis` section: Key Decisions MUST explicitly ADOPT / REJECT-with-rationale / mark NOT-APPLICABLE each web finding by its `F-<DIM>-<n>` ID

- **Lightweight scope** (`explorePack.scopeHintCount` ≤ 3 OR `explorePack.manifestPath` is null due to lightweight scope):
  - Skip orchestrator. Use inline exploration below. No brief. (Tempdir cleanup is already installed by the unconditional trap above when `manifestPath` is non-null.)
- **Error fallback** (`explorePack.error` is non-null, the orchestrator returned non-zero, or brief validation found zero `F-<DIM>-<n>` IDs):
  - Append one line to `.sdlc/learnings/log.md`: `## <YYYY-MM-DD> — plan-sdlc orchestrator skipped: <explorePack.error or "brief without F-DIM-N findings">`
  - Use inline exploration below. Plan still produced.

**Structured discovery:** When requirements are vague (a single sentence or ambiguous goal), use AskUserQuestion with 2–3 targeted questions at once:
1. **Scope** — what's in, what's explicitly out?
2. **Integration** — what existing code does this touch?
3. **Success** — how will we know it works?

Wait for answers before continuing.

**Codebase exploration (skip for lightweight):** Use read-only tools (Glob, Grep, Read, LSP):
- Relevant file structure and patterns in affected areas. **CRITICAL:** Use `node "<PLUGIN_ROOT>/scripts/util/outline-file.js" <file>` to extract file outlines instead of natively reading large files.
- Existing modules, interfaces, and types the feature touches
- Testing patterns used in the project
- Build/lint/test commands (from Makefile, package.json, or similar)
- Naming conventions and code style
- All Glob/Grep/Read/Outline calls above MUST be issued in a single message (see Context Optimization Constraints).

Identify constraints: language, framework, existing conventions, testing approach.

**OpenSpec enrichment (when `openspecContext` is available):**
- Use `proposal.md` for goal and scope understanding (what's in, what's out)
- Use delta specs (`specs/*.md`) with their ADDED/MODIFIED/REMOVED sections as the authoritative requirements — each delta entry is a requirement
- Use `design.md` for architecture constraints and technical approach decisions
- Use `tasks.md` as a coarse reference for decomposition — OpenSpec tasks are higher-level than plan-sdlc tasks, so decompose further rather than copying verbatim
- When the OpenSpec artifacts provide sufficient scope, integration, and success criteria, skip the "Structured discovery" AskUserQuestion — the proposal and delta specs already answer those questions

## Step 2 (PLAN): Orchestrate Plan Generation

**Scope check:** If requirements span independent subsystems with no shared state, use AskUserQuestion:
> These requirements cover independent subsystems. Recommend splitting into N plans. Proceed as one plan or split?

Wait for answer.

**Orchestrator dispatch:**
Dispatch the `sdlc:plan-generation-orchestrator` Agent exactly once with inputs:
```
USER_PROMPT: <verbatim user request>
PLAN_FILE_PATH: <absolute path to plan file>
BRIEF_FILE: <absolute path to discovery-brief.md, or "none">
OPENSPEC_CONTEXT: <space-separated path list, or "none">
PROJECT_ROOT: <cwd>
FROM_OPENSPEC_DIRECT: <"true" or "false">
```

The `plan-generation-orchestrator` handles file mapping, task decomposition (with exact metadata formatting), Key Decisions writing, OpenSpec constraints validation, and writes the entire generated content to the plan file path.

**Wait for the orchestrator to finish** before proceeding to Step 3. The orchestrator returns a short summary upon writing the plan.

## Step 3 (CRITIQUE): Self-Review Plan — 5-Lane Parallel Gate Evaluation

**Re-anchor:** Re-read the plan file before dispatching lanes. The file — not your memory of it — is the source of truth.

**Fan-out dispatch:** Dispatch all five Step 3 lanes from `lanes[]` together (single-message parallel dispatch).

All 17 quality gates (G1–G17) are partitioned across five lanes — each gate belongs to exactly one lane. Lane dispatch parameters (`subagent_type`, `model`, and prompt body read from `promptTemplatePath`) MUST be sourced verbatim from the corresponding `lanes[i]` entry in the prepare output (`agent-dispatch-script-driven` guardrail — do NOT hardcode these values).

For each `lanes[i]` entry (i = 0..4):

- `subagent_type`: `lanes[i].subagentType`
- `model`: `lanes[i].model`
- prompt body: Read `lanes[i].promptTemplatePath` and fill template variables:
  - All lanes: `{PLAN_FILE_PATH}` (absolute path to plan file), `{PROJECT_ROOT}` (cwd)
  - Lanes 0–3 non-G17: `{REQUIREMENTS_SUMMARY}` (the numbered requirements list from Step 1 CONSUME — same content as `{REQUIREMENTS_CHECKLIST}` in Step 5; retained in memory from Step 1), `{ACTIVE_GUARDRAILS}` (from `guardrails[]` P7), `{OPENSPEC_TASKS}` (from `openspecContext.tasks` P13, null when not OpenSpec-sourced), `{BRIEF_FINDING_IDS}` (from `explorePack.manifestPath` context, null when no brief)
  - Lane 4 (G17/dimension-coverage): `{DIMENSIONS_DIR}` (`.sdlc/review-dimensions/`), `{COPILOT_DIR}` (`.github/instructions/`), `{GITHUB_HOSTING_DETECTED}` (`githubHosting.detected`), `{LEARNINGS_LOG_PATH}` (`.sdlc/learnings/log.md`), `{PR_COMMIT_WINDOW}` (best-effort "last 14 days" if unknown)

**Null `promptTemplatePath` handling:** When `lanes[i].promptTemplatePath` is null (prepare script reported it could not find the template), skip that lane's dispatch and immediately add a synthetic blocking issue:
```
{ laneStatus: "failed", gateIds: lanes[i].gateIds, issues: [{ gateId: lanes[i].gateIds[0], severity: "error", message: "Lane <name> skipped — promptTemplatePath null (template not found at prepare time)", blocking: true }], passes: [] }
```
Exception: lane 4 (G17/dimension-coverage) — when `lanes[4].promptTemplatePath` is null, treat as empty findings (advisory dispatch-failure fallback) and continue. Log to `.sdlc/learnings/log.md`:
```
## YYYY-MM-DD — plan-sdlc: G17 skipped — promptTemplatePath null (template not found at prepare time)
```

**No `isolation: "worktree"` on any lane dispatch** (forbidden per issues #370/#372).

**Collect lane results and merge:**

Each lane returns a JSON object with schema:
```json
{ "gateIds": [...], "issues": [...], "passes": [...], "laneStatus": "ok"|"failed"|"timeout" }
```
Lane 3 (guardrail-compliance) additionally returns `guardrailCompliancePayload` in the JSON object — store this for Step 4's `## Guardrail Compliance` section.
Lane 4 (dimension-coverage/G17) returns the G17 findings JSON — parse the `findings` object and persist as `g17Findings` for Step 4.

**Merge algorithm:**
1. `allIssues` = union of `issues[]` from all lanes
2. `allPasses` = union of `passes[]` from all lanes
3. `coverageCheck`: the union of all `gateIds[]` arrays returned by lanes MUST equal {G1..G17} exactly. Any missing gate ID → add a blocking issue: `{ gateId: "<missing>", severity: "error", message: "Gate <missing> not evaluated by any lane", blocking: true }`
4. Lane returning `laneStatus !== "ok"`: append to `allIssues` as blocking error `{ gateId: "lane-failure", severity: "error", message: "Lane <name> failed: <reason> — gate IDs <list> not evaluated", blocking: true }` — **exception: G17 lane (lanes[4]) failure is advisory, not blocking** (per dispatch-failure fallback)
5. Dedup `allIssues` by `(gateId, taskRef, message-normalized-prefix)` — keep first occurrence

Note every issue from `allIssues`. Do NOT write to the plan file in this step.

**JOIN barrier — `guardrailsEvaluated`:** After the guardrail-compliance lane (lanes[3]) result is incorporated into the merged issue list, record the checkpoint. **Do NOT write this marker before lanes[3] returns.** Marker writes are best-effort — a failed marker must never block plan creation.

```shell
node "<PLUGIN_ROOT>/scripts/skill/plan.js" --mark guardrailsEvaluated 2>/dev/null || true
```
> **Contract (Input/Output):**
> - **Input**: Guardrails content via stdin.
> - **Output**: Appends guardrails to configuration.

**JOIN barrier — `critiqueRan`:** After ALL five lanes have returned and the merged issue list is complete (including G17/lanes[4] findings parsed into `g17Findings`), record the checkpoint. **Do NOT write this marker until all five lanes have returned.** This extends the existing G17 join semantics to every lane.

```shell
node "<PLUGIN_ROOT>/scripts/skill/plan.js" --mark critiqueRan 2>/dev/null || true
```
> **Contract (Input/Output):**
> - **Input**: Critique text via stdin.
> - **Output**: Saves critique to pipeline state.

## Step 4 (IMPROVE): Revise Plan and Present for Approval

Fix all issues from Step 3. Rewrite the plan file with fixes applied (edit the existing file, don't append).

**G16 (OpenSpec tasks.md coverage) failure resolution:** When G16 reports uncovered OpenSpec task entries, resolve each one by EITHER (a) adding a plan task with the missing `openspec-task` block carrying the corresponding `ref`, OR (b) appending the uncovered title under the `## Out-of-scope OpenSpec tasks` section with a one-line rationale. Both paths are valid; choose based on whether the implementation actually covers the work.

If `activeGuardrails` is non-empty, append a `## Guardrail Compliance` section to the plan file listing each guardrail's evaluation result. Error-severity failures must be resolved before presenting to user. When an error-severity failure cannot be resolved by plan revision and blocks the workflow, offer **harden** (run `/harden-sdlc` to analyze why this failed and propose stronger guardrails / dimensions / instructions that would catch it earlier next time — opt-in, no surface is edited without your approval) alongside the user-revision options. When the user selects **harden** (interactive mode only — suppressed when `--auto` is set), dispatch `Skill(harden-sdlc)` with `--failure-text "Plan blocked by error-severity guardrail <id>: <description> — <rationale>"`, `--skill plan-sdlc`, `--step "Step 4 — IMPROVE"`, `--operation "error-severity guardrail block"`. Format:

```markdown
## Guardrail Compliance

| Guardrail | Severity | Status | Rationale |
|---|---|---|---|
| no-direct-db-access | error | PASS | No tasks modify database schema files |
| prefer-composition | warning | PASS | No class hierarchies proposed |
```

**Suggested Review Dimensions:**

When `g17Findings.findings` is non-empty, append the `g17Findings.rendering` markdown verbatim to the plan file. Placement:
- If `## Guardrail Compliance` was written above, splice immediately after that section.
- Otherwise, splice immediately after the last `### Task N:` block.

When `g17Findings.findings` is empty (or `g17Findings` is the empty-fallback from a dispatch failure), do nothing. Absent proposals are not a failure — G17 is advisory.

Step 4 is autonomous (single-touchpoint handoff). After fixes are applied (Guardrail Compliance section written when `activeGuardrails` is non-empty, and Suggested Review Dimensions spliced when `g17Findings.findings` is non-empty), proceed directly to Step 5. The user does NOT see the plan at Step 4; the single user touchpoint for the finalized plan is Step 7 (Handoff). The Step 4 error-severity guardrail-block harden offer above remains a genuine decision gate and is preserved.

## Step 5 (CRITIQUE): Plan Review Loop — Multi-Lens Fan-Out

Skip for lightweight plans (2–3 file scope from Step 0 routing).

**For plans with ≥5 tasks — Multi-lens fan-out:** Dispatch all lens reviewers from `lensReviewers[]` together (single-message parallel dispatch).

For each `lensReviewers[i]` entry (i = 0..2):
- `subagent_type`: `lensReviewers[i].subagentType`
- `model`: override with the **opposite-of-plan-author model** at dispatch time (cross-model property — plan written by gemini-3.8-flash-medium → dispatch reviewer as gemini-3.1-pro-low; plan written by gemini-3.1-pro-low → dispatch reviewer as gemini-3.8-flash-medium). This overrides the default `lensReviewers[i].model` value from the prepare output for ≥5-task plans.
- prompt body: Read `lensReviewers[i].promptTemplatePath` and fill template variables:
  - `{PLAN_FILE_PATH}` — absolute path to the plan file
  - `{LENS}` — `lensReviewers[i].lens` (one of `architecture`, `requirements`, `risk`)
  - `{LENS_FOCUS}` — `lensReviewers[i].focusCategories` rendered as a bullet list
  - `{REQUIREMENTS_CHECKLIST}` — numbered list from Step 1 (CONSUME)
  - `{SOURCE_REQUIREMENTS}` — file path or inline text of spec (if available)
  - `{BRIEF_FILE}` — absolute path to `discovery-brief.md`, or `"none — orchestrator skipped"`
  - `{OPENSPEC_TASKS}` — serialized JSON from `openspecContext.tasks[]`, or `"none — plan not from OpenSpec"`
  - `{GUARDRAILS}` — one guardrail per line (`- [id] (severity): description`), or `"none configured"`

When `lensReviewers[i].promptTemplatePath` is null, skip that lens and log to `.sdlc/learnings/log.md`: `## YYYY-MM-DD — plan-sdlc: lens "<name>" skipped — promptTemplatePath null (template not found at prepare time)`. Continue with remaining lenses.

**No `isolation: "worktree"` on any lens reviewer dispatch** (forbidden per issues #370/#372).

**Merge lens reviewer results (per iteration):**
1. **Status**: `Approved` iff ALL lens reviewers returned `Approved`; otherwise `Issues Found`
2. **Issues**: union of blocking issues across all lenses — dedup by `(taskRef, message-normalized-prefix)` (keep first occurrence)
3. **Recommendations**: collect all recommendations, dedup by string prefix (first 60 chars)
4. **Iteration counter**: increment by 1 per complete fan-out dispatch, regardless of how many lenses returned

**For plans with <5 tasks — Single reviewer (status quo):** Dispatch one reviewer with `{LENS}=all` using `./resources/plan-reviewer-prompt.md` directly (same model acceptable). Status quo behavior preserved.

**Review loop:**
- Approved → Step 6 is a no-op, proceed to Step 7
- Issues found → go to Step 6
- Max 3 iterations → use AskUserQuestion to surface unresolved issues to user. Offer **harden** (run `/harden-sdlc` to analyze why this failed and propose stronger guardrails / dimensions / instructions that would catch it earlier next time — opt-in, no surface is edited without your approval) alongside the existing escalation options. When the user selects **harden** (interactive mode only — suppressed when `--auto` is set), dispatch `Skill(harden-sdlc)` with `--failure-text "Plan reviewer loop did not converge after 3 iterations. Outstanding issues: <union-of-blocking-issues-across-all-lenses>"`, `--skill plan-sdlc`, `--step "Step 5 — review loop"`, `--operation "reviewer-loop max iterations"`.

## Step 6 (IMPROVE): Apply Review Fixes

Fix each blocking issue identified by the reviewer. Rewrite the plan file with fixes applied.

Re-dispatch the reviewer (back to Step 5 loop).

If this is the 3rd iteration, use AskUserQuestion to surface remaining issues instead of looping.

## Step 6.5 (LINK VERIFICATION): Validate URLs in plan content — HARD GATE

After the reviewer loop converges (or the user resolves remaining issues), validate every URL embedded in the finalized plan file via the shared link validator. The script reads the plan content from stdin and auto-derives `expectedRepo` from `parseRemoteOwner(cwd)` and `jiraSite` from `~/.sdlc-cache/jira/` — the skill MUST NOT construct ctx JSON.

```shell
node "<PLUGIN_ROOT>/scripts/util/plan-validate-links.js"
```
> **Contract (Input/Output):**
> - **Input**: Text via stdin, or via `--file <path>` argument.
> - **Output**: Prints violations to stderr and exits non-zero on broken links.

On non-zero exit (`LINK_EXIT != 0`):
- The script has already printed the violation list to stderr.
- Do NOT proceed to Step 7 (Handoff). The plan is not ready.
- Surface the violation list verbatim to the user.
- Stop. Do not retry. Do not edit URLs without user input. Do not bypass.

On zero exit, proceed to Step 7. `SDLC_LINKS_OFFLINE=1` skips network reachability while keeping context-aware checks (GitHub identity match, Atlassian host match) — use in sandboxed CI.

## Step 7: Handoff

**Context-heaviness advisory:** Before printing either branch below, run the advisory script. If it prints text, prepend that text verbatim to the handoff menu (above the `ship` / `execute` / `done` lines). If it prints nothing, skip the prepend.

```shell
node "<PLUGIN_ROOT>/scripts/skill/plan-handoff-advisory.js"
```
> **Contract (Input/Output):**
> - **Input**: None.
> - **Output**: Prints advisory text for downstream agent handoff.

The script reads `$TMPDIR/sdlc-context-stats.json` and emits a `/compact` advisory only when transcript ≥60% of model budget. **The sidecar's producer, a `UserPromptSubmit` hook at `hooks/context-stats.js`, does not exist and is not registered in `hooks.json`** — the sidecar file is therefore never written today, so this advisory currently never fires (the reader degrades to a silent no-op when the sidecar is absent, by design). Pipeline state is preserved across `/compact` (PreCompact + SessionStart hooks), so re-invoking after compaction is safe.

**Plan mode:** Announce the plan path and propose execution. Prepend any advisory output from the wrapper above the `ship` / `execute` lines:

> Plan written to `<path>`. On approval:
>   ship    — run the full pipeline: execute → commit → review → version → PR (/ship-sdlc)
>   execute — execute the plan only (/execute-plan-sdlc)

Then call ExitPlanMode. Do NOT invoke execute-plan-sdlc or ship-sdlc in this turn — they run after the user accepts in the next turn.

**Normal mode:** Announce the plan path, then present the Workflow Continuation menu (see below). Prepend any advisory output from the wrapper above the menu's `ship` / `execute` / `done` lines.

## Error Recovery

| Error | Recovery |
|---|---|
| Spec/requirements not found | Ask user to provide path or paste content |
| Codebase exploration fails (too large) | Ask user to point to relevant directories |
| Plan reviewer loop exceeds 3 iterations | Surface to user for guidance |
| Requirements are contradictory | Flag specific contradictions, ask user to resolve |
| User approves but output path fails | Retry with a different path; offer to print plan to screen |

## DO NOT

- Write implementation code in the plan (code snippets for patterns are fine; full implementations are not)
- Mandate TDD for every task — match verification to task type
- Create plans with fewer than 2 tasks (just do the work directly)
- Use absolute file paths that only work on one machine
- Put plans in `$TMPDIR` — plans should survive session boundaries
- Put plans in plugin-branded directories (no `docs/superpowers/plans/`)
- Ignore plan mode's designated file path when plan mode is active — always write to it
- Skip the plan review loop (Step 5) unless lightweight routing applies

## Gotchas

- **Vague task descriptions produce hallucinated implementations.** Every task needs an exact file and behavior — "add authentication" isn't a task, "add JWT validation middleware at `src/middleware/auth.ts`" is. If you can't describe the exact file and behavior, the task isn't ready.
- **Complexity classification drift.** Classify by the full description, not the title — "add a config key" can be Standard if it needs a schema, a migration, and downstream changes.
- **Implicit dependencies.** Tasks with no shared file can still depend on each other (barrel files, type re-exports, config registrations, route ordering) — check for these during Step 3 critique.
- **Over/under-decomposition.** Mostly-Trivial tasks means the plan is over-decomposed (each task should be a meaningful unit of work). A task touching >5 files or implementing 3+ independent behaviors is under-decomposed — split it.
- **Plan-execution format mismatch.** Every task needs Complexity, Risk, Depends on, and Verify fields — execute-plan-sdlc consumes these for wave building; missing metadata forces slower, less accurate inference.
- **Plan file is the single source of truth.** No temp files, scratchpads, or side documents — exploration findings belong in the plan file's Requirements section.

## Learning Capture

After writing the plan, append to `.sdlc/learnings/log.md`:

- Requirements that needed significant clarification before decomposition
- Scope decisions (what was included/excluded and why)
- Codebase patterns that influenced task structure
- Plans that were over/under-decomposed on first draft

Format:
```
## YYYY-MM-DD — plan-sdlc: <feature name>
<what was learned>
```

## Workflow Continuation

After writing the plan (normal mode only), present the user with available next actions:

```
What would you like to do next?
  ship     — execute, commit, review, version, and PR (/ship-sdlc)
  execute  — execute the plan only (/execute-plan-sdlc)
  done     — stop here

Select:
```

On selection, invoke the chosen skill using the Skill tool. On "done", end without further action.

## See Also

- `./resources/plan-reviewer-prompt.md` — plan review subagent template
- `./resources/plan-format-reference.md` — plan document format specification
- [`/execute-plan-sdlc`](../execute-plan-sdlc/SKILL.md) — skill that executes the plans this skill produces
