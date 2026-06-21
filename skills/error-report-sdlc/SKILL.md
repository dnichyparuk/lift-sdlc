---
name: error-report-sdlc
description: "Internal skill invoked by other SDLC skills when they encounter an actionable error (script crash, CLI failure, persistent API error, build failure after retries). Proposes creating a GitHub issue in dnichyparuk/lift-sdlc to track the error with full context capture, two-gate user consent, and pre-flight verification. NOT user-invocable — only dispatched from within another skill's error handling path. When dispatched, follow ./resources/REFERENCE.md for the full procedure."
user-invocable: false
disable-model-invocation: true
model: gemini-3.5-flash-medium
---

# Error-to-GitHub Issue Proposal

<!-- disable-model-invocation: true prevents the harness from auto-triggering this skill
     when conversation content matches the description. It does NOT prevent explicit
     dispatch from another skill's error-handling path — that is the only intended
     activation route. user-invocable: false hides the skill from the / menu. -->

Internal procedure invoked by SDLC skills when an actionable error occurs.
Captures error context, verifies gh CLI availability, gets user consent, and
creates a tracking issue in `dnichyparuk/lift-sdlc` using the gh CLI.

The skill body runs in the main parent-model context. The heavy work — assembling
the issue title and body from the error context and the `templates/ToolingError.md`
template — is dispatched to the dedicated `error-report-orchestrator` agent so the
main conversation transcript is never inherited (issue #202). Both consent gates
and the `gh issue create` call stay in the main context.

## When This Skill Is Invoked

Another skill explicitly directs Antigravity here after encountering an issue-worthy
error. The calling skill provides:

- **Skill**: which skill encountered the error
- **Step**: which step/operation failed
- **Operation**: what was being attempted
- **Error**: full error details (exit code, message, HTTP status)
- **Suggested investigation**: skill-specific diagnostic hints

## Procedure

The full procedural narrative — error classification (issue-worthy vs not),
pre-flight verification, two-gate consent flow, template, and the `gh issue create`
sequence — lives in `./resources/REFERENCE.md`. The implementation flow below resolves
sections from resources/REFERENCE.md and dispatches the orchestrator.

### Step 1 — Classify and Pre-flight (main context)

Follow resources/REFERENCE.md sections 1 (Error Classification) and 2 (Pre-flight Verification)
in the main context. If the error is NOT issue-worthy, or any required pre-flight
check fails, return to the calling skill's normal error handling immediately. Do
not run the prepare script, do not dispatch the orchestrator.

### Step 2 — Consent Gate 1: Offer (main context)

Follow resources/REFERENCE.md section 3 verbatim. Use `AskUserQuestion`. The prompt MUST run
in the main context (not inside the orchestrator agent) — the user's consent is
required before any further work, including running the prepare script.

**On `no`:** Return to the calling skill's normal error handling. Do not proceed.

**On `yes`:** Continue to Step 3.

### Step 3 — Run the Prepare Script (main context)

> **VERBATIM** — Execute this script directly using its absolute path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin). Do NOT prepend `bash` or `sh`. Do not modify, rephrase, or simplify the commands.

```shell
<PLUGIN_ROOT>/skills/error-report-sdlc/scripts/prepare_report.sh
```
> **Contract (Input/Output):**
> - **Input**: Error text and skill context.
> - **Output**: Prints JSON structure for GitHub issue submission.

Substitute the shell variables with the values supplied by the calling skill. Optional
fields (`exitOrHttpCode`, `errorType`, `userIntent`, `argsString`,
`suggestedInvestigation`) may be empty; the script tolerates empty values and the
orchestrator will omit dependent template sections.

**On `EXIT_CODE != 0`:**

- Exit code 1: required field missing — show the script's stderr message and stop.
- Exit code 2: prepare script crashed — show the stderr and stop. Do **not** recursively dispatch this skill on its own crash.

### Step 4 — Dispatch the error-report-orchestrator Agent

Issue #202: pinning `model:` in skill frontmatter routes the skill into a subagent
that inherits the entire conversation transcript and overflows smaller-window
models on long sessions. To keep the main context clean and bound the
orchestrator's input to the prepared payload only, dispatch the dedicated
`error-report-orchestrator` agent. See
`docs/skill-best-practices.md` → "Why frontmatter `model:` is the wrong
context-isolation knob" for the rationale.

Use the `Agent` tool with:

- `subagent_type`: `sdlc:error-report-orchestrator`
- `model`: `gemini-3.5-flash-low` (the Agent tool `model:` parameter takes precedence over agent frontmatter; passing `gemini-3.5-flash-low` here keeps this bounded task on a lightweight model regardless of the parent context's model)
- `prompt` (exactly two lines, no other content):

  ```text
  MANIFEST_FILE: <ERROR_CONTEXT_FILE>
  PROJECT_ROOT: <cwd>
  ```

  Substitute `<ERROR_CONTEXT_FILE>` with the absolute temp-file path captured in
  Step 3. Substitute `<cwd>` with the current working directory.

The orchestrator reads the manifest, reads
`skills/error-report-sdlc/templates/ToolingError.md`, fills
every `{placeholder}` strictly from manifest fields, removes sections whose
manifest fields are empty, and returns ONLY a JSON object:

```json
{
  "title": "<assembled title>",
  "body": "<filled markdown body>"
}
```

The orchestrator does not call `gh`, does not call `git`, does not write any file.

Capture the returned object as `PROPOSAL = { title, body }`. If the parse fails, stop. The `trap` declared at Step 1 cleans up `$ERROR_CONTEXT_FILE` automatically on shell exit.

### Step 5 — Consent Gate 2: Review (main context)

Follow resources/REFERENCE.md section 5 verbatim. Display `PROPOSAL.title` and
`PROPOSAL.body` to the user along with the labels (`tooling-error` plus the
calling skill's name) and the priority. Use `AskUserQuestion` for the
`yes / edit / cancel` choice.

**On `edit`:** Apply the requested changes to `PROPOSAL.title` and / or
`PROPOSAL.body` in the main context (do not re-dispatch the orchestrator for
small edits) and re-present.

**On `cancel`:** Return to the calling skill's normal error handling. Do not
create anything. The `trap` declared at Step 1 cleans up `$ERROR_CONTEXT_FILE`
automatically on shell exit.

**On `yes`:** Continue to Step 6.

### Step 6 — Create the GitHub Issue (main context)

Follow resources/REFERENCE.md section 6 verbatim. The `gh issue create` call MUST run in the
main context — the orchestrator agent has no `Bash` tool and is forbidden from
invoking `gh`.

```bash
gh issue create \
  --repo "dnichyparuk/lift-sdlc" \
  --title "$PROPOSAL_TITLE" \
  --body "$PROPOSAL_BODY" \
  --label "tooling-error" \
  --label "$SKILL_NAME"
```

Apply the missing-label fallback (`gh label create … || true`) and retry per
resources/REFERENCE.md section 6a. On success, report the issue number and URL per 6b. On
failure after the retry, report the error per 6c.

### Step 7 — Cleanup and Return (main context)

The `$ERROR_CONTEXT_FILE` is removed automatically by the `trap` declared at Step 1 on every exit path — no explicit cleanup is needed here.

Return to the calling skill's normal error handling per resources/REFERENCE.md
section 7. The cleanup runs on every exit path (success, failure, cancel, edit
loop exit).

## DO NOT

- Invoke this skill directly in response to user requests — it is internal only.
- Pin `model:` in this skill's frontmatter — the harness will route the skill into a
  subagent that inherits the full conversation transcript (issue #202). The
  orchestrator agent (Step 4) is the correct place to pin `model: gemini-3.5-flash-low`.
- Run consent gates inside the orchestrator agent. Both gates (Section 3 and
  Section 5) MUST execute in the main context.
- Run `gh issue create` inside the orchestrator agent. The agent has no `Bash`
  tool. Posting MUST run in the main context.
- Create a GitHub issue without both consent gates passing.
- Block or replace the calling skill's normal error handling.
- Create issues in a repository other than `dnichyparuk/lift-sdlc`.
- Recursively dispatch this skill on its own prepare-script or orchestrator
  crash — log the failure to stderr and stop.
