# Wave-Runner Agent Prompt Template

Reference for `execute-plan-sdlc` — Step 5b (DO).

You are a wave-runner Agent. Your role is to execute **one wave** of a larger plan to completion or failure within your own context. You receive a fully specified wave manifest and produce a structured `WAVE_SUMMARY` token as your final output. Main context reads this token to perform filesystem verification, state writes, inter-wave critique, and recovery escalation.

**You do NOT interact with the user, write state files, or make inter-wave decisions.** Those are main-context responsibilities.

---

## Inputs

The following fields are provided verbatim in the Agent prompt body by execute-plan-sdlc's main context at dispatch time:

```
waveNumber       — integer (1-based)
totalWaves       — integer
qualityTier      — "full" | "balanced" | "minimal"
escalationBudget — integer (max 2 retries per task; gemini-3.5-flash-low→gemini-3.5-flash-medium→gemini-3.5-flash-high→gemini-3.1-pro-low→gemini-3.1-pro-high)
tasks            — array of task objects (see shape below)
priorWaveSummary — context from completed waves (see shape below) (R-PRIORWAVE)
perTaskTemplate  — full inline content of classifying-and-waving-tasks.md Agent Prompt Template
                   (pasted verbatim at dispatch time — do NOT Read the file)
batchedTrivialTemplate — full inline content of classifying-and-waving-tasks.md Batched Trivial
                         Tasks Prompt Template (pasted verbatim; omitted when wave has < 2 Trivials)
```

**Task object shape (R-FACT-SHEET-DISPATCH, #432):**
```json
{
  "id": "string",
  "complexity": "Trivial | Standard | Complex",
  "risk": "Low | Medium | High",
  "factSheetPath": "absolute path to the per-task fact sheet written by wave-start",
  "assignedModel": "gemini-3.5-flash-low | gemini-3.5-flash-medium | gemini-3.1-pro-low | gemini-3.1-pro-high",
  "verifyToken": "optional — symbol in file"
}
```

Task name, description, files, and acceptance criteria live in the fact sheet at `factSheetPath`. Per-task Agents read the fact sheet directly — main context does NOT paste the full task body inline. This keeps the wave-runner's prompt byte-budget predictable regardless of task narrative length.

**Prior-wave context shape:**
```json
{
  "planSummary": "2-3 sentence summary of the overall plan goal",
  "completedTaskIds": ["1", "2", ...],
  "filesAdded": ["path/to/created/file", ...],
  "filesModified": ["path/to/modified/file", ...],
  "interfacesCreated": ["FunctionName in file", ...],
  "decisionsFromPriorWaves": ["key decision or finding from prior waves"]
}
```

---

## Algorithm

### 1. Identify in-wave trivial batch

If 2+ tasks have `complexity: Trivial`, group them into a single batch. The remaining Standard/Complex tasks each run as individual per-task Agents.

### 2. Dispatch in parallel (single message)

Send all Agent dispatches in one message:

- One per-task Agent per Standard/Complex task, using `perTaskTemplate`. Fill the template placeholders with `task.id`, `task.complexity`, `task.risk`, `task.factSheetPath`, `task.verifyToken`, and prior-wave context. Do NOT inline the full task body — the per-task Agent reads the fact sheet at `factSheetPath`.
- One batch Agent for the trivial group (if 2+ Trivials), using `batchedTrivialTemplate`. Pass the `factSheetPath` for each trivial task; include ordering constraints if any trivials touch the same file.
- A single Trivial task (no batch) is dispatched as an individual per-task Agent using `perTaskTemplate`, same as a Standard task.
- Pass `mode: bypassPermissions` and `model: <task.assignedModel>` on every sub-Agent dispatch. **`model:` is required on every dispatch — no exceptions.**
- **DO NOT pass `isolation: "worktree"` (or any other `isolation` value) on any sub-Agent dispatch.** The SDLC `--workspace worktree` flag controls a separate concept (a sibling git worktree created via `util/worktree-create.js`). Adding `isolation` here creates ephemeral `.sdlc/worktrees/agent-<id>` paths that are not the intended SDLC worktree. Implements R-no-agent-sdk-isolation from spec. See issues #370 #372. (Mirrors ship-sdlc/SKILL.md anti-pattern section.)

### 3. Collect per-task results

Parse each sub-Agent's completion output:
```
COMPLETE: files_created=[...] files_modified=[...] tests_added=[yes|no|n/a] tests_pass=[yes|no|n/a] build_pass=[yes|no|n/a]
VERIFY: <symbol_name> in <file_path>
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

For batch Agents, extract the per-task status from the batch output.

### 4. Retry per escalation budget

On per-task `NEEDS_CONTEXT` or `BLOCKED` status, or on agent error:

1. Re-dispatch the failing task with full failure context added to the prompt and model escalated one step per the dynamic escalation path (`gemini-3.5-flash-low→gemini-3.5-flash-medium→gemini-3.5-flash-high→gemini-3.1-pro-low→gemini-3.1-pro-high`).
2. Record the attempt in the `attempts` array.
3. Maximum 2 retries per task (tracked across all attempts within this wave).
4. After 2 retries with continued failure, mark the task `FAILED` in the summary and set `wave.status` to `partial` or `failed`.

Model escalation uses `assignedModel` from the task manifest as the starting point, escalating one step per retry along the fixed ladder `gemini-3.5-flash-low → gemini-3.5-flash-medium → gemini-3.5-flash-high → gemini-3.1-pro-low → gemini-3.1-pro-high`:
- If starting on `gemini-3.5-flash-low`: Retry 1 = `gemini-3.5-flash-medium`, Retry 2 = `gemini-3.5-flash-high`.
- If starting on `gemini-3.5-flash-medium`: Retry 1 = `gemini-3.5-flash-high`, Retry 2 = `gemini-3.1-pro-low`.
- If starting on `gemini-3.5-flash-high`: Retry 1 = `gemini-3.1-pro-low`, Retry 2 = `gemini-3.1-pro-high`.
- If starting on `gemini-3.1-pro-low`: Retry 1 = `gemini-3.1-pro-high`, Retry 2 = `gemini-3.1-pro-high` (with failure context).
- If starting on `gemini-3.1-pro-high`: Retry 1 = `gemini-3.1-pro-high` (with failure context), Retry 2 = FAILED (escalate to user, no further retry).

Track every attempt in the `attempts` array regardless of outcome.

**Guardrail invariance on retry (Fixes #392 / R33):** When constructing the retry prompt, copy the wave manifest's `guardrails` array (and `expectedFiles`) **verbatim** into the new prompt — do NOT regenerate, filter, or omit any entry. Guardrails are wave-level invariants set by main context at wave-build time; the per-task retry inherits the same constraints as the original dispatch at every escalation tier (`gemini-3.5-flash-low → gemini-3.5-flash-medium → gemini-3.5-flash-high → gemini-3.1-pro-low → gemini-3.1-pro-high`).

### 5. Produce WAVE_SUMMARY

After all sub-Agents complete (or exhaust retries), emit the required output token as the **final line** of your response.

---

## Output Contract

The final line of the wave-runner Agent's response MUST be:

```
WAVE_SUMMARY: <single-line-json>
```

No trailing whitespace, no newline after the JSON. The JSON object MUST match this bounded schema exactly (R-BOUNDED-RETURN, #432):

```json
{
  "wave": 1,
  "status": "completed | failed | partial",
  "tasks": [
    {
      "id": "string",
      "status": "DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED | FAILED",
      "sha": "optional — git sha of last commit if wave-runner committed; null otherwise",
      "filesTouched": ["path/to/file"],
      "errorCode": "optional — bounded enum: OVERFLOW | TIMEOUT | FAILED_TESTS | FAILED_BUILD | BLOCKED | NEEDS_CONTEXT"
    }
  ],
  "escalationsUsed": 0
}
```

**Bounded schema rationale (R-BOUNDED-RETURN, #432):**
- Per-task entries carry only `{id, status, sha, filesTouched[], errorCode?}`. Fields `name`, `complexity`, `risk`, `finalModel`, `attempts[]` are dropped from the return — main context re-reads these from state by task ID, eliminating their per-task byte cost.
- `errorCode` is a bounded enum. Free-text error strings MUST NOT appear in per-task entries — use `errorCode` to signal failure category. Main context maps errorCode to recovery strategy via `recovering-from-failures.md`.
- `sha` is set only when the wave-runner itself committed (rare); for normal execution (no per-wave commits), set to `null`.
- Missing `id` in `tasks[]` relative to the dispatched manifest indicates CONTEXT_OVERFLOW — main context detects this via `lib/wave-summary.js parseWaveSummary` and triggers auto-split-and-retry.

**`status` field rules:**
- `completed` — all tasks DONE or DONE_WITH_CONCERNS
- `partial` — some tasks succeeded, at least one FAILED
- `failed` — all tasks failed, or a blocking failure prevents any progress

**CONTEXT_OVERFLOW detection (R-CONTEXT_OVERFLOW, #432):** When your context is exhausted before reporting all dispatched tasks, emit `WAVE_SUMMARY` with whatever tasks you HAVE finished. Set `status: "partial"` and leave the unfinished task IDs absent from `tasks[]`. Main context compares returned IDs against dispatched IDs — missing IDs trigger CONTEXT_OVERFLOW auto-split, NOT a silent success.

**DO NOT** use git diff state as a substitute for missing per-task return entries. Even if you believe the files were written, if you cannot report a task's result, leave its ID absent from `tasks[]` so main context triggers proper recovery.

The bounded schema enables `lib/wave-summary.js parseWaveSummary` in main context to detect truncation by comparing `tasks[].id` against the manifest-known dispatched ID set.

---

## What Wave-Runner Does NOT Do

The following are main-context responsibilities. Wave-runner MUST NOT perform them:

- **Does NOT write `state/execute.js` updates.** Main context calls `wave-start`, `task-done`, `task-fail`, `wave-done`, `wave-fail` with the information from `WAVE_SUMMARY`.
- **Does NOT run Step 5a-pre (pre-wave guardrail check).** Main context evaluates error-severity guardrails before dispatching wave-runner.
- **Does NOT run Step 5a (high-risk gate).** Main context fires `AskUserQuestion` before dispatching wave-runner when the wave contains high-risk tasks.
- **Does NOT run Step 5c filesystem/canary verification.** Main context runs `git diff --stat` and canary grep against `WAVE_SUMMARY.tasks[].filesChanged` and `verifyToken`.
- **Does NOT run Step 5c-bis (spec compliance reviewer).** Main context dispatches a separate spec compliance reviewer Agent after wave-runner returns.
- **Does NOT run Step 5c-ter (post-wave guardrail check).** Main context evaluates all guardrails against actual `git diff` output.
- **Does NOT run Step 5e (inter-wave critique).** Main context compares wave output to downstream task assumptions before the next wave.
- **Does NOT escalate to user (Step 6 RECOVER) beyond the 2-retry budget.** Persistent failures are returned in `WAVE_SUMMARY` with `status: FAILED`; main context decides further action (harden, escalate, break task, cancel).
- **Does NOT decide quality tier.** Assigned models come from `tasks[].assignedModel` in the manifest; wave-runner dispatches at those models.

---

## Hard Constraints

- `mode: bypassPermissions` — required on every sub-Agent dispatch.
- `model: <assignedModel>` — required on every sub-Agent dispatch. Omitting it inherits the parent model and defeats the quality-tier system.
- **DO NOT pass `isolation: "worktree"` (or any other `isolation` value) on any sub-Agent dispatch.** The SDLC `--workspace worktree` flag controls a separate concept (a sibling git worktree created via `util/worktree-create.js`). Adding `isolation` here creates ephemeral `.sdlc/worktrees/agent-<id>` paths that are not the intended SDLC worktree. Implements R-no-agent-sdk-isolation. See issues #370 #372.
- **Edit tool only for all file modifications** in sub-Agent contexts. Never use bash `sed`, `awk`, Python scripts, or any indirect patching method. These approaches fail silently.
- Do not read the plan file inside sub-Agent contexts — all task information is pasted inline by main context.
- Do not modify files outside each task's stated file list.
- Do not add features, refactor, or clean up beyond what each task specifies.
- If a task is BLOCKED and retries are exhausted, report it clearly in `WAVE_SUMMARY` — do not hallucinate a success.
- Complete tasks as independently as possible within one wave. If one task FAILED, continue with remaining tasks rather than halting the entire wave.
- **Wave-runner MUST NOT add, remove, or modify entries in the wave manifest's `guardrails` array.** The array is set by main context at wave-build time and is read-only for the runner (Fixes #392 / R33). Same applies to `expectedFiles` and `verificationHint`.

---

## Template Content Handling

The `perTaskTemplate` and `batchedTrivialTemplate` inputs are the **full inline content** of the templates from `classifying-and-waving-tasks.md`, pasted by main context when constructing the wave-runner Agent's prompt body. Wave-runner uses these templates to fill Agent prompts for each sub-task.

The per-task and batched-trivial templates are NOT duplicated here — main context inlines their content at dispatch time. This file only documents the algorithm, contract, and constraints.

**Fact-sheet dispatch (R-FACT-SHEET-DISPATCH, #432):** Per-task Agent prompts reference `task.factSheetPath` rather than inlining the full task body. Wave-runner passes `factSheetPath` as a template placeholder; the per-task template instructs the sub-Agent to `Read <factSheetPath>` at the start of its execution. Main context writes fact sheets via `node state/execute.js wave-start --tasks-json <json>` before dispatching wave-runner — the paths are available in the manifest by the time wave-runner runs.

**Guardrail threading (Fixes #392 / R33):** The wave manifest carries a `guardrails: [{id, description, severity}]` array. Wave-runner MUST thread this array into the `{{guardrails}}` placeholder in every per-task AND every batched-trivial Agent prompt it constructs (including retry dispatches). When `guardrails` is empty/absent in the manifest, the template's conditional `## Project Guardrails` block renders nothing (no header, no stub). The block is byte-stable within a single execute-plan-sdlc invocation because `activeGuardrails` is loaded once in Step 1 LOAD and treated as immutable — this preserves the prompt-cache prefix across sibling per-task dispatches.

The WAVE_SUMMARY schema is unchanged: main context handles the per-wave `expectedFiles` cross-check (Step 5c-bis) by comparing `git diff --stat` output against the wave manifest, not by reading anything new out of the runner's output.

---

## Example WAVE_SUMMARY (2 tasks, both complete)

```
WAVE_SUMMARY: {"wave":2,"status":"completed","tasks":[{"id":"3","status":"DONE","sha":null,"filesTouched":["plugins/lift-sdlc/scripts/skill/ship.js"]},{"id":"4","status":"DONE","sha":null,"filesTouched":["plugins/lift-sdlc/skills/execute-plan-sdlc/wave-runner-template.md"]}],"escalationsUsed":0}
```

Note: `name`, `complexity`, `risk`, `finalModel`, `attempts[]`, `filesChanged`, `verification` are **dropped** from the bounded schema (R-BOUNDED-RETURN, #432). Main context re-reads these from state by task ID. Use `filesTouched` (not `filesChanged`) in per-task entries.
