---
name: harden-sdlc
description: "Use this skill after an SDLC pipeline failure to analyze hardening surfaces (plan and execute guardrails, review dimensions, copilot instructions) and propose user-approved edits that would prevent the same class of failure next time. Strengthen-only in v1 — never relaxes or removes existing rules. Required arguments: --failure-text <string> --skill <caller-name>. Optional: --step, --operation, --exit-code, --error-type, --user-intent, --args-string. Triggers on: harden, strengthen guardrails, prevent this failure, learn from this failure, after pipeline failure."
user-invocable: true
argument-hint: "--failure-text <text> --skill <name> [--step <s>] [--operation <op>]"
model: gemini-3.5-flash
---

# Hardening After a Pipeline Failure

This skill runs after an SDLC pipeline failure to propose user-approved edits to
the project's hardening surfaces (plan guardrails, execute guardrails, review
dimensions, copilot instructions) so the same class of failure is caught earlier
next time. Implements `docs/specs/harden-sdlc.md`.

**Key spec requirements implemented here:** R14 (review-dimension priority + minimum coverage), R15 (duplication scan + `consolidate` action), R16 (pre-flight validation in prepare script), R17 (severity vocabulary single source — `lib/dimensions.js`).

**Announce at start:** "I'm using harden-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

---

## Step 0 — Parse Arguments (R1, R2, R19)

**Mutually exclusive primary inputs:**

| Mode | Flag | Required when |
|---|---|---|
| Inline failure text | `--failure-text <string>` | Always, unless `--from-issue` is used |
| GitHub issue fetch | `--from-issue <num>` | Alternative to `--failure-text` |

If both `--failure-text` and `--from-issue` are provided simultaneously, stop
immediately with exit code 2 and a clear mutual-exclusion error message. Do not
proceed to the prepare script.

If neither `--failure-text` nor `--from-issue` is present, stop with an error
message.

Required flag (always): `--skill`. Optional: `--step`, `--operation`,
`--exit-code`, `--error-type`, `--user-intent`, `--args-string`.

**When `--from-issue <num>` is used:** the prepare script fetches the GitHub
issue body automatically (via `gh issue view`). When the issue carries the
`mcp-failure` label, the prepare script pre-sets `classification: "plugin-defect"`
in the manifest. In that case, skip Step 3 — proceed directly to Step 4, which
will route to Step 6 (PLUGIN-DEFECT ROUTE) without dispatching the orchestrator.
Pass `--from-issue "$ISSUE_NUM"` to the prepare script invocation in Step 1.

---

## Step 1 — CONSUME: Run the Prepare Script (R4, R13, C5–C8)

> **VERBATIM** — Run this bash block exactly as written. Do not modify, rephrase, or simplify the commands.

```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

SCRIPT="$SDLC_ROOT/scripts/skill/harden-prepare.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/harden-prepare.js. Is the sdlc plugin installed?" >&2; exit 2; }

MANIFEST_FILE=$(node "$SCRIPT" \
  ${FAILURE_TEXT:+--failure-text "$FAILURE_TEXT"} \
  ${FROM_ISSUE:+--from-issue "$FROM_ISSUE"} \
  --skill "$SKILL_NAME" \
  --step "$STEP_NAME" \
  --operation "$OPERATION" \
  --exit-code "$EXIT_CODE_ARG" \
  --error-type "$ERROR_TYPE" \
  --user-intent "$USER_INTENT" \
  --args-string "$ARGS_STRING" \
  --output-file)
EXIT_CODE_PREPARE=$?
echo "MANIFEST_FILE=$MANIFEST_FILE"
echo "EXIT_CODE=$EXIT_CODE_PREPARE"
# Single canonical cleanup: trap fires only when MANIFEST_FILE was written so
# we do not attempt `rm -f ""` on a failed script invocation.
trap '[ -n "$MANIFEST_FILE" ] && rm -f "$MANIFEST_FILE"' EXIT INT TERM

```

Substitute the shell variables with values from the parsed arguments. Empty
values for optional fields are tolerated.

**On non-zero `EXIT_CODE_PREPARE`:**

- Exit code 1: required field missing — show the script's stderr and stop.
- Exit code 2: prepare script crashed — show stderr and stop. Do **not**
  recursively dispatch this skill on its own crash; this is a plugin defect and
  belongs in `error-report-sdlc`.

**Do NOT read the manifest file contents into the main context yet.** Step 2
needs only the classification preview (a small subset), and Step 3 hands the
full manifest path to the orchestrator agent.

---

## Step 2 — CLASSIFY: Surface the Failure Classification (R5, R9)

Read **only** the `failure.*` and `classification_hint` fields from
`MANIFEST_FILE` — do not load the full surface arrays into the main context.
Display a short preview to the user:

```
harden-sdlc: failure context loaded
  Skill:        {failure.skill}
  Step:         {failure.step or "—"}
  Operation:    {failure.operation or "—"}
  Failure (first 200 chars): {failure.text[:200]}
  Classification hint:  {classification_hint or "(none — orchestrator will classify)"}
```

When `classification_hint == "plugin-defect"` (set by prepare script when
`--from-issue` fetches an issue with the `mcp-failure` label), skip Step 3 —
proceed directly to Step 4, which will route to Step 6 (PLUGIN-DEFECT ROUTE)
without dispatching the orchestrator. The manifest already carries the
pre-set classification; the orchestrator agent is not needed.

The orchestrator (Step 3) is responsible for the authoritative classification
in all other cases. Continue to Step 3.

---

## Step 3 — ANALYZE: Dispatch the harden-orchestrator Agent (R6)

Use the `Agent` tool with:

- `subagent_type`: `sdlc:harden-orchestrator`
- `model`: `haiku`
- `prompt` (exactly two lines, no other content):

  ```text
  MANIFEST_FILE: <ERROR_CONTEXT_FILE>
  PROJECT_ROOT: <cwd>
  ```

  Substitute `<ERROR_CONTEXT_FILE>` with the absolute path captured in Step 1
  (`MANIFEST_FILE`) and `<cwd>` with the current working directory.

The orchestrator returns ONLY a JSON object:

```json
{
  "classification": "user-code | plugin-defect | ambiguous",
  "classificationRationale": "string",
  "routeToErrorReport": false,
  "errorReportPayload": null,
  "proposals": [ ... ]
}
```

Capture the returned object as `RESULT`. If JSON parse fails, stop and surface
the raw response to the user (per spec E4 — no retry, the issue is unrelated to
the failure being analyzed).

---

## Step 4 — Branch on Classification (R9)

If `RESULT.classification == "plugin-defect"` AND `RESULT.routeToErrorReport ==
true`: jump to **Step 6 — PLUGIN-DEFECT ROUTE**. Skip Step 5 (PRESENT and APPLY)
entirely — no surface edits are appropriate for plugin defects.

Otherwise (`user-code` or `ambiguous`), display the classification and rationale
to the user, then continue to Step 5 (PRESENT and APPLY).

```
Classification: {RESULT.classification}
Rationale:      {RESULT.classificationRationale}
```

If `RESULT.proposals` is empty, report `No actionable hardening proposals — the
failure signal does not point at any of the loaded surfaces.` and exit cleanly
(the trap from Step 1 cleans up the manifest).

---

## Step 5 — PRESENT and APPLY (R7, R8, R10, R12, C9, C10, R-iteration-write)

**Per-iteration contract (R-iteration-write, issue #387) — applies to every pass through the proposal loop:**
1. **Re-read before acting:** At the start of each iteration, re-read `targetFile` from disk. Never rely on an in-memory copy from a previous write.
2. **Write before advancing:** Persist the approved change to disk (via Edit/Write) before presenting the next proposal. Do not accumulate approved changes across proposals and write them together.
3. **No cross-proposal accumulation:** Hold only the current proposal's patch in memory. Clear per-proposal state after each write.
4. **Halt on failure:** If validation or the write itself fails for a proposal, do not silently advance to the next proposal — halt iteration for this proposal and surface the error per 5a.

For each proposal in `RESULT.proposals`, present the full patch preview to the
user. Then use `AskUserQuestion`:

> Proposal {i+1} of {N}: {action} on {surface}
> Target: {targetFile}
> Rationale: {rationale}
>
> Preview:
> ```
> {patch}
> ```
>
> Apply this proposal?

Options: **apply** | **skip** | **cancel**

- **apply** — proceed to validation and write
- **skip** — record the proposal as skipped, continue to the next
- **cancel** — abort the entire skill (no further proposals processed); the
  trap cleans up the manifest

### 5a. Validate Before Write (R12, R-iteration-write)

**Re-read `targetFile` from disk now** (implements R-iteration-write rule 1) — do not use any in-memory state from a prior iteration.

When the user selects **apply**, validate the proposed change BEFORE writing:

- For `surface == "plan-guardrails"` or `"execute-guardrails"`: the target is
  `.sdlc/config.json`. Construct the prospective merged JSON in memory, then
  validate via the canonical guardrails validator:

  ```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

# resolve_script is sourced once at Step 1; re-source here if running in a fresh shell block
VALIDATOR="$SDLC_ROOT/scripts/ci/validate-guardrails.js"
[ ! -f "$VALIDATOR" ] && { echo "ERROR: Could not locate scripts/ci/validate-guardrails.js. Is the sdlc plugin installed?" >&2; exit 2; }
  
```

  Run the validator against the prospective config. On non-zero exit, surface
  the validator's error to the user and use AskUserQuestion to offer **retry**
  (let user adjust the patch inline) or **cancel** (skip this proposal). Never
  silently commit a schema-invalid edit.

- For `surface == "review-dimensions"`: validate the prospective dimension file
  against `schemas/review-dimension.schema.json` via
  `lib/dimensions.js::validateDimensionFile`. Same retry/cancel handling on
  failure.

- For `surface == "copilot-instructions"`: no schema — apply the edit directly
  after the user's `apply` answer.

### 5b. Write After Validation Passes (R-iteration-write)

**Write to disk now, before advancing to the next proposal** (implements R-iteration-write rule 2). Do not proceed to the next AskUserQuestion until this proposal's change has been persisted.

Use Edit (preferred) or Write to apply the approved, validated change to
`proposal.targetFile`. Display a one-line confirmation:

```
Applied {action} on {surface} → {targetFile}
```

Severity vocabulary per surface is canonical in `lib/dimensions.js` (`VALID_SEVERITIES`, `GUARDRAIL_SEVERITIES`); see spec R10 + R17. The orchestrator already chose the correct vocabulary in its proposal — never substitute one for the other.

**When `proposal.action === "consolidate"` (R15):** the proposal targets an existing guardrail by id. Read the current `.sdlc/config.json` from disk, locate the guardrail in `<section>.guardrails[]` by the id specified in the proposal's `patch`, and replace its fields with the proposal's merged values (description, severity). Do NOT remove fields; do NOT lower severity (strengthen-only invariant — see spec R8 / C9). If no guardrail with the target id exists in the current file, treat the proposal as malformed and surface to the user.

Note: `consolidate` is validated like `strengthen` — the prospective merged config must pass `validate-guardrails.js` before write.

### 5c. Ambiguous upstream-report offer (R-ambig-offer, issue #288)

When `RESULT.classification === "ambiguous"` AND
`RESULT.errorReportPayload != null`, the orchestrator concluded the failure
*may* be a plugin defect even though the evidence was not strong enough to
classify it as one. After the per-proposal apply/skip flow above completes,
read `pluginRepoUrl` from `MANIFEST_FILE` (the field is at the top level of
the manifest JSON), then present an opt-in upstream-report offer:

> This failure may also be a plugin defect. File a GitHub issue at
> `<pluginRepoUrl>`?

Use AskUserQuestion with options: **dispatch error-report-sdlc** | **skip**.

- On `dispatch error-report-sdlc`: Glob `**/error-report-sdlc/REFERENCE.md`,
  follow it, and dispatch with the orchestrator-supplied
  `RESULT.errorReportPayload` fields (same shape and idiom as Step 6 — no
  duplicate dispatch logic).
- On `skip`: record the skip in Step 7 Learning Capture and exit cleanly.

The strengthen-only invariant is preserved — no surface is auto-edited; the
user explicitly approves the dispatch. When `RESULT.errorReportPayload == null`
on `ambiguous` (pure user-code ambiguity), this sub-step is suppressed entirely
— do not surface the prompt.

---

## Step 6 — PLUGIN-DEFECT ROUTE: Dispatch error-report-sdlc (R9)

When `RESULT.classification == "plugin-defect"`:

1. Read `pluginRepoUrl` from `MANIFEST_FILE` (top-level field). Display
   `RESULT.errorReportPayload` to the user as the proposed
   `error-report-sdlc` dispatch payload, naming the target repository as
   `<pluginRepoUrl>` (sourced from the prepare-script manifest, not
   hardcoded in this SKILL).
2. Use AskUserQuestion: **dispatch error-report-sdlc** | **cancel**.
3. On `dispatch error-report-sdlc`: Glob `**/error-report-sdlc/REFERENCE.md`,
   follow it, and dispatch with `skill=<failure.skill>`,
   `step=<failure.step>`, `operation=<failure.operation>`,
   `error=<failure.text>`, `exit-or-http-code=<failure.exitCode>`,
   `error-type=<failure.errorType or "script crash">`. This matches the
   canonical Glob-then-follow idiom used elsewhere in the plugin (e.g.,
   `review-sdlc/SKILL.md` Step 0 error path).
4. Do NOT edit any user-side hardening surface in the plugin-defect path. The
   no-silent-write invariant applies here too — the user must explicitly
   approve the error-report dispatch.

The trap from Step 1 cleans up the manifest on every exit path.

---

## Step 7 — Learning Capture

Append a single line to `.sdlc/learnings/log.md` summarizing the hardening
action:

```
## YYYY-MM-DD — harden-sdlc: <classification> for <failure.skill> at <failure.step>
Applied: <count> proposal(s) across <surface-list> | Skipped: <count> | Routed: <yes|no>
AmbiguousOffer: <not-applicable|offered-dispatched|offered-skipped>
Trigger: <first 80 chars of failure.text>
Dimensions: <comma-separated dimension names that were created or modified>
```

The `Dimensions:` line MUST be included **only when `<surface-list>` includes
`review-dimensions`** (i.e., at least one review-dimension file was created or
modified during this hardening run). When `review-dimensions` is NOT in the
surface-list, the `Dimensions:` line MUST be omitted entirely — do not emit it
with an empty value.

This line exists so that plan-sdlc's G17 Dimension Coverage gate (R31 in
`docs/specs/plan-sdlc.md`, Fixes #417) can deterministically suppress duplicate
dimension proposals on subsequent runs within the same PR commit window. G17
greps the last 100 lines of `.sdlc/learnings/log.md` for recent `harden-sdlc`
entries whose `Dimensions:` line names the candidate dimension, and defers the
proposal when a match is found.

The `AmbiguousOffer` line records the Step 5c outcome:

- `not-applicable` — classification was not `ambiguous`, OR was `ambiguous` with
  `errorReportPayload == null` (no plugin evidence; offer suppressed).
- `offered-dispatched` — Step 5c offered the upstream-report and the user chose
  `dispatch error-report-sdlc`.
- `offered-skipped` — Step 5c offered the upstream-report and the user chose
  `skip`.

Mirror the append pattern used by `commit-sdlc` and `execute-plan-sdlc`. Create
the `.sdlc/learnings/` directory and `log.md` file if they don't exist.

---

## DO NOT

- Edit any surface without an `apply` AskUserQuestion answer recorded for that
  specific proposal — the no-silent-write invariant is non-negotiable.
- Accumulate approved changes across multiple proposals and write them together
  — each approved proposal MUST be written to disk immediately before advancing
  to the next proposal (R-iteration-write, issue #387).
- Propose relaxing or removing existing rules — v1 is strengthen-only.
- Run full-suite or wide-subset `promptfoo eval` automatically — single targeted test scoped to the change is allowed; tight-loop retries are not.
- Invoke `error-report-sdlc` for `user-code` classifications — only the
  `plugin-defect` branch routes there.
- Read the full manifest contents into the main context — Step 2 reads only
  `failure.*` and `classification_hint`; the orchestrator owns the rest.
- Auto-dispatch this skill from a caller skill without explicit user selection
  in the caller's failure-handling menu.
- Recursively dispatch this skill on its own prepare-script or orchestrator
  crash — log the failure and stop.
- Override severity vocabulary chosen by orchestrator (see R10/R17) — each surface has its own canonical vocabulary in `lib/dimensions.js`; never substitute one for the other.

---

## When This Skill Is Invoked

- **Standalone:** `/harden-sdlc --failure-text "..." --skill plan-sdlc --step "Step 5" --operation "reviewer-loop"`
- **Caller-dispatched:** Caller-dispatched skills present an opt-in menu option at their failure surfaces that dispatches `Skill(harden-sdlc)` with the same flag shape; see spec I1 for the canonical list and dispatch contract. `ship-sdlc` is intentionally NOT a caller — it delegates failure handling to its sub-skills, so harden-sdlc reaches the user through whichever sub-skill failed.

---

## See Also

- `docs/specs/harden-sdlc.md` — behavioral spec (source of truth)
- `docs/skills/harden-sdlc.md` — usage reference for end users
- `plugins/sdlc-utilities/agents/harden-orchestrator.md` — orchestrator agent
- `plugins/sdlc-utilities/scripts/skill/harden-prepare.js` — surface loader
- [`/error-report-sdlc`](../error-report-sdlc/SKILL.md) — plugin-defect route
- [`/setup-sdlc`](../setup-sdlc/SKILL.md) — initial guardrail/dimension authoring
