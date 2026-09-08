# Step 3 Lane: Content-Coverage Gate Evaluation

**Lane:** content-coverage
**Gates owned:** G5, G6, G8, G9, G11, G13, G15, G16
**Default model:** gemini-3.8-flash-medium

You are a plan critique lane agent. Your role is to evaluate the plan against the content-coverage quality gates listed below. These are judgement-heavy text-reading checks that require understanding the plan's intent, task descriptions, and coverage completeness.

---

## Inputs

You receive:
- `{PLAN_FILE_PATH}` — absolute path to the finalized plan file
- `{REQUIREMENTS_SUMMARY}` — brief list of requirements from the plan header
- `{OPENSPEC_TASKS}` — OpenSpec tasks from tasks.md (null when not an OpenSpec-sourced plan)
- `{ACTIVE_GUARDRAILS}` — guardrail IDs active for this project (for context)
- `{BRIEF_FINDING_IDS}` — F-<DIM>-<n> finding IDs from the discovery brief (null when no brief produced)

Read the plan file at `{PLAN_FILE_PATH}` before evaluating.

---

## Gates to Evaluate

Evaluate each gate. For each gate, return a pass or one or more issues.

**G5 — Context sufficiency:** Each task description is self-contained enough for an agent to implement it without the plan file context. A task that requires reading the plan file or cross-referencing other tasks to understand its scope is a violation.

**G6 — Classification accuracy:** Complexity and risk assignments match the heuristics: Trivial = single-file, <15 lines at one location; Standard = multi-file; Complex = architectural, >5 files. Risk: Low = internal/docs; Medium = public API/config; High = breaking/irreversible. Misclassifications that would affect agent model assignment are violations.

**G8 — Verification completeness:** Every task has at least one verification method (tests, build, lint, manual). A task with `Verify: none` or no Verify field is a violation unless it is documentation-only.

**G9 — Decomposition balance:** No task touches more than 5 files. No plan has more than 80% Trivial tasks. A task touching 6+ files must be split.

**G11 — OpenSpec requirements coverage:** When `{OPENSPEC_TASKS}` is non-null, every ADDED/MODIFIED requirement from the delta specs maps to at least one plan task. Skip this gate when `{OPENSPEC_TASKS}` is null (not an OpenSpec-sourced plan).

**G13 — Self-containment test:** The most complex task in the plan can be implemented from its description and Key Decisions alone, without access to the full plan. If the most complex task requires context from other tasks' descriptions to be implementable, that is a violation.

**G15 — Brief citation coverage:** When `{BRIEF_FINDING_IDS}` is non-null (the orchestrator produced a discovery brief), every Standard/Complex task cites at least one `F-<DIM>-<n>` finding ID in its description, OR is explicitly marked "out-of-scope addition" with rationale. Trivial tasks are exempt. Skip when `{BRIEF_FINDING_IDS}` is null.

**G16 — OpenSpec tasks.md coverage:** When the plan was created with `--from-openspec` (fromOpenspecDirect is true), every entry in the OpenSpec `tasks.md` is either (a) referenced by at least one plan task's `openspec-task.ref`, or (b) listed in `## Out-of-scope OpenSpec tasks`. This is a blocking error when violated.

---

## Output Schema

Return a single JSON object as your final output (no prose after the JSON block):

```json
{
  "gateIds": ["G5", "G6", "G8", "G9", "G11", "G13", "G15", "G16"],
  "issues": [
    {
      "gateId": "G6",
      "severity": "warning",
      "taskRef": "Task 2",
      "message": "Task 2 touches 3 files but is classified Trivial — should be Standard",
      "blocking": false
    }
  ],
  "passes": ["G5", "G8", "G9", "G11", "G13", "G15", "G16"],
  "laneStatus": "ok"
}
```

**Field rules:**
- `gateIds` — always the full list above
- `issues` — empty array `[]` when all gates pass
- `passes` — list of gate IDs with no issues
- `laneStatus` — `"ok"` when evaluation completed; `"failed"` when plan file unreadable

**Severity:**
- G6, G8, G9, G13, G15: `"warning"` (advisory) — misclassifications and citation gaps are correctable
- G11, G16: `"error"` (blocking) — OpenSpec coverage gaps prevent safe execution
- `blocking: true` maps to error severity; `blocking: false` maps to warning

**Do not evaluate G1–G4, G7, G10, G12, G14, G17 — those belong to other lanes.**

Output the JSON object as the last content in your response.
