---
name: received-review-sdlc
description: "Use this skill when responding to code review feedback on a pull request or inline reviewer comments. Covers reading, verifying, evaluating, and responding to reviewer comments with a dual self-critique gate — prevents performative agreement and ensures technical rigor. Can be launched manually or automatically after /review-sdlc. Triggers on: process review feedback, respond to review, handle review comments, address PR feedback, fix review findings, received-review."
user-invocable: true
argument-hint: "[--pr <number>] [--auto]"
model: gemini-3.8-flash-high
---

# Responding to Code Review Feedback

Process reviewer comments with technical rigor. Each item is verified against the full
codebase context — not just the change diff — before any response is drafted. Internal
self-critique gates ensure quality. No changes are made until the user explicitly approves
the proposed action plan.

**Announce at start:** "I'm using received-review-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

---

## Context Optimization Constraints

To prevent context bloat and token exhaustion:
1. **Targeted File Reads:** Avoid reading entire large codebase files directly into memory. When gathering context, use `node "<PLUGIN_ROOT>/scripts/util/outline-file.js" <file>` to extract file structure (classes, interfaces, functions) instead of using the `view_file` tool on massive files.
2. **Enforced Parallelism:** If you need to execute multiple exploration commands, process multiple review items, or read multiple files, you MUST batch them in a single JSON tool call array rather than waiting for each to finish sequentially.
3. **Strict Thought Protocol:** Do not return an empty chat response just to explain intermediate thoughts or internal self-critiques. All internal reasoning must remain in the `thought` block. You must execute the next logical step immediately.
4. **Truncated Test Outputs:** When verifying changes (compiling, tests, linting) or running package manager commands (e.g., npm, pnpm, pnpm build, yarn), ALWAYS use the truncated runner: `node "<PLUGIN_ROOT>/scripts/util/run-truncated.js" "<command>"`.

## Configuration

### `receivedReview.alwaysFixSeverities`

Per-user, per-project allowlist of finding severities whose **"agree, will fix"** verdicts bypass
the per-finding consent gate in Step 10 (PRESENT) and Step 12 (REPLY & RESOLVE).

- **Location:** `.sdlc/local.json` under `receivedReview.alwaysFixSeverities` (gitignored, per-user).
  This field is **local-only** — it MUST NEVER be set in `.sdlc/config.json`. The prepare script
  emits a stderr warning and ignores the value if it appears in project config.
- **Type:** `string[]` — array of severities; allowed values: `low | medium | high | critical`.
- **Default:** `[]` — preserves the original consent-on-every-finding behavior.
- **Resolution site:** the prepare script `skill/received-review.js` resolves the field once and
  emits it as `flags.alwaysFixSeverities` in the manifest. All decision sites in this SKILL.md
  cite `flags.alwaysFixSeverities` only — never re-read configuration.

**Example (`.sdlc/local.json`):**

```json
{
  "receivedReview": {
    "alwaysFixSeverities": ["critical", "high"]
  }
}
```

**Bypass rule:** A finding auto-applies — no consent prompt, logged as `fixed: <description>` —
when **all three** hold: verdict is `agree, will fix`, parsed severity is non-null, and
severity ∈ `flags.alwaysFixSeverities`. A finding with `severity: null` (unparseable from the
comment body) **NEVER** bypasses the gate, regardless of the list.

**`--auto` interaction:** When `flags.alwaysFixSeverities` is **empty** (default), `--auto`
auto-applies/resolves **all** "agree, will fix" findings/threads in Steps 11/12, regardless of
severity — the original, backward-compatible behavior. When **non-empty**, `--auto`
implements/resolves only bypass-eligible findings/threads (per the rule above); the rest are
collected into a **follow-up summary** (Step 11) and left replied-but-unresolved (Step 12).

To configure interactively, run `/setup-sdlc --only received-review`.

### `receivedReview.alwaysHardenFromReview`

Per-user flag: when `true`, Step 11.6 dispatches `Skill(harden-sdlc)` per cluster without a
consent prompt.

- **Location:** `.sdlc/local.json` under `receivedReview.alwaysHardenFromReview` — local-only,
  gitignored, per-user; MUST NEVER be set in `.sdlc/config.json` (the prepare script warns
  and ignores it there).
- **Type:** `boolean` — default `false`.

**Auto-mode matrix (all four cells authoritative — resolved as `mode` by `received-review-cluster.js`, never re-derived from raw `$ARGUMENTS` or config):**

| `flags.auto` | `flags.alwaysHardenFromReview` | `mode` | Step 11.6 behavior |
|---|---|---|---|
| `false` | `false` | `interactive-consent` | Present consent gate per cluster → dispatch approved clusters only. |
| `false` | `true`  | `interactive-always`  | Skip consent gate → dispatch every cluster (capped at `hardenClusterCap`). |
| `true`  | `false` | `auto-defer`          | Skip consent gate AND skip dispatch entirely → append deferred-action entry to `.sdlc/learnings/log.md`. |
| `true`  | `true`  | `auto-always`         | Skip consent gate → dispatch every cluster (capped), propagating `--auto` to every dispatch. |

**Example `.sdlc/local.json`:**
```json
{
  "receivedReview": {
    "alwaysHardenFromReview": true,
    "hardenClusterCap": 5
  }
}
```

### `receivedReview.hardenClusterCap`

Maximum number of harden-sdlc clusters dispatched per Step 11.6 run.

- **Location:** `.sdlc/local.json` under `receivedReview.hardenClusterCap`.
- **Type:** `integer` — default `5`, clamped to `[1, 50]`.
- Excess clusters beyond the cap are suppressed and logged as `suppressed: N additional clusters`
  in the deferred-action entry or the learning-log dispatch record.

---

## Step 0 — Plan Mode Check

If the system context contains "Plan mode is active":

1. Announce: "This skill requires write operations (file edits, gh api calls). Exit plan mode first, then re-invoke `/received-review-sdlc`."
2. Stop. Do not proceed to subsequent steps.

---

## Step 1 — READ: Gather Review Feedback

### Step 1a — Run skill/received-review.js (when PR number available)

When a PR number or URL is provided (via arguments or user input), run the prepare script to pre-compute review thread state:

```shell
MANIFEST_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/received-review.js" --output-file $ARGUMENTS)
EXIT_CODE=$?
echo "MANIFEST_FILE=$MANIFEST_FILE"
echo "EXIT_CODE=$EXIT_CODE"
```

> **Contract (Input/Output):**
> - **Input**: No arguments required (automatically infers PR from git branch context).
> - **Output**: Prints the path of a temp JSON manifest of review comments on stdout. On success (exit 0), read `$MANIFEST_FILE` to extract `flags.auto`. On exit 1, no PR found.

**On exit code 0:** Read the manifest JSON at `$MANIFEST_FILE`. Extract `flags.auto` from the manifest and store it as a boolean (defaults to `false` if absent). If `--auto` was passed in `$ARGUMENTS` but not in the manifest, treat it as `true`. Display the incremental summary:

```
Found N outstanding comments (M resolved, K already replied, J stale — skipped).
Processing only the N outstanding comments.
```

Use only threads with `status: "outstanding"` for Steps 2–11. Store the full manifest (including resolved/self-replied/stale threads) for use in Step 12 (PR Reply & Resolve).

**On exit code 1:** No PR found or missing arguments. Fall back to Step 1b.

**On exit code 2:** Script error. Invoke `error-report-sdlc` with:
- **Skill:** received-review-sdlc
- **Step:** Step 1 — READ
- **Operation:** skill/received-review.js execution
- **Error:** stderr output from the script

### Step 1b — Manual feedback gathering (fallback)

When no PR number is available, the prepare script is not found, or Step 1a fails:

Locate the review feedback from one of:
- Findings already in conversation context (e.g. passed in from `/review-sdlc`)
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

## Step 2 — UNDERSTAND: Categorize and Flag

For each item:
- Assign a type from the classification above
- Flag items that are **unclear** (ambiguous intent, missing context, could be interpreted multiple ways)

**CRITICAL:** If ANY item is unclear:
```
STOP — do not implement anything yet.
Ask for clarification on ALL unclear items at once.
WHY: Items may be related. Partial understanding = wrong implementation.
```

Only proceed to Step 3 after all items are understood.

---

## Step 3 — VERIFY: Check Against Full Codebase Context

For each feedback item, gather context beyond the immediate change diff:

1. **Read the referenced code** — understand what the code actually does. **CRITICAL:** Use `node "<PLUGIN_ROOT>/scripts/util/outline-file.js" <file>` or dispatch a subagent instead of natively reading large files.
2. **Trace callers and dependents** — use LSP references or grep to find who calls the changed code, what imports it, and what would be affected by the suggested change
3. **Check architectural context** — read related modules, interfaces, and tests to understand the design intent behind the current implementation
4. **Evaluate ripple effects** — determine whether the suggested change would break or improve behavior beyond the immediate diff

Determine the verification status:
- **confirmed** — reviewer's claim is correct, and the suggestion works in full context
- **confirmed, but suggestion is incomplete** — the issue is real but the proposed fix has side effects or misses related code that also needs updating
- **incorrect** — reviewer is wrong about what the code does
- **partially correct** — some aspects correct, some not
- **cannot verify** — would need runtime data or external context

For "cannot verify" items: state the limitation explicitly, ask the user for direction.

---

## Step 4 — EVALUATE: Assess Each Item

Using verification results, determine for each item:

- **agree, will fix** — technically correct, should be changed
- **agree, won't fix** — correct but out of scope or lower priority (state reason)
- **disagree** — technically incorrect for this codebase (provide reasoning)
- **needs discussion** — architectural impact, requires owner input

**YAGNI check for feature requests:**
```
grep codebase for actual usage
IF unused: "This isn't called anywhere. Remove it (YAGNI)? Or is there usage I'm missing?"
IF used: Then evaluate the suggestion on merit
```

**Source trust:**
- Trusted partner feedback: implement after understanding, skip performative agreement
- External/automated reviewer: verify technically, apply YAGNI, push back if wrong

---

## Step 5 — CRITIQUE #1 / IMPROVE #1: Self-Critique the Evaluation

> **INTERNAL** — Do not display gate results, pass/fail status, or any output from this step to the user. Process silently and proceed to the next step.

Before drafting responses, check the evaluation against each gate below and fix any failure
before moving on (re-read source for incomplete verification, strengthen vague reasoning,
reclassify unsupported assessments). Max 2 iterations per gate.

- **Verification completeness** — no item evaluated without reading relevant source
- **No blind agreement** — not everything marked "agree" unless genuinely correct
- **YAGNI applied** — no "sounds good, will add" for speculative features
- **Unclear items resolved** — nothing implemented on partial understanding
- **Technical grounding** — every agree/disagree decision cites code or behavior, not "seems right"

---

## Step 7 — RESPOND (DO): Draft Responses

Draft a response for each item. Response structure per item:

1. Factual acknowledgment of what was said (no performative openers)
2. What will be done OR technical reason for disagreement
3. If implementing: brief description of approach

**Forbidden openers — NEVER use:**
- "You're absolutely right!"
- "Great point!" / "Excellent feedback!"
- "Thanks for catching that!" / Any gratitude expression
- "Let me implement that now" (before verification)

**Instead, start with the substance:**
- Restate the technical issue
- State the decision (fix / won't fix / disagree)
- Provide reasoning

**Pushback format:**
```
Checked [specific code location]. [What it actually does]. [Consequence of the suggested change].
Decision: [keeping as-is / discussing with owner / needs more context].
```

**GitHub thread replies:** Posted later, in Step 12, in-thread using the comment ID — never as
a top-level PR comment. See Step 12's reply template for the exact command and the
`manifest.reply_footer` rule.

---

## Step 8 — CRITIQUE #2 / IMPROVE #2: Self-Critique the Responses

> **INTERNAL** — Do not display gate results, pass/fail status, or any output from this step to the user. Process silently and proceed to the next step.

Check the drafted responses against each gate below and fix any failure before moving on
(delete performative openers, add missing code references, shorten over-explained simple
fixes). Max 2 iterations per gate.

- **No performative language** — matches Step 7's forbidden-openers rule; substance, not social filler
- **Technically grounded** — every response references specific code, behavior, or constraint — no "this should be fine"
- **Pushback is technical** — disagreements cite code, performance data, or design constraints — no "I prefer" without evidence
- **Thread-level replies** — each response targets its specific comment thread, not a top-level dump
- **Implementation plan clear** — accepted items state what will change
- **No blind agreement** — factual errors corrected, not accommodated
- **Proportional effort** — simple fixes get short responses; complex items get detailed ones

---

## Step 10 — PRESENT: Show Findings and Proposed Plan

This is the first user-visible output after the analysis phase. Present the complete analysis
and proposed actions to the user. **No changes have been made yet.**

**1. Analysis summary table:**

```
| # | File | Line | Type | Verdict | Reasoning |
```

Show every item with its type (bug, style, architecture, etc.) and verdict (agree will fix /
agree won't fix / disagree / needs discussion) with a one-line reasoning summary.

**2. Proposed action plan:**

Group items by action:
- **Will fix:** list items with brief description of the change
- **Will push back:** list items with the core technical reason
- **Needs discussion:** list items with what's unresolved

**3. Drafted PR responses:**

Show the full text of each drafted response, labeled by item number.

**4. Consent gate:**

Apply the **bypass rule** from Configuration → `alwaysFixSeverities`: bypass-eligible
findings are auto-applied with a one-line `fixed: <description>` log entry, no prompt. All
other findings follow the modes below.

**Auto mode** (`flags.auto` true): apply the Configuration → "Bypass rule" / "`--auto`
interaction" behavior — all "agree, will fix" findings when `alwaysFixSeverities` is empty
(default), else only bypass-eligible ones, with the remainder collected into a follow-up
summary. "disagree" / "needs discussion" / "won't fix" items are displayed but NEVER
auto-actioned. Still show the full analysis table and action plan above, then proceed
directly to Step 11.

**Manual mode (default):** When `flags.auto` is false or absent, use AskUserQuestion to ask:
> No changes have been made yet. How to proceed?

Options:
- **implement** — post responses to PR and apply code changes
- **edit** — modify the plan before proceeding
- **skip** — discard, make no changes

If the user chooses **edit**, ask what to change, revise, and present again.
Loop until explicit **implement** or **skip**.

**Do NOT proceed to Step 11 without explicit `implement`**, except bypass-eligible findings
(per Configuration). **Pipeline context never overrides this gate:** even when invoked from
`/ship-sdlc`, if `--auto` was not explicitly passed as a flag, this consent gate is mandatory
for findings outside the bypass set — never infer automatic execution from surrounding
context or conversation history.

---

## Step 11 — IMPLEMENT: Execute Changes

**Only execute after explicit `implement` from Step 10, OR when `flags.auto` is true (auto-proceed for "will fix" items only), OR when the finding satisfies the Configuration → `alwaysFixSeverities` bypass rule.** Bypass-rule findings emit a one-line `fixed: <description>` log entry instead of a consent prompt.

Post responses to PR threads, then implement accepted code changes.

**Implementation order:**
1. Blocking issues (breaks functionality, security)
2. Simple fixes (typos, imports, naming)
3. Complex fixes (refactoring, logic changes)

For each change: make the edit, verify it compiles/passes tests (including running npm, pnpm, pnpm build, or yarn commands) via `node "<PLUGIN_ROOT>/scripts/util/run-truncated.js" "<command>"`, then move to the next.
Do NOT batch changes across items.

**Items marked "disagree" or "needs discussion":** Do NOT implement — await reviewer or
owner input.

**Gracefully correcting wrong pushback:**
If you pushed back and were wrong:
```
Correct: "You were right — I checked [X] and it does [Y]. Implementing now."
Wrong:   Long apology, defensive explanation, over-explaining
```
State the correction factually and move on.

---

## Step 11.6 — META-ANALYZE: Cluster Findings and Dispatch harden-sdlc

**Best-effort step.** Failure here MUST NOT abort Step 11.7 or Step 12.

Build a `findings` array — one entry per Step-4-graded thread (`threadId`, `verdict`, `severity`,
`hardenSurfaceHint`, `hardenTargetFileHint`, `body`, `verificationStatus`, all sourced from the
manifest and Step 4's evaluation; pre-Step-4 threads — `cannot-verify`, ungraded — MUST NOT be
included) — and pipe it to the clustering script:

```shell
node "<PLUGIN_ROOT>/scripts/skill/received-review-cluster.js" <<'JSON'
{ "projectRoot": "<cwd>", "prNumber": <pr.number>, "auto": <flags.auto>,
  "alwaysHardenFromReview": <flags.alwaysHardenFromReview>,
  "hardenClusterCap": <flags.hardenClusterCap>, "findings": [ /* built above */ ] }
JSON
```

> **Contract:** Handles clustering by `(hardenSurfaceHint, hardenTargetFileHint)`, singleton-`disagree`
> filtering, cap+sort (top severity → finding count → alphabetic), the KD7 re-run dedup against
> the last 100 lines of `.sdlc/learnings/log.md`, 4096-char failure-text synthesis, and auto-mode
> matrix resolution from `flags.auto` × `flags.alwaysHardenFromReview` (never re-read raw
> `$ARGUMENTS` or config directly). Exit 0: JSON `{ mode, clusters[], suppressedByCap,
> suppressedByRerun, skippedNullHints, deferredLogEntry }` on stdout, where `suppressedByRerun` is
> the number of clusters dropped by the KD7 re-run guard and `skippedNullHints` is the number of
> otherwise-clusterable findings excluded because `hardenSurfaceHint` or `hardenTargetFileHint` was
> null (they have no cluster key, so they are counted rather than silently dropped). `mode` is one of `interactive-consent |
> interactive-always | auto-defer | auto-always` and each cluster carries `surface`, `targetFile`,
> `findingCount`, `findingIds`, `verdictMix`, `failureText`, `preview200`. Exit 1/2: script error —
> treat as best-effort failure per the rule above, skip the rest of this step.

Emit step-emitter: `meta-analyze-findings` — started:
```
Step 11.6 — meta-analyze-findings: started | clusterCount=<N> surfaces=[<list>] suppressedByRerun=<N> skippedNullHints=<N>
```

Branch on `mode`:

- **`interactive-consent`** (manual, default): for each cluster, present a consent gate —
  > **Step 11.6 — Harden proposal** — cluster: surface=`<surface>`, targetFile=`<targetFile>`, findings=`<findingCount>`
  >
  > Synthesized failure text: _`<preview200>`_
  >
  > Dispatch `harden-sdlc` for this cluster?

  `AskUserQuestion: dispatch | skip`. Emit per cluster: `present-harden-clusters` —
  `consent-granted | consent-skipped`. Dispatch only `consent-granted` clusters (below).
- **`interactive-always`**: skip the consent gate, emit `consent-skipped` for every cluster,
  dispatch all of them (below).
- **`auto-defer`**: NEVER call `AskUserQuestion`. Skip dispatch entirely. Append
  `deferredLogEntry` (already formatted by the script) verbatim to `.sdlc/learnings/log.md`.
  Emit: `dispatch-harden` — `skipped`.
- **`auto-always`**: NEVER call `AskUserQuestion`. Dispatch every cluster (below), propagating
  `--auto` to every `Skill(harden-sdlc)` invocation.

**Dispatch** (each approved cluster in the three non-`auto-defer` modes):
```
Skill("harden-sdlc",
  "--failure-text \"<cluster.failureText>\"
   --skill received-review-sdlc
   --step \"Step 11.6 — meta-analysis\"
   --operation \"review-feedback-driven hardening\"
   [--auto when mode is auto-always]"
)
```
On dispatch failure (exit ≠ 0), log one line to `.sdlc/learnings/log.md` and continue to the
next cluster — do NOT abort Step 11.7 or Step 12:
```
error: harden dispatch exit <code> — surface=<surface> targetFile=<targetFile>
```
Emit: `dispatch-harden` — `{ surface, targetFile, hardenExitCode }`.

Emit step-emitter: `meta-analyze-findings` — completed:
```
Step 11.6 — meta-analyze-findings: completed | dispatched=<N> deferred=<N> suppressed=<N>
```

---

## Step 11.7 — LINK VERIFICATION — HARD GATE

Before any `gh api` reply is posted, validate every URL embedded in every drafted reply body via the shared link validator. Concatenate all reply bodies (one per line) and feed them to the validator on stdin. The script auto-derives `expectedRepo` from `parseRemoteOwner(cwd)` and `jiraSite` from `~/.sdlc-cache/jira/` — the skill MUST NOT construct ctx JSON.

```shell
node "<PLUGIN_ROOT>/scripts/util/received-review-validate-links.js"
```

> **Contract (Input/Output):**
> - **Input**: Concatenated reply bodies via stdin, or via `--file <path>` argument.
> - **Output**: Prints violations to stderr and exits non-zero on broken links.

On non-zero exit (`LINK_EXIT != 0`):
- The script has already printed the violation list to stderr.
- Do NOT post any replies. Do NOT proceed to Step 12.
- Surface the violation list verbatim to the user.
- Stop. Do not retry. Do not edit URLs without user input. Do not bypass.

On zero exit, proceed to Step 12. `SDLC_LINKS_OFFLINE=1` skips network reachability while keeping context-aware checks (GitHub identity match, Atlassian host match) — use in sandboxed CI.

## Step 12 — REPLY & RESOLVE: Post PR Thread Replies

**Mandatory step — always presented after Step 11 completes.**

1. **Summarize** what was done:

```
Review feedback processing complete:
- N comments addressed (code changes implemented)
- M comments pushed back (with technical reasoning)
- K comments intentionally skipped (agree, won't fix)
```

2. **Consent gate:**

Apply the **bypass rule** from Configuration → `alwaysFixSeverities`: bypass-eligible
findings have their replies posted and threads resolved with no prompt, logged as
`fixed: <description>`.

**Auto mode** (`flags.auto` true): skip AskUserQuestion, still display the summary block
above, then proceed directly to step 3 below as if `yes` were selected — post in-thread
replies for every action-plan item. Thread resolution: when `alwaysFixSeverities` is empty
(default), resolve ALL "agree, will fix" threads; when non-empty, resolve only bypass-eligible
ones and append the rest to the follow-up summary (per Configuration). Pushback / "won't fix"
threads are always replied-to but left open. Pipeline context never overrides this — only the
explicit `flags.auto` signal skips the gate.

**Manual mode (default):** When `flags.auto` is false or absent, use AskUserQuestion:

> Should I reply to all addressed review comments on the PR and resolve the threads?

Options:
- **yes** — post replies and resolve threads
- **skip** — do not post replies (user will handle manually)
- **selective** — let me choose which threads to reply to

3. **If yes, selective, or auto mode:** For each comment in the action plan, post the reply
   with the shared template, then apply the type-specific body and resolve rule below.

   **Reply template (all types):** Append `manifest.reply_footer` verbatim to the end of the
   body before posting — do not modify or reposition the footer string; it already contains a
   leading blank-line separator.
   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies -f body="<body><footer>"
   ```
   Resolve via GraphQL mutation when the rule below says to:
   ```bash
   gh api graphql -f query='mutation($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { isResolved } } }' -F threadId="<thread_id>"
   ```

   | Type | `<body>` | Resolve? |
   |------|----------|----------|
   | Addressed (agree, will fix) | `Fixed — <brief description of what was changed>` | Yes — always in manual `implement`/`selective` modes; in auto mode, per the Auto-mode resolution rule above |
   | Pushback (disagree) | the drafted pushback response (from Step 7) | No — leave for reviewer to evaluate |
   | Intentionally skipped (agree, won't fix) | `Acknowledged — not fixing in this PR because: <reason>` | No — let the reviewer decide |

4. **Report results:**

```
Replied to N threads:
- K resolved (fixed)
- M replied with pushback (left open for reviewer)
- J replied with skip reason (left open for reviewer)
```

---

## Best Practices

- Pushback is professional; blind agreement is not — when the reviewer is wrong, say so
  clearly, with evidence (see Step 7).
- Actions speak — a clean implementation is better than a verbose acknowledgment.

---

## DO NOT

- Use performative openers or express gratitude in responses — see Step 7's forbidden-openers rule
- Agree with factually incorrect claims to avoid conflict
- Implement unclear feedback — clarify all unclear items first
- Implement feature requests without a YAGNI check
- Reply top-level when the comment is in a review thread
- Skip the self-critique steps even when evaluation seems obvious
- Batch implement without testing each change individually
- Display output from internal critique steps (Steps 5, 8) to the user
- Skip the Step 10 consent gate without an explicit `--auto` flag — see Step 10 (pipeline context never overrides this gate)
- Use `AskUserQuestion` in Step 11.6 when `flags.auto` is true — the auto-mode matrix governs all Step 11.6 decision sites; cite `flags.auto` and `flags.alwaysHardenFromReview` (resolved manifest fields) exclusively, never raw `$ARGUMENTS`

---

## Error Recovery

> **Flow**: detect → diagnose → auto-recover (retry once if transient) → invoke `error-report-sdlc` for persistent actionable failures.

| Error | Recovery | Invoke error-report-sdlc? |
|-------|----------|---------------------------|
| `gh pr view` or `gh api` fails to fetch PR comments | Check `gh auth status`; show error; ask user to supply feedback directly | No — auth or permissions issue |
| Comment references file/line that no longer exists | Note the discrepancy; verify against current HEAD diff | No — expected with rebased PRs |
| Cannot verify reviewer's claim (no runtime data/external context) | State limitation explicitly; ask user for direction | No — expected limitation |
| `gh api` 5xx or unexpected server error when posting reply | Retry once; if still failing, show the drafted response for manual posting | Yes if second attempt also fails |
| `skill/received-review.js` node -e 'process.exit(2)' (script crash) | Show stderr output, invoke error-report-sdlc | Yes |
| GraphQL resolve mutation fails | Retry once; if still failing, list which threads were not resolved | Yes if second attempt fails |
| Thread ID not found during resolve | Skip that thread, warn user | No — expected with race conditions |

When invoking `error-report-sdlc`, provide:
- **Skill**: received-review-sdlc
- **Step**: Step 11 — IMPLEMENT (posting GitHub thread replies, only after user consent in Step 10)
- **Operation**: `gh api` call to post comment reply
- **Error**: HTTP status + error message from above
- **Suggested investigation**: Check `gh auth status`; verify PR number is correct and accessible; confirm repo permissions

---

## Gotchas

- **Contradictory comments across threads:** When reviewer leaves contradictory feedback in
  different threads, flag the contradiction and ask for clarification rather than guessing
  which one they meant.
- **Comments on deleted lines:** May reference code that no longer exists in the current
  revision. Verify against current HEAD, not the diff context shown in the review.
- **Re-running after partial reply:** If the skill previously posted replies but didn't
  resolve threads (or vice versa), re-running with the prepare script will detect
  self-replied threads and skip them, preventing duplicate replies.
- **GraphQL thread IDs vs REST comment IDs:** The reply endpoint uses REST `databaseId`
  (from `comment.databaseId`), while the resolve mutation uses the GraphQL thread `id`
  (from `thread.id`). The prepare script provides both in its manifest output.

---

## Learning Capture

After processing review feedback, append discoveries to `.sdlc/learnings/log.md`. Record
entries for: reviewer patterns worth knowing (e.g., they always flag X style), pushback
outcomes (accepted or rejected — to calibrate future responses), unclear feedback patterns
that revealed communication gaps, YAGNI findings that removed unnecessary work, or codebase
facts uncovered during verification.

---

## What's Next

After replying to review threads, common follow-ups include:
- `/commit-sdlc` — commit the fixes

## See Also

- [`/review-sdlc`](../review-sdlc/SKILL.md) — source of findings this skill responds to
- [`/commit-sdlc`](../commit-sdlc/SKILL.md) — commit the fixes after review
- [`/pr-sdlc`](../pr-sdlc/SKILL.md) — the PR being reviewed
