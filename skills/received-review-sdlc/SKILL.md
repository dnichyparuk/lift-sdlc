---
name: received-review-sdlc
description: "Use this skill when responding to code review feedback on a pull request or inline reviewer comments. Covers reading, verifying, evaluating, and responding to reviewer comments with a dual self-critique gate — prevents performative agreement and ensures technical rigor. Can be launched manually or automatically after /review-sdlc. Triggers on: process review feedback, respond to review, handle review comments, address PR feedback, fix review findings, received-review."
user-invocable: true
argument-hint: "[--pr <number>] [--auto]"
---

# Responding to Code Review Feedback

Process reviewer comments with technical rigor. Verify every item against full codebase context — not just the change diff — before drafting any response. No changes are made until the user explicitly approves the proposed action plan (unless covered by `--auto` or `alwaysFixSeverities`).

**Announce at start:** "I'm using received-review-sdlc (sdlc v{sdlc_version})." — extract the version from `sdlc:` in the session-start system-reminder; omit the parenthetical if absent.

> Fallback verification (Step 1b, Step 3a `received-review-orchestrator`, Step 3b inline), pushback examples, error recovery, gotchas, and learning capture live in [`./resources/verify-fallback-and-playbook.md`](./resources/verify-fallback-and-playbook.md).

---

## Primary Dispatch — Native `run_workflow` (`workflows/verify.py`)

After Step 0 and Step 1a (or when a PR exists and `run_workflow` is available), dispatch `skills/received-review-sdlc/workflows/verify.py` as the primary depth-1 Step 3 verifier (fall back to Step 3a `received-review-orchestrator` `"Model": "flash"` or Step 3b inline per [`./resources/verify-fallback-and-playbook.md`](./resources/verify-fallback-and-playbook.md) only if `run_workflow` is unavailable or no PR manifest exists):

- `Description`: `"Verify received PR review threads"`
- `Cwd`: current working directory
- `Args`: `{ "manifest_file": "<MANIFEST_FILE_or_omit>", "received_review_args": "$ARGUMENTS", "plugin_root": "<PLUGIN_ROOT>", "cwd": "<cwd>" }`
- `Script`:
  ```python
  exec(open("<PLUGIN_ROOT>/skills/received-review-sdlc/workflows/verify.py").read(), globals())
  await main()
  ```

Handle returned JSON:
- `status === "failed"` with `exit_code === 1` (no PR) → Step 1b + Step 3b; `exit_code === 2` → `error-report-sdlc` and stop.
- `status === "completed"` or `"partial"` → map `findings[]` (`verificationStatus`, `evidence`, `rippleEffects`, `reasoning`) and `reportFile` (marking `missingIds` as `cannot-verify`), then proceed to Steps 4–12.

---

## Context Optimization Constraints

1. **Targeted Reads:** Outline large files first with `node "<PLUGIN_ROOT>/scripts/util/outline-file.js" <file>`.
2. **Parallelism:** Batch independent exploration, reads, and checks in one turn.
3. **Silent Reasoning:** Keep internal critiques inside `thought` blocks; proceed directly to the next step.
4. **Truncated Outputs:** Run build/test/lint/package-manager commands via `node "<PLUGIN_ROOT>/scripts/util/run-truncated.js" "<command>"`.

---

## Configuration

### `receivedReview.alwaysFixSeverities`

Local-only severity allowlist (`low | medium | high | critical`, default `[]`) in `.sdlc/local.json` (**MUST NEVER** be set in `.sdlc/config.json` — `skill/received-review.js` warns and ignores it there). Resolved once into `flags.alwaysFixSeverities` — cite `flags.alwaysFixSeverities` only, never re-read config. Configure via `/setup-sdlc --only received-review`.

- **Bypass rule:** Auto-applies (no prompt, logged as `fixed: <description>`) when **all three** hold: verdict is `agree, will fix`, parsed severity is non-null, and severity ∈ `flags.alwaysFixSeverities`. `severity: null` **NEVER** bypasses.
- **`--auto` interaction:** If `flags.alwaysFixSeverities` is empty (default), `--auto` applies/resolves **all** "agree, will fix" items in Steps 11–12. If non-empty, `--auto` applies/resolves only bypass-eligible items; the rest go to a **follow-up summary** (Step 11) and stay replied-but-unresolved (Step 12).

### `receivedReview.alwaysHardenFromReview` & `receivedReview.hardenClusterCap`

Local-only boolean in `.sdlc/local.json` (default `false`; **MUST NEVER** be set in `.sdlc/config.json`) plus integer `hardenClusterCap` (default `5`, clamped `[1, 50]`; excess logged as `suppressed: N additional clusters`). Resolved as `mode` by `received-review-cluster.js` — never re-derive from `$ARGUMENTS` or config:

| `flags.auto` | `flags.alwaysHardenFromReview` | `mode` | Step 11.6 behavior |
|---|---|---|---|
| `false` | `false` | `interactive-consent` | Consent gate per cluster → dispatch approved only. |
| `false` | `true`  | `interactive-always`  | Skip consent → dispatch all (capped). |
| `true`  | `false` | `auto-defer`          | Skip consent & dispatch → append `deferredLogEntry` to `.sdlc/learnings/log.md`. |
| `true`  | `true`  | `auto-always`         | Skip consent → dispatch all (capped), propagating `--auto`. |

---

## Step 0 — Plan Mode Check

If system context contains "Plan mode is active":
1. Announce: "This skill requires write operations (file edits, gh api calls). Exit plan mode first, then re-invoke `/received-review-sdlc`."
2. Stop.

---

## Step 1 — READ: Gather Review Feedback

### Step 1a — Run `skill/received-review.js` (when PR number available)

```shell
MANIFEST_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/received-review.js" --output-file $ARGUMENTS)
EXIT_CODE=$?
echo "MANIFEST_FILE=$MANIFEST_FILE"
echo "EXIT_CODE=$EXIT_CODE"
```

> **Contract:** Infers PR from git branch and prints temp JSON manifest path on stdout.
> - **Exit 0:** Read `$MANIFEST_FILE`, extract `flags.auto` (boolean, default `false`; treat as `true` if `--auto` was in `$ARGUMENTS`), print `Found N outstanding comments (M resolved, K already replied, J stale — skipped). Processing only the N outstanding comments.` Use `status: "outstanding"` threads for Steps 2–11; keep full manifest for Step 12.
> - **Exit 1:** No PR / missing args → Step 1b ([`./resources/verify-fallback-and-playbook.md`](./resources/verify-fallback-and-playbook.md)).
> - **Exit 2:** Script error → invoke `error-report-sdlc` (`Skill: received-review-sdlc`, `Step: Step 1 — READ`, `Operation: skill/received-review.js execution`, `Error: stderr`) and stop.

### Step 1b — Manual feedback gathering (fallback)

If no PR exists or Step 1a exits `1`, follow Step 1b in [`./resources/verify-fallback-and-playbook.md`](./resources/verify-fallback-and-playbook.md).

---

## Step 2 — UNDERSTAND: Categorize and Flag

Classify each item (`bug`, `style`, `architecture`, `feature-request`, `question`, `unclear`).

**CRITICAL:** If ANY item is **unclear**, STOP — do not implement anything. Ask for clarification on ALL unclear items at once before Step 3.

---

## Step 3 — VERIFY: Check Against Full Codebase Context

- **Primary:** Run `workflows/verify.py` above when a PR exists and `run_workflow` is available.
- **Fallback (Step 3a / Step 3b):** If `run_workflow` is unavailable with a Step 1a manifest, dispatch `received-review-orchestrator` (`"Model": "flash"`, matching `agents/received-review-orchestrator.md`); if no manifest exists or after two orchestrator failures, run Step 3b inline. See [`./resources/verify-fallback-and-playbook.md`](./resources/verify-fallback-and-playbook.md).

---

## Step 4 — EVALUATE: Assess Each Item

Assign one verdict per item:
- **agree, will fix** — technically correct, should be changed
- **agree, won't fix** — correct, out of scope or lower priority (state reason)
- **disagree** — technically incorrect for this codebase (provide reasoning)
- **needs discussion** — architectural impact, requires owner input

**YAGNI check (feature requests):** Grep for usage; if unused, ask `"This isn't called anywhere. Remove it (YAGNI)? Or is there usage I'm missing?"`; if used, evaluate on merit.
**Source trust:** Trusted partner → implement after understanding without performative agreement; external/automated → verify technically, apply YAGNI, push back if wrong.

---

## Step 5 — CRITIQUE #1 / IMPROVE #1: Self-Critique the Evaluation

> **INTERNAL** — Do not display gate results or output from this step to the user.

Verify evaluation against all gates (max 2 iterations per gate):
- **Verification completeness** — relevant source read (or `evidence` / `cannot-verify` from Step 3)
- **No blind agreement** — not everything marked "agree" unless genuinely correct
- **YAGNI applied** — no speculative features without usage check
- **Unclear items resolved** — nothing implemented on partial understanding
- **Technical grounding** — every decision cites code or behavior

---

## Step 7 — RESPOND (DO): Draft Responses

Per item: (1) factual acknowledgment, (2) action or technical disagreement reason, (3) brief approach if implementing.

**Forbidden openers — NEVER use:** `"You're absolutely right!"`, `"Great point!"`, `"Excellent feedback!"`, `"Thanks for catching that!"`, any gratitude expression, or `"Let me implement that now"` (before verification). Start with substance.

**Pushback format:** `Checked [specific code location]. [What it actually does]. [Consequence of the suggested change]. Decision: [keeping as-is / discussing with owner / needs more context].` (Examples in [`./resources/verify-fallback-and-playbook.md`](./resources/verify-fallback-and-playbook.md).)

Posted in Step 12 in-thread by comment ID — never as a top-level PR comment.

---

## Step 8 — CRITIQUE #2 / IMPROVE #2: Self-Critique the Responses

> **INTERNAL** — Do not display gate results or output from this step to the user.

Check drafted responses against all gates (max 2 iterations per gate):
- **No performative language** — follows Step 7 forbidden-openers rule
- **Technically grounded** — cites specific code, behavior, or constraints
- **Pushback is technical** — cites code, performance, or design constraints
- **Thread-level replies** — targets specific thread, not top-level
- **Implementation plan clear** — accepted items state what changes
- **No blind agreement** — factual errors corrected, not accommodated
- **Proportional effort** — simple fixes short; complex items detailed

---

## Step 10 — PRESENT: Show Findings and Proposed Plan

First user-visible output after analysis. **No changes have been made yet.**

1. **Analysis summary table:** `| # | File | Line | Type | Verdict | Reasoning |`
2. **Proposed action plan:** Group into **Will fix**, **Will push back**, and **Needs discussion**.
3. **Drafted PR responses:** Full text of each drafted response, labeled by item number.
4. **Consent gate:**
   - Apply the `alwaysFixSeverities` **bypass rule** first (`fixed: <description>` log, no prompt).
   - **Auto mode (`flags.auto` true):** Apply Configuration → `--auto` interaction (all "agree, will fix" when `alwaysFixSeverities` is empty, else bypass-eligible only + follow-up summary). "disagree" / "needs discussion" / "won't fix" are NEVER auto-actioned. Display table and plan, then proceed to Step 11.
   - **Manual mode (default):** Use `ask_question`: *"No changes have been made yet. How to proceed?"* (**implement** | **edit** | **skip**). On **edit**, revise and re-present until **implement** or **skip**.
   - **HARD GATE:** Do NOT proceed to Step 11 without explicit `implement`, except bypass-eligible findings or explicit `flags.auto` true. **Pipeline context (including `/ship-sdlc`) never overrides this gate.**

---

## Step 11 — IMPLEMENT: Execute Changes

**Only execute after explicit `implement` in Step 10, `flags.auto` true ("will fix" only), or the `alwaysFixSeverities` bypass rule.**

Order: (1) blocking issues, (2) simple fixes, (3) complex fixes. Edit one item, verify compile/tests via `node "<PLUGIN_ROOT>/scripts/util/run-truncated.js" "<command>"`, then move to the next — never batch across items. Never implement "disagree" or "needs discussion" items. (Corrections to wrong pushback: [`./resources/verify-fallback-and-playbook.md`](./resources/verify-fallback-and-playbook.md).)

---

## Step 11.6 — META-ANALYZE: Cluster Findings and Dispatch `harden-sdlc`

**Best-effort step.** Failure here MUST NOT abort Step 11.7 or Step 12.

Build `findings` (one entry per Step-4-graded thread: `threadId`, `verdict`, `severity`, `hardenSurfaceHint`, `hardenTargetFileHint`, `body`, `verificationStatus`; exclude pre-Step-4 `cannot-verify` or ungraded threads) and pipe to:

```shell
node "<PLUGIN_ROOT>/scripts/skill/received-review-cluster.js" <<'JSON'
{ "projectRoot": "<cwd>", "prNumber": <pr.number>, "auto": <flags.auto>,
  "alwaysHardenFromReview": <flags.alwaysHardenFromReview>,
  "hardenClusterCap": <flags.hardenClusterCap>, "findings": [ /* built above */ ] }
JSON
```

> **Contract:** Exit 0 emits `{ mode, clusters[], suppressedByCap, suppressedByRerun, skippedNullHints, deferredLogEntry }` (`mode` ∈ `interactive-consent | interactive-always | auto-defer | auto-always`). Exit 1/2: skip remaining Step 11.6 (best-effort).

Emit `meta-analyze-findings: started | clusterCount=<N> surfaces=[<list>] suppressedByRerun=<N> skippedNullHints=<N>`, then branch on `mode`:
- **`interactive-consent`:** Per cluster, `ask_question` (`dispatch | skip`) showing `surface`, `targetFile`, `findingCount`, and `preview200`; emit `present-harden-clusters` (`consent-granted | consent-skipped`); dispatch approved only.
- **`interactive-always`:** Skip consent gate, emit `consent-skipped` per cluster, dispatch all.
- **`auto-defer`:** NEVER call `ask_question`. Skip dispatch; append `deferredLogEntry` verbatim to `.sdlc/learnings/log.md`. Emit `dispatch-harden` — `skipped`.
- **`auto-always`:** NEVER call `ask_question`. Dispatch all clusters, propagating `--auto`.

**Dispatch (each approved cluster):**
```
Skill("harden-sdlc",
  "--failure-text \"<cluster.failureText>\" --skill received-review-sdlc --step \"Step 11.6 — meta-analysis\" --operation \"review-feedback-driven hardening\" [--auto when mode is auto-always]")
```
On exit ≠ 0, append `error: harden dispatch exit <code> — surface=<surface> targetFile=<targetFile>` to `.sdlc/learnings/log.md` and continue. Emit `dispatch-harden` (`{ surface, targetFile, hardenExitCode }`) and `meta-analyze-findings: completed | dispatched=<N> deferred=<N> suppressed=<N>`.

---

## Step 11.7 — LINK VERIFICATION — HARD GATE

Before any `gh api` reply is posted, pipe concatenated reply bodies (one per line) on stdin to (`expectedRepo` and `jiraSite` are auto-derived — do NOT construct ctx JSON):

```shell
node "<PLUGIN_ROOT>/scripts/util/received-review-validate-links.js"
```

- **Non-zero exit (`LINK_EXIT != 0`):** Do NOT post replies or proceed to Step 12. Surface stderr violations verbatim and stop — do not retry, edit URLs without user input, or bypass.
- **Zero exit:** Proceed to Step 12. (`SDLC_LINKS_OFFLINE=1` keeps identity/host checks offline.)

---

## Step 12 — REPLY & RESOLVE: Post PR Thread Replies

**Mandatory step after Step 11 completes.**

1. **Summarize:** `N comments addressed`, `M comments pushed back`, `K comments intentionally skipped`.
2. **Consent gate:**
   - Bypass-eligible findings (`alwaysFixSeverities`) post/resolve with no prompt (`fixed: <description>`).
   - **Auto mode (`flags.auto` true):** Skip `ask_question`, display summary, post all replies. Resolve all "agree, will fix" threads if `alwaysFixSeverities` is empty; if non-empty, resolve only bypass-eligible threads and add the rest to the follow-up summary. Pushback / "won't fix" threads stay open. Pipeline context never overrides this.
   - **Manual mode (default):** `ask_question`: *"Should I reply to all addressed review comments on the PR and resolve the threads?"* (**yes** | **skip** | **selective**).
3. **Post & resolve (`yes`, `selective`, or auto):** Append `manifest.reply_footer` verbatim to `<body>`:
   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies -f body="<body><footer>"
   gh api graphql -f query='mutation($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { isResolved } } }' -F threadId="<thread_id>"
   ```
   | Type | `<body>` | Resolve? |
   |---|---|---|
   | Addressed (`agree, will fix`) | `Fixed — <brief description of what was changed>` | Yes (manual `implement`/`selective`; auto per rule above) |
   | Pushback (`disagree`) | Drafted pushback response (Step 7) | No — leave open |
   | Intentionally skipped (`agree, won't fix`) | `Acknowledged — not fixing in this PR because: <reason>` | No — let reviewer decide |
4. **Report results:** `Replied to N threads: K resolved (fixed), M replied with pushback, J replied with skip reason`.

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
- Use `ask_question` in Step 11.6 when `flags.auto` is true — the auto-mode matrix governs all Step 11.6 decision sites; cite `flags.auto` and `flags.alwaysHardenFromReview` (resolved manifest fields) exclusively, never raw `$ARGUMENTS`
- Skip `workflows/verify.py` (or Step 3a's `received-review-orchestrator` fallback) and verify inline when a Step 1a manifest exists — use Step 3b only as the documented fallback

---

## See Also

- [`./resources/verify-fallback-and-playbook.md`](./resources/verify-fallback-and-playbook.md) — Step 1b/3a/3b fallback, pushback examples, error recovery, gotchas, learning capture
- [`/review-sdlc`](../review-sdlc/SKILL.md) — source of findings this skill responds to
- [`/commit-sdlc`](../commit-sdlc/SKILL.md) — commit fixes; [`/pr-sdlc`](../pr-sdlc/SKILL.md) — PR being reviewed
