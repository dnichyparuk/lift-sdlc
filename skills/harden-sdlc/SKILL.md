---
name: harden-sdlc
description: "Use this skill after an SDLC pipeline failure to analyze hardening surfaces (plan and execute guardrails, review dimensions, copilot instructions) and propose user-approved edits that would prevent the same class of failure next time. Strengthen-only in v1 — never relaxes or removes existing rules. Required arguments: --failure-text <string> --skill <caller-name>. Optional: --step, --operation, --exit-code, --error-type, --user-intent, --args-string. Triggers on: harden, strengthen guardrails, prevent this failure, learn from this failure, after pipeline failure."
user-invocable: true
argument-hint: "--failure-text <text> --skill <name> [--step <s>] [--operation <op>]"
model: gemini-3.8-flash-high
---

# Hardening After a Pipeline Failure

This skill runs after an SDLC pipeline failure to propose user-approved edits to
the project's hardening surfaces (plan guardrails, execute guardrails, review
dimensions, copilot instructions) so the same class of failure is caught earlier
next time. Implements `docs/specs/harden-sdlc.md`.

**Announce at start:** "I'm using harden-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

---

## Step 0 — Parse Arguments

**Mutually exclusive primary inputs:**

| Mode | Flag | Required when |
|---|---|---|
| Inline failure text | `--failure-text <string>` | Always, unless `--from-issue` is used |
| GitHub issue fetch | `--from-issue <num>` | Alternative to `--failure-text` |

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

## Step 1 — CONSUME: Run the Prepare Script

> **VERBATIM** — Execute this command directly with `node` and the absolute plugin path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin. Note the strict CLI location pattern: `<PLUGIN_ROOT>/scripts/<skill|util|lib>/<script-name>.js`). Do not modify, rephrase, or simplify the flags.

```shell
MANIFEST_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/harden-prepare.js" \
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
```
> **Contract (Input/Output):**
> - **Input**: Failure text context, passed as the flags above. `--failure-text` and `--from-issue` are mutually exclusive — emit exactly one of them.
> - **Output**: Prints the path of a temp file holding the JSON manifest of hardening targets; captured here as `MANIFEST_FILE`, with the command's exit status as `EXIT_CODE_PREPARE`.

Substitute the shell variables with values from the parsed arguments. Empty
values for optional fields are tolerated.

**On non-zero `EXIT_CODE_PREPARE`:**

- Exit code 1: required field missing — show the script's stderr and stop.
- Exit code 2: prepare script crashed — show stderr and stop. Do **not**
  recursively dispatch this skill on its own crash; this is a plugin defect and
  belongs in `error-report-sdlc`.

---

## Step 2 — CLASSIFY: Surface the Failure Classification

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

When `classification_hint == "plugin-defect"` (see Step 0), skip Step 3 —
proceed directly to Step 4, which routes to Step 6 without dispatching the
orchestrator.

Otherwise, the orchestrator (Step 3) is the authoritative classifier. Continue
to Step 3.

---

## Step 3 — ANALYZE: Dispatch the harden-orchestrator Agent

Use the `Agent` tool with:

- `subagent_type`: `sdlc:harden-orchestrator`
- `model`: `gemini-3.8-flash-low`
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
the raw response to the user — do not retry.

---

## Step 4 — Branch on Classification

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

## Step 5 — PRESENT and APPLY

**Per-iteration contract — applies to every pass through 5, 5a, and 5b:**
1. **Re-read before acting:** at the start of each iteration, re-read `targetFile` from disk. Never rely on an in-memory copy from a previous write.
2. **Write before advancing:** persist the approved change to disk before presenting the next proposal. Never accumulate approved changes across proposals and write them together.
3. **No cross-proposal accumulation:** hold only the current proposal's patch in memory; clear it after each write.
4. **Halt on failure:** if validation or the write itself fails, do not silently advance — halt for this proposal and surface the error per 5a.

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

- **apply** — proceed to validation and write (5a)
- **skip** — record the proposal as skipped, continue to the next
- **cancel** — abort the entire skill (no further proposals processed); the
  trap cleans up the manifest

### 5a. Validate Before Committing

When the user selects **apply**, write the proposed merged content to a
sibling temp path — `<target>.harden-tmp` — and validate that temp path
before it ever touches the real file, so `.sdlc/config.json` (or the
dimension file) is never transiently invalid:

- For `surface == "plan-guardrails"` / `"execute-guardrails"` (target
  `.sdlc/config.json`): write the merged config to
  `.sdlc/config.json.harden-tmp`, then validate that temp path — pass the
  section being changed (`plan` or `execute`, from the proposal's surface)
  as `--section`, so validation actually checks the guardrail that was
  proposed:

  ```shell
  SECTION=plan            # or: execute  (from proposal.surface)
  node "<PLUGIN_ROOT>/scripts/ci/validate-guardrails.js" --config-file ".sdlc/config.json.harden-tmp" --section "$SECTION"
  ```

  On exit 0: `fs.renameSync(tmp, target)` (or `mv`) — this is the only write
  `.sdlc/config.json` ever receives, and it happens only after validation
  passes. On non-zero exit: delete the temp file, surface the validator's
  error, and use AskUserQuestion to offer **retry** (let the user adjust the
  patch inline) or **cancel** (skip this proposal). Never silently commit a
  schema-invalid edit.

- For `surface == "review-dimensions"` (target the dimension file): write the
  merged content to `<targetFile>.harden-tmp`, then validate that temp path:

  ```shell
  node "<PLUGIN_ROOT>/scripts/util/validate-dimension.js" "<targetFile>.harden-tmp"
  ```

  > **Contract (Input/Output):** validates the `.harden-tmp` path as written;
  > exits non-zero if the schema is invalid.

  On success: `fs.renameSync(tmp, target)` (or `mv`) — this is the only write
  the real path ever receives, and it happens only after validation passes.
  On non-zero exit: delete the temp file, surface the validator's error, and
  use AskUserQuestion to offer **retry** (let the user adjust the patch
  inline) or **cancel** (skip this proposal). Never silently commit a
  schema-invalid edit.

- For `surface == "copilot-instructions"`: no schema — apply the edit with
  Edit (preferred) or Write directly.

### 5b. Confirm and Handle Consolidation

Display a one-line confirmation after each write:

```
Applied {action} on {surface} → {targetFile}
```

**When `proposal.action === "consolidate"`:** the proposal targets an existing
guardrail by id. Locate the guardrail in `<section>.guardrails[]` by the id in
the proposal's `patch`, and replace its fields with the proposal's merged
values (description, severity). Do NOT remove fields; do NOT lower severity
(strengthen-only invariant). If no guardrail with the target id exists, treat
the proposal as malformed and surface it to the user. `consolidate` is
validated the same way as `strengthen` in 5a — the merged config must pass
`validate-guardrails.js` before the write stands.

### 5c. Ambiguous upstream-report offer

When `RESULT.classification === "ambiguous"` AND
`RESULT.errorReportPayload != null`, the orchestrator concluded the failure
*may* be a plugin defect even though the evidence was not strong enough to
classify it as one. After the per-proposal loop above completes, read
`pluginRepoUrl` from `MANIFEST_FILE` (top-level field), then present an
opt-in upstream-report offer:

> This failure may also be a plugin defect. File a GitHub issue at
> `<pluginRepoUrl>`?

Use AskUserQuestion with options: **dispatch error-report-sdlc** | **skip**.

- On `dispatch error-report-sdlc`: Glob `**/error-report-sdlc/REFERENCE.md`,
  follow it, and dispatch with the orchestrator-supplied
  `RESULT.errorReportPayload` fields (same shape and idiom as Step 6 — no
  duplicate dispatch logic).
- On `skip`: record the skip in Step 7 Learning Capture and exit cleanly.

---

## Step 6 — PLUGIN-DEFECT ROUTE: Dispatch error-report-sdlc

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
   `error-type=<failure.errorType or "script crash">` (same Glob-then-follow
   idiom used elsewhere in the plugin).
4. Do NOT edit any user-side hardening surface in the plugin-defect path. The
   no-silent-write invariant applies here too — the user must explicitly
   approve the error-report dispatch.

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
modified during this hardening run); omit it entirely otherwise — never emit
it with an empty value. (Consumed by plan-sdlc's G17 gate.)

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

- Edit any surface without an `apply` AskUserQuestion answer recorded for
  that specific proposal — the no-silent-write invariant is non-negotiable.
- Violate the Step 5 per-iteration contract (re-read before acting, write
  before advancing, no cross-proposal state).
- Propose relaxing or removing existing rules — v1 is strengthen-only.
- Run full-suite or wide-subset `promptfoo eval` automatically — single targeted test scoped to the change is allowed; tight-loop retries are not.
- Invoke `error-report-sdlc` for `user-code` classifications — only the
  `plugin-defect` branch routes there.
- Read the full manifest contents into the main context — see Step 1 and
  Step 2.
- Auto-dispatch this skill from a caller skill without explicit user selection
  in the caller's failure-handling menu.
- Recursively dispatch this skill on its own prepare-script or orchestrator
  crash — log the failure and stop.
- Override severity vocabulary chosen by orchestrator — each surface has its own canonical vocabulary in `lib/dimensions.js`; never substitute one for the other.

---

## When This Skill Is Invoked

- **Standalone:** `/harden-sdlc --failure-text "..." --skill plan-sdlc --step "Step 5" --operation "reviewer-loop"`
- **Caller-dispatched:** other skills present an opt-in menu option at their
  failure surfaces that dispatches `Skill(harden-sdlc)` with the same flag
  shape. `ship-sdlc` is not a caller — it delegates failure handling to its
  sub-skills.

---

## See Also

- `docs/specs/harden-sdlc.md` — behavioral spec (source of truth)
- `docs/skills/harden-sdlc.md` — usage reference for end users
- `agents/harden-orchestrator.md` — orchestrator agent
- `scripts/skill/harden-prepare.js` — surface loader
- [`/error-report-sdlc`](../error-report-sdlc/SKILL.md) — plugin-defect route
- [`/setup-sdlc`](../setup-sdlc/SKILL.md) — initial guardrail/dimension authoring
