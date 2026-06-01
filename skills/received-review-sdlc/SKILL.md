---
name: received-review-sdlc
description: "Use this skill when responding to code review feedback on a pull request or inline reviewer comments. Covers reading, verifying, evaluating, and responding to reviewer comments with a dual self-critique gate — prevents performative agreement and ensures technical rigor. Can be launched manually or automatically after /review-sdlc. Triggers on: process review feedback, respond to review, handle review comments, address PR feedback, fix review findings, received-review."
user-invocable: true
argument-hint: "[--pr <number>] [--auto]"
model: gemini-3.1-pro
---

# Responding to Code Review Feedback

Process reviewer comments with technical rigor. Each item is verified against the full
codebase context — not just the change diff — before any response is drafted. Internal
self-critique gates ensure quality. No changes are made until the user explicitly approves
the proposed action plan.

**Announce at start:** "I'm using received-review-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

---

## Configuration

### `receivedReview.alwaysFixSeverities` (issue #233, R18/R19)

Per-user, per-project allowlist of finding severities whose **"agree, will fix"** verdicts bypass
the per-finding consent gate in Step 10 (PRESENT) and Step 12 (REPLY & RESOLVE).

- **Location:** `.sdlc/local.json` under `receivedReview.alwaysFixSeverities` (gitignored, per-user).
  This field is **local-only** — it MUST NEVER be set in `.sdlc/config.json`. The prepare script
  emits a stderr warning and ignores the value if it appears in project config (R19).
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

**Auto-apply rule (R18):** A finding is auto-applied (no consent prompt) when **all three** hold:

1. The verdict is `agree, will fix`
2. The finding's parsed severity is non-null
3. The severity ∈ `flags.alwaysFixSeverities`

A finding with `severity: null` (severity could not be parsed from the comment body) **NEVER**
bypasses the consent gate, regardless of `flags.alwaysFixSeverities`.

**`--auto` interaction (R10/R16):** When `flags.alwaysFixSeverities` is non-empty, `--auto`
is further restricted by R18: only "will fix" findings whose severity is in the list are
implemented in Step 11; remaining "will fix" findings (severity not in the list, or
`severity: null`) are collected into a **follow-up summary** appended to the response output.
In Step 12, only "agree, will fix" threads matching R18 are resolved; other threads are replied
to but left open.

When `flags.alwaysFixSeverities` is empty (the default — `alwaysFixSeverities` unset in
`.sdlc/local.json`), `--auto` falls back to the original behavior: **all** "will fix" findings
are auto-applied in Step 11 and all "agree, will fix" threads are resolved in Step 12, regardless
of severity (including `severity: null`). This preserves backward compatibility for users who
have not configured the field.

To configure interactively, run `/setup-sdlc --only received-review`.

### `receivedReview.alwaysHardenFromReview` (issue #429, R24)

Per-user flag that controls whether Step 11.6 (META-ANALYZE) automatically dispatches
`Skill(harden-sdlc)` per cluster without asking for consent.

- **Location:** `.sdlc/local.json` under `receivedReview.alwaysHardenFromReview` (gitignored, per-user).
  This field is **local-only** — it MUST NEVER be set in `.sdlc/config.json`. The prepare script
  emits a stderr warning and ignores the value if it appears in project config (R24).
- **Type:** `boolean` — default `false`.
- **Scope:** applies uniformly to all Step 11.6 cluster dispatches in every run.

**Auto-mode matrix (R25 — all four cells authoritative):**

| `flags.auto` | `flags.alwaysHardenFromReview` | Step 11.6 behavior |
|---|---|---|
| `false` | `false` | Present consent gate per cluster → dispatch approved clusters only. |
| `false` | `true`  | Skip consent gate → dispatch every cluster (capped at `hardenClusterCap`). |
| `true`  | `false` | Skip consent gate AND skip dispatch entirely → append deferred-action entry to `.sdlc/learnings/log.md` (R26 format). |
| `true`  | `true`  | Skip consent gate → dispatch every cluster (capped), propagating `--auto` to every dispatch. |

**Single resolution site:** `skill/received-review.js` (prepare script). SKILL.md cites
`flags.alwaysHardenFromReview` only — never raw `$ARGUMENTS` or `.sdlc/local.json` directly.

**Example `.sdlc/local.json`:**
```json
{
  "receivedReview": {
    "alwaysHardenFromReview": true,
    "hardenClusterCap": 5
  }
}
```

### `receivedReview.hardenClusterCap` (issue #429, P15)

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

```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

SCRIPT="$SDLC_ROOT/scripts/skill/received-review.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/received-review.js. Is the sdlc plugin installed?" >&2; exit 2; }

if [ -n "$SCRIPT" ]; then
  MANIFEST_FILE=$(node "$SCRIPT" --output-file $ARGUMENTS --pr <PR_NUMBER>)
  EXIT_CODE=$?
  echo "MANIFEST_FILE=$MANIFEST_FILE"
  echo "EXIT_CODE=$EXIT_CODE"
  # Single canonical cleanup: trap fires unconditionally on EXIT/INT/TERM.
  trap 'rm -f "$MANIFEST_FILE"' EXIT INT TERM
fi

```

**On exit code 0:** Read the manifest JSON. Extract `flags.auto` from the manifest and store it as a boolean (defaults to `false` if absent). If `--auto` was passed in `$ARGUMENTS` but not in the manifest, treat it as `true`. Display the incremental summary:

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

1. **Read the referenced code** — understand what the code actually does
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

## Step 5 — CRITIQUE #1: Self-Critique the Evaluation

> **INTERNAL** — Do not display gate results, pass/fail status, or any output from this step to the user. Process silently and proceed to the next step.

Before drafting responses, review the evaluation against these gates:

| Gate | Check | Pass Criteria |
|------|-------|--------------|
| Verification completeness | Every item verified against actual code | No item evaluated without reading relevant source |
| No blind agreement | Disagreements exist where technically warranted | Not everything marked "agree" unless genuinely correct |
| YAGNI applied | Feature suggestions checked for real vs hypothetical need | No "sounds good, will add" for speculative features |
| Unclear items resolved | All unclear items clarified before proceeding | Not implementing partial feedback |
| Technical grounding | Every agree/disagree decision cites code or behavior | No decisions based on "seems right" without evidence |

Note every failing gate.

---

## Step 6 — IMPROVE #1: Revise Evaluation

> **INTERNAL** — Do not display output from this step to the user. Process silently.

Fix each issue found in Step 5:
- Re-read code for items where verification was incomplete
- Strengthen technical reasoning where it was vague
- Reclassify items where the initial assessment was unsupported

Continue until all gates pass (max 2 iterations per gate).

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

**GitHub thread replies:** Reply in-thread using the comment ID, not as a top-level PR comment:
```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies \
  -f body="<response text>"
```

**Version footer:** Append `manifest.reply_footer` verbatim to the end of every reply body before posting. Do not modify the footer string. Do not insert it elsewhere. The footer is a single string with a leading blank-line separator already included — append it directly to the reply body with no additional separator.

---

## Step 8 — CRITIQUE #2: Self-Critique the Responses

> **INTERNAL** — Do not display gate results, pass/fail status, or any output from this step to the user. Process silently and proceed to the next step.

Review drafted responses against these gates:

| Gate | Check | Pass Criteria |
|------|-------|--------------|
| No performative language | Zero forbidden openers or gratuitous praise | Responses start with substance, not social filler |
| Technically grounded | Every response references specific code, behavior, or constraint | No hand-waving ("this should be fine") |
| Pushback is technical | Disagreements cite code, performance data, or design constraints | No "I prefer" or "I think" without backing evidence |
| Thread-level replies | Each response targets its specific comment thread | No top-level dump of all responses |
| Implementation plan clear | For accepted items, response states what will change | Reviewer knows what to expect in next push |
| No blind agreement | Factual errors corrected, not accommodated | Incorrect reviewer claims are challenged |
| Proportional effort | Simple fixes get short responses; complex items get detailed ones | No walls of text for typo fixes |

Note every failing gate.

---

## Step 9 — IMPROVE #2: Revise Responses

> **INTERNAL** — Do not display output from this step to the user. Process silently.

Fix each issue found in Step 8:
- Delete performative openers, replace with substance
- Add specific code references where missing
- Shorten over-explained simple fixes

Continue until all gates pass (max 2 iterations per gate).

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

**Per-finding bypass rule (R18):** Skip the consent gate for finding F when
`flags.alwaysFixSeverities` includes `F.severity` AND `F.verdict === "agree, will fix"` AND
`F.severity !== null`. Such findings are auto-applied with a one-line `fixed: <description>`
log entry and require no user prompt. All other findings (any other verdict, severity not in
the list, or `severity: null`) follow the modes below.

**Auto mode:** When `flags.auto` is true (from manifest or arguments):
- If `flags.alwaysFixSeverities` is **non-empty**: apply only "agree, will fix" findings whose
  severity ∈ `flags.alwaysFixSeverities` (per the R18 bypass rule above). Remaining "agree, will
  fix" findings — severity NOT in the list, or `severity: null` — are collected into a
  **follow-up summary** appended to the response output (not auto-applied).
- If `flags.alwaysFixSeverities` is **empty** (default): apply **all** "agree, will fix" findings
  regardless of severity (including `severity: null`). This is the original `--auto` behavior and
  is the default for users who have not configured `alwaysFixSeverities`.

Items with "disagree", "needs discussion", or "won't fix" verdicts are displayed but NEVER
auto-actioned in either case. Still display the full analysis table and action plan above for
visibility, then proceed directly to Step 11.

**Manual mode (default):** When `flags.auto` is false or absent, use AskUserQuestion to ask:
> No changes have been made yet. How to proceed?

Options:
- **implement** — post responses to PR and apply code changes
- **edit** — modify the plan before proceeding
- **skip** — discard, make no changes

If the user chooses **edit**, ask what to change, revise, and present again.
Loop until explicit **implement** or **skip**.

**Do NOT proceed to Step 11 without explicit `implement` from the user via AskUserQuestion**, EXCEPT
for findings that satisfy the R18 bypass rule above — those are auto-applied without prompting and
emit a `fixed: ...` log line. Findings outside the R18 bypass set still require explicit
`implement` consent.

**Without `--auto`, pipeline context does NOT override this gate** (except for findings satisfying
the R18 bypass rule). Even when invoked from `/ship-sdlc`, if `--auto` was not explicitly passed
as a flag, this consent gate is mandatory for findings outside the R18 bypass set. Do not infer
from surrounding context that automatic execution is expected.

---

## Step 11 — IMPLEMENT: Execute Changes

**Only execute after explicit `implement` from Step 10, OR when `flags.auto` is true (auto-proceed for "will fix" items only), OR when the finding satisfies the R18 bypass rule from Step 10 (severity ∈ `flags.alwaysFixSeverities` AND verdict is "agree, will fix" AND `severity !== null`).** Findings auto-applied via R18 emit a one-line `fixed: <description>` log entry instead of a consent prompt.

Post responses to PR threads, then implement accepted code changes.

**Implementation order:**
1. Blocking issues (breaks functionality, security)
2. Simple fixes (typos, imports, naming)
3. Complex fixes (refactoring, logic changes)

For each change: make the edit, verify it compiles/passes tests, then move to the next.
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

## Step 11.6 — META-ANALYZE: Cluster Findings and Dispatch harden-sdlc (R21–R26)

**Best-effort step.** Failure here MUST NOT abort Step 11.7 or Step 12.

### 11.6.1 — Cluster findings (R22, C18)

Only cluster findings whose verdict is one of the four R6 outcomes
(`agree-will-fix | agree-won't-fix | disagree | needs-discussion`). Pre-Step-4 threads
(`cannot-verify`, ungraded) MUST NOT enter clusters (C18).

Cluster key = `(hardenSurfaceHint, hardenTargetFileHint)` from each thread's manifest fields (P12/P13).

Rules:
- `disagree` findings require ≥2 findings with the same `hardenTargetFileHint` before forming a cluster (singleton `disagree` silently skipped).
- Apply cap `flags.hardenClusterCap` (default 5): prune by top-highest-severity-in-cluster → ties by finding count → alphabetic on `(surface, targetFile)`.
- Track `suppressed = totalClusters - cap` for the log entry.

Emit step-emitter: `meta-analyze-findings` — started:
```
Step 11.6 — meta-analyze-findings: started | clusterCount=<N> surfaces=[<list>]
```

### 11.6.2 — Re-run guard (KD7)

Scan the last 100 lines of `.sdlc/learnings/log.md` for prior `received-review-sdlc:` deferred-cluster entries whose `surface=` and `targetFile=` match the current PR's clusters. Suppress matching clusters with a `suppressed: re-run dedup` log line.

### 11.6.3 — Branch on R25 auto-mode matrix

Gate on `flags.auto` and `flags.alwaysHardenFromReview` (resolved fields from manifest — never re-read `$ARGUMENTS` or config directly; C17).

**Cell 1 — `flags.auto === false` AND `flags.alwaysHardenFromReview === false` (interactive, default):**

For each cluster, present consent gate:

> **Step 11.6 — Harden proposal** — cluster: surface=`<hardenSurfaceHint>`, targetFile=`<hardenTargetFileHint>`, findings=`<count>`
>
> Synthesized failure text: _`<first 200 chars of cluster body>`_
>
> Dispatch `harden-sdlc` for this cluster?

```
AskUserQuestion: dispatch | skip
```

Emit per cluster: `present-harden-clusters` — `consent-granted | consent-skipped`.

**Cell 2 — `flags.auto === false` AND `flags.alwaysHardenFromReview === true` (interactive, always-harden):**

Skip consent gate. Emit `consent-skipped` for every cluster. Proceed directly to dispatch (11.6.4).

**Cell 3 — `flags.auto === true` AND `flags.alwaysHardenFromReview === false` (auto, defer):**

NEVER call `AskUserQuestion` (C17). Skip consent gate. Skip dispatch entirely.

Append deferred-action entry to `.sdlc/learnings/log.md` in R26 format:
```
## YYYY-MM-DD — received-review-sdlc: deferred meta-analysis clusters
PR: <pr.number>
Clusters (<count>):
- surface=<hardenSurfaceHint> targetFile=<hardenTargetFileHint> findings=<count> verdict-mix=<csv> failure-text-preview="<first 100 chars>"
- ...
Suppressed: <N> additional clusters beyond cap=<cap>
```

Emit: `dispatch-harden` — `skipped`.

**Cell 4 — `flags.auto === true` AND `flags.alwaysHardenFromReview === true` (auto, always-harden):**

NEVER call `AskUserQuestion` (C17). Skip consent gate. Dispatch every cluster (capped), propagating `--auto` to every `Skill(harden-sdlc)` invocation.

### 11.6.4 — Dispatch per approved cluster (R23)

For each approved cluster (cells 1, 2, or 4 above):

1. Synthesize `--failure-text`: concatenate cluster-member comment bodies + verification status + verdict, trimmed to 4096 chars.
2. Dispatch:
   ```
   Skill("harden-sdlc",
     "--failure-text \"<synthesized cluster text>\"
      --skill received-review-sdlc
      --step \"Step 11.6 — meta-analysis\"
      --operation \"review-feedback-driven hardening\"
      [--auto when cell 4]"
   )
   ```
3. On dispatch failure (exit ≠ 0): log one line to `.sdlc/learnings/log.md`:
   ```
   error: harden dispatch exit <code> — surface=<surface> targetFile=<targetFile>
   ```
   Then continue to next cluster. Do NOT abort Step 11.7 or Step 12 (R25 hard rule c).
4. Emit: `dispatch-harden` — `{ surface, targetFile, hardenExitCode }`.

Emit step-emitter: `meta-analyze-findings` — completed:
```
Step 11.6 — meta-analyze-findings: completed | dispatched=<N> deferred=<N> suppressed=<N>
```

---

## Step 11.7 — LINK VERIFICATION (R17, issue #198) — HARD GATE

Before any `gh api` reply is posted, validate every URL embedded in every drafted reply body via the shared link validator. Concatenate all reply bodies (one per line) and feed them to the validator on stdin. The script auto-derives `expectedRepo` from `parseRemoteOwner(cwd)` and `jiraSite` from `~/.sdlc-cache/jira/` — the skill MUST NOT construct ctx JSON.

```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

LINKS_LIB="$SDLC_ROOT/scripts/lib/links.js"
[ ! -f "$LINKS_LIB" ] && { echo "ERROR: Could not locate scripts/lib/links.js. Is the sdlc plugin installed?" >&2; exit 2; }
printf '%s\n' "$reply_bodies_concatenated" | node "$LINKS_LIB" --json
LINK_EXIT=$?

```

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

**Per-finding bypass rule (R18):** Skip the consent gate for finding F when
`flags.alwaysFixSeverities` includes `F.severity` AND `F.verdict === "agree, will fix"` AND
`F.severity !== null`. Such findings have their replies posted and threads resolved without a
user prompt; the action is logged as `fixed: <description>`. All other findings follow the modes
below.

**Auto mode:** When `flags.auto` is true (from manifest or arguments), skip the AskUserQuestion
consent gate. Still display the summary block above for visibility, then proceed directly to
step 3 below as if the user selected `yes`: post in-thread replies for every action-plan item.

Thread resolution behavior depends on `flags.alwaysFixSeverities`:
- **Non-empty list:** Resolve only "agree, will fix" threads whose severity ∈
  `flags.alwaysFixSeverities` (R18). "agree, will fix" threads with severity NOT in the list (or
  `severity: null`) are replied to but NOT resolved — they are appended to the follow-up summary.
- **Empty list (default):** Resolve ALL "agree, will fix" threads regardless of severity
  (including `severity: null`). This is the original `--auto` behavior for users who have not
  configured `alwaysFixSeverities`.

Pushback and "won't fix" threads are replied to but left open for the reviewer in both cases.
Pipeline context does NOT override this behavior — only the explicit `flags.auto` signal skips
the gate.

**Manual mode (default):** When `flags.auto` is false or absent, use AskUserQuestion:

> Should I reply to all addressed review comments on the PR and resolve the threads?

Options:
- **yes** — post replies and resolve threads
- **skip** — do not post replies (user will handle manually)
- **selective** — let me choose which threads to reply to

3. **If yes, selective, or auto mode:** For each comment in the action plan:

   **Footer rule (applies to all reply types below):** Append `manifest.reply_footer` verbatim to the end of every reply body before posting. Do not modify the footer string. Do not insert it elsewhere. The footer already contains a leading blank-line separator.

   **For addressed comments (agree, will fix):**
   - Post a reply describing what was changed:
     ```bash
     gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies \
       -f body="Fixed — <brief description of what was changed>"
     ```
   - Resolve the thread via GraphQL mutation:
     ```bash
     gh api graphql -f query='mutation($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { isResolved } } }' -F threadId="<thread_id>"
     ```
   - In **manual `implement`/`selective` modes**, always resolve all "agree, will fix" threads — the user has explicitly approved the action plan.
   - In **auto mode**, resolution follows the rule in the Auto mode block above: all "agree, will fix" threads are resolved when `flags.alwaysFixSeverities` is empty; only severity-matching threads are resolved when the list is non-empty.

   **For pushback comments (disagree):**
   - Post the drafted pushback response (from Step 7):
     ```bash
     gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies \
       -f body="<pushback response>"
     ```
   - Do NOT resolve the thread — leave for reviewer to evaluate

   **For intentionally skipped comments (agree, won't fix):**
   - Post a reply explaining why it was skipped:
     ```bash
     gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies \
       -f body="Acknowledged — not fixing in this PR because: <reason>"
     ```
   - Do NOT resolve — let the reviewer decide

4. **Report results:**

```
Replied to N threads:
- K resolved (fixed)
- M replied with pushback (left open for reviewer)
- J replied with skip reason (left open for reviewer)
```

---

## Best Practices

1. Read ALL feedback before responding to any of it — items may be related
2. Verify every claim — reviewers can be wrong about what code does
3. Group unclear items and ask once, not piecemeal
4. Pushback is professional; blind agreement is not
5. Implementation order matters: blocking first, cosmetic last
6. When the reviewer is wrong, say so clearly with evidence
7. Actions speak — a clean implementation is better than a verbose acknowledgment

---

## DO NOT

- Use performative openers ("Great catch!", "You're right!", "Thanks!")
- Agree with factually incorrect claims to avoid conflict
- Implement unclear feedback — clarify all unclear items first
- Implement feature requests without a YAGNI check
- Reply top-level when the comment is in a review thread
- Skip the self-critique steps even when evaluation seems obvious
- Batch implement without testing each change individually
- Express gratitude — let the code changes speak
- Display output from internal critique steps (Steps 5-6, 8-9) to the user
- Skip the Step 10 consent gate without an explicit `--auto` flag — pipeline context, conversation history, or inference about "auto mode" is not a substitute for the flag being passed
- Use `AskUserQuestion` in Step 11.6 when `flags.auto` is true — the R25 / C17 matrix governs all Step 11.6 decision sites; cite `flags.auto` and `flags.alwaysHardenFromReview` (resolved manifest fields) exclusively, never raw `$ARGUMENTS`

---

## Error Recovery

> **Flow**: detect → diagnose → auto-recover (retry once if transient) → invoke `error-report-sdlc` for persistent actionable failures.

| Error | Recovery | Invoke error-report-sdlc? |
|-------|----------|---------------------------|
| `gh pr view` or `gh api` fails to fetch PR comments | Check `gh auth status`; show error; ask user to supply feedback directly | No — auth or permissions issue |
| Comment references file/line that no longer exists | Note the discrepancy; verify against current HEAD diff | No — expected with rebased PRs |
| Cannot verify reviewer's claim (no runtime data/external context) | State limitation explicitly; ask user for direction | No — expected limitation |
| `gh api` 5xx or unexpected server error when posting reply | Retry once; if still failing, show the drafted response for manual posting | Yes if second attempt also fails |
| `skill/received-review.js` exit 2 (script crash) | Show stderr output, invoke error-report-sdlc | Yes |
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
- **Automated review tools:** Findings from `/review-sdlc` or similar automated tools should
  be treated as external reviewer feedback — verify each finding against actual code before
  accepting it.
- **Re-running after partial reply:** If the skill previously posted replies but didn't
  resolve threads (or vice versa), re-running with the prepare script will detect
  self-replied threads and skip them, preventing duplicate replies.
- **GraphQL thread IDs vs REST comment IDs:** The reply endpoint uses REST `databaseId`
  (from `comment.databaseId`), while the resolve mutation uses the GraphQL thread `id`
  (from `thread.id`). The prepare script provides both in its manifest output.
- **Auto mode scope:** `--auto` only auto-implements "will fix" items. "Disagree", "needs
  discussion", and "won't fix" items are always displayed and never auto-actioned. This
  prevents automated tools from silently suppressing pushback.

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
