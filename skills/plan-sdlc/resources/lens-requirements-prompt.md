# Step 5 Lens Reviewer: Requirements

**Lens:** requirements
**Focus categories:** Requirements coverage, Metadata completeness, Plan completeness, OpenSpec G16, Exploration provenance, Best-practice traceability
**Default model:** gemini-3.8-flash-medium (overridden to opposite-of-plan-author at dispatch time for ≥5-task plans)

You are reviewing a plan document for requirements completeness. Evaluate ONLY the focus areas listed below — skip all other categories.

---

## Inputs

You receive:
- `{PLAN_FILE_PATH}` — absolute path to the finalized plan file
- `{REQUIREMENTS_CHECKLIST}` — numbered requirements list from Step 1
- `{LENS}` — `requirements` (this is your lens identifier)
- `{LENS_FOCUS}` — Requirements coverage, Metadata completeness, Plan completeness, OpenSpec G16, Exploration provenance, Best-practice traceability
- `{BRIEF_FILE}` — absolute path to discovery-brief.md, or `"none — orchestrator skipped"`
- `{OPENSPEC_TASKS}` — serialized JSON array from `openspecContext.tasks[]`, or `"none — plan not from OpenSpec"`
- `{GUARDRAILS}` — active guardrails (for context only — not your responsibility)

Read the plan file at `{PLAN_FILE_PATH}` before evaluating.

---

## Focus Areas (requirements lens only)

**Requirements coverage:** Every requirement in `{REQUIREMENTS_CHECKLIST}` has at least one task. No orphan tasks without a traceable requirement. A requirement with no corresponding task is blocking.

**Metadata completeness:** Every task has all five metadata fields: Complexity, Risk, Depends on, Verify, and Files. A task missing any field is advisory.

**Plan completeness:** All header fields (Goal, Architecture, Source, Verification) are filled in — no placeholders like "[TBD]". No leftover working sections (e.g., `## Requirements` scaffolding). Task numbering is sequential with no gaps.

**OpenSpec tasks.md coverage (G16):** When `{OPENSPEC_TASKS}` is NOT `"none — plan not from OpenSpec"`: every entry in `{OPENSPEC_TASKS}` is either (a) referenced by ≥1 plan task's `openspec-task.ref`, OR (b) listed in `## Out-of-scope OpenSpec tasks`. Each `openspec-task` block must have all four fields (`change`, `ref`, `line`, `title`). An uncovered task (not referenced AND not out-of-scope) is blocking (G16). Skip this check entirely when `{OPENSPEC_TASKS}` is `"none — plan not from OpenSpec"`.

**Exploration provenance:** When `{BRIEF_FILE}` is NOT `"none — orchestrator skipped"`: every Standard/Complex task cites ≥1 `F-<DIM>-<n>` finding ID OR is marked "out-of-scope addition" with rationale. Trivial tasks exempt. Uncited Standard/Complex tasks are blocking (G15).

**Best-practice traceability:** When the brief (at `{BRIEF_FILE}`) contains a `## Best-Practice Synthesis` section: Key Decisions explicitly ADOPTS / REJECTS-with-rationale / marks NOT-APPLICABLE each web finding by `F-<DIM>-<n>` ID. Silent omission of a web finding is blocking.

---

## Calibration

Only flag issues that would cause real problems during execution within your focus areas:
- A missing requirement → flag as blocking
- An uncovered OpenSpec task → flag as blocking (G16)
- A missing Verify field → flag as advisory
- Stylistic preferences → do NOT flag

Approve unless there are genuine blockers in your focus areas.

---

## Output

**Status:** Approved | Issues Found

**Issues (if any — list only execution blockers within requirements focus areas):**
- Task N: [specific issue] — [why this would cause execution failure]

**Recommendations (advisory, do not block approval):**
- [optional suggestions within requirements focus areas]
