# `received-review-sdlc` — Fallback Verification & Response Playbook

Reference procedures moved out of `SKILL.md` for fallback feedback gathering, legacy verifier orchestration, pushback examples, error recovery, gotchas, and learning capture.

---

## Step 1b — Manual Feedback Gathering (Fallback)

Runs when no PR number is available, `scripts/skill/received-review.js` is unavailable, or Step 1a exits with code `1`.

Locate the review feedback from one of:
- Findings already in conversation context (e.g., passed in from `/review-sdlc`)
- User paste
- PR URL — fetch with:
  ```bash
  gh pr view <number> --comments
  gh api repos/{owner}/{repo}/pulls/{number}/reviews
  ```

Parse each comment into a structured list:

```
| # | File | Line | Reviewer | Comment | Type |
```

Type classification: `bug`, `style`, `architecture`, `feature-request`, `question`, `unclear`.

---

## Step 3a — Dispatch `received-review-orchestrator` (Fallback when `run_workflow` unavailable)

Runs when `MANIFEST_FILE` from Step 1a exists and `run_workflow` (`workflows/verify.py`) is unavailable. The orchestrator is defined at `agents/received-review-orchestrator.md`. It groups outstanding threads by file path, dispatches verifier subagents in parallel in isolated contexts, persists `<MANIFEST_FILE minus .json>.verification.md` to disk, and returns a bounded `VERIFY_SUMMARY` token.

Dispatch a single Subagent using `invoke_subagent`:

```json
{
  "Subagents": [
    {
      "TypeName": "received-review-orchestrator",
      "Role": "Received-Review Verification Orchestrator",
      "Model": "flash",
      "Prompt": "MANIFEST_FILE: {MANIFEST_FILE from Step 1a}\nPROJECT_ROOT: {current working directory}\nPLUGIN_ROOT: {PLUGIN_ROOT}\nONLY_IDS: none"
    }
  ]
}
```

**Parse the response:** Derive `OUTSTANDING_IDS` — the JSON array of `id` values for every `status: "outstanding"` thread — from the Step 1a manifest read earlier (not from the dispatch Prompt, which embeds no thread IDs). Write the orchestrator's full response to a temp file (`$TMPFILE`), then pipe it through `parse-verify.js` via stdin redirect (avoiding here-strings, which can truncate large outputs):

```shell
printf '%s' "$ORCHESTRATOR_OUTPUT" > "$TMPFILE"
node "<PLUGIN_ROOT>/scripts/util/parse-verify.js" --dispatched-ids '<json-array-of-outstanding-thread-ids>' < "$TMPFILE"
```

Read `schemaOk`, `missingIds`, and `parsed` from the result. Check `missingIds` first regardless of `schemaOk` — non-empty `missingIds` always takes the missing-IDs branch before the schema-violation branch:

| Condition | Behaviour |
|---|---|
| `schemaOk` true, `missingIds` empty | Map statuses; proceed to Step 4 |
| `missingIds` non-empty (first time), regardless of `schemaOk` | Re-dispatch orchestrator once with `ONLY_IDS: <missingIds joined by ,>`; merge results |
| `missingIds` non-empty after re-dispatch | Mark those threads `cannot-verify` with reasoning `verification agent did not report`; existing cannot-verify rule applies |
| `missingIds` empty, `schemaOk` false | Re-dispatch once with a format reminder appended to the Prompt; if still invalid, fall back to Step 3b for all threads |
| Agent error / no response | Retry once with identical inputs; second failure → Step 3b |
| `parse-verify.js` exit 2 | Invoke `error-report-sdlc` (`skill=received-review-sdlc`, `step=Step 3a`, `operation=parse-verify.js`) and stop |

**Map `parsed.findings[].verificationStatus` to Step 4 vocabulary** (Step 4 and Step 10 display the verdict vocabulary `agree, will fix` / `agree, won't fix` / `disagree` / `needs discussion`, not these five internal labels verbatim):

| `verificationStatus` | Prose label |
|---|---|
| `confirmed` | confirmed |
| `confirmed-incomplete` | confirmed, but suggestion is incomplete |
| `incorrect` | incorrect |
| `partially-correct` | partially correct |
| `cannot-verify` | cannot verify |

For "cannot verify" items: state the limitation explicitly and ask the user for direction.

Step 4 reads `verificationStatus`, `reasoning`, and `evidence` for each finding from the parsed token, and opens `reportFile` only for findings it will push back on or mark `needs discussion`. A finding with at least one `evidence` entry (or an explicit `cannot-verify` status) satisfies Step 5's "Verification completeness" gate.

---

## Step 3b — Inline Verification (Fallback)

Runs when no `MANIFEST_FILE` exists (the Step 1b fallback path), when `verify.py` exits `1` (no PR found), or after two orchestrator dispatch failures in Step 3a.

For each feedback item, gather context beyond the immediate change diff:

1. **Read the referenced code** — understand what the code actually does. Use `node "<PLUGIN_ROOT>/scripts/util/outline-file.js" <file>` or dispatch a subagent instead of reading large files directly.
2. **Trace callers and dependents** — use LSP references or grep to find callers, importers, and downstream impact of the suggested change.
3. **Check architectural context** — read related modules, interfaces, and tests to understand design intent.
4. **Evaluate ripple effects** — determine whether the suggested change breaks or improves behavior beyond the diff.

Determine the verification status:
- **confirmed** — reviewer's claim is correct, and the suggestion works in full context
- **confirmed, but suggestion is incomplete** — the issue is real, but the proposed fix has side effects or misses related code
- **incorrect** — reviewer is wrong about what the code does
- **partially correct** — some aspects correct, some not
- **cannot verify** — would need runtime data or external context (state the limitation explicitly and ask the user for direction)

---

## Configuration Examples (`.sdlc/local.json`)

Both `receivedReview.alwaysFixSeverities` and `receivedReview.alwaysHardenFromReview` are **local-only** (gitignored, per-user in `.sdlc/local.json`; never `.sdlc/config.json`). Configure interactively with `/setup-sdlc --only received-review`.

```json
{
  "receivedReview": {
    "alwaysFixSeverities": ["critical", "high"],
    "alwaysHardenFromReview": true,
    "hardenClusterCap": 5
  }
}
```

---

## Step 7 & Step 11 — Pushback Playbook & Examples

**Response structure per item:**
1. Factual acknowledgment of what was said (no performative openers).
2. What will be done OR technical reason for disagreement.
3. If implementing: brief description of approach.

**Pushback template:**
```
Checked [specific code location]. [What it actually does]. [Consequence of the suggested change].
Decision: [keeping as-is / discussing with owner / needs more context].
```

**Examples:**
- **Pushback (disagree):**
  - *Wrong:* "Great catch! Thanks for pointing that out, though I'd actually prefer to keep this as-is because it seems fine."
  - *Right:* "Checked `scripts/skill/received-review.js:104-112`. Unrecognized severity strings are already stripped with a stderr warning before the manifest emits `flags.alwaysFixSeverities`. Moving validation into `SKILL.md` would duplicate the parser and re-read `.sdlc/local.json`. Decision: keeping as-is."
- **Gracefully correcting wrong pushback (Step 11):**
  - *Right:* `"You were right — I checked [X] and it does [Y]. Implementing now."`
  - *Wrong:* Long apology, defensive explanation, or over-explaining. State the correction factually and move on.

---

## Error Recovery

> **Flow**: detect → diagnose → auto-recover (retry once if transient) → invoke `error-report-sdlc` for persistent actionable failures.

| Error | Recovery | Invoke `error-report-sdlc`? |
|---|---|---|
| `gh pr view` or `gh api` fails to fetch PR comments | Check `gh auth status`; show error; ask user to supply feedback directly | No — auth or permissions issue |
| Comment references file/line that no longer exists | Note the discrepancy; verify against current HEAD diff | No — expected with rebased PRs |
| Cannot verify reviewer's claim (no runtime data/external context) | State limitation explicitly; ask user for direction | No — expected limitation |
| `gh api` 5xx or unexpected server error when posting reply | Retry once; if still failing, show drafted response for manual posting | Yes if second attempt also fails |
| `skill/received-review.js` exit `2` (script crash) | Show stderr output, invoke `error-report-sdlc` | Yes |
| `received-review-orchestrator` dispatch error or no response (Step 3a) | Retry once with identical inputs; second failure → Step 3b | No — unless `parse-verify.js` exits `2`, then yes |
| GraphQL resolve mutation fails | Retry once; if still failing, list unresolved threads | Yes if second attempt fails |
| Thread ID not found during resolve | Skip that thread, warn user | No — expected with race conditions |

When invoking `error-report-sdlc` for Step 11/12 reply failures, provide:
- **Skill**: `received-review-sdlc`
- **Step**: `Step 11 — IMPLEMENT` (posting GitHub thread replies, only after user consent in Step 10)
- **Operation**: `gh api` call to post comment reply
- **Error**: HTTP status + error message
- **Suggested investigation**: Check `gh auth status`; verify PR number is accessible; confirm repo permissions

---

## Gotchas

- **Contradictory comments across threads:** Flag the contradiction and ask for clarification rather than guessing which comment was intended.
- **Comments on deleted lines:** Verify against current `HEAD`, not the diff context shown in the review.
- **Re-running after partial reply:** The prepare script detects self-replied threads and skips them, preventing duplicate replies.
- **GraphQL thread IDs vs REST comment IDs:** The reply endpoint uses REST `databaseId` (`comment.databaseId`), while the resolve mutation uses GraphQL thread `id` (`thread.id`). Both are present in the manifest.

---

## Learning Capture

After processing review feedback, append discoveries to `.sdlc/learnings/log.md` (reviewer patterns, pushback outcomes, unclear feedback gaps, YAGNI findings, or codebase facts uncovered during verification).

**Structured Changeset Capture (`capture-learning.js`):**
If a reviewer comment highlights a generalizable rule, missing boundary check, recurring anti-pattern, or architectural convention worth enforcing:
1. Prepare JSON:
   `{"signature": "<kebab-case-id>", "rationale": "<text>", "evidence": "<text>", "impact": "<low|medium|high>", "sourceSkill": "received-review-sdlc"}`
2. Write JSON to a temp file in `os.tmpdir()`, run `capture-learning.js`, and remove the temp file:
   ```bash
   node "<PLUGIN_ROOT>/scripts/util/capture-learning.js" --file "<temp-file>" 2>/dev/null || true
   rm -f "<temp-file>"
   ```
3. Always use `2>/dev/null || true` — capturing is best-effort, non-blocking, and must never fail review processing.
