---
name: review-sdlc
description: "Use this skill when reviewing code changes across project-defined dimensions (security, performance, docs, concurrency, etc.). Runs skill/review.js to pre-compute all git data, then delegates to the review-orchestrator agent. Arguments: [--base <branch>] [--committed] [--staged] [--working] [--worktree] [--set-default] [--dimensions <name,...>] [--dry-run]. Triggers on: review changes, code review, review PR, multi-dimension review, run review."
user-invocable: true
argument-hint: "[--base <branch>] [--committed] [--staged] [--dimensions <name,...>]"
model: gemini-3.5-flash-medium
---

# Reviewing Changes

Thin dispatcher — runs the prepare script, then delegates everything to the
`review-orchestrator` agent (which spawns dimension subagents in parallel).

**Announce at start:** "I'm using review-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

---

## Step 0 — Resolve and Run skill/review.js

> **VERBATIM** — Execute this script directly using its absolute path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin. Note the strict script location pattern: `<PLUGIN_ROOT>/skills/<skill-name>/scripts/<script-name>.sh`). Do NOT prepend `bash` or `sh`. Do not modify, rephrase, or simplify the commands.

```shell
<PLUGIN_ROOT>/skills/review-sdlc/scripts/prepare.sh
```

**On non-zero `EXIT_CODE`:**

- Exit code 1: show the stderr message to the user and stop.
- Exit code 2: show `Script error — see output above` and stop.

**On script crash (exit 2):** Invoke error-report-sdlc — Glob `**/error-report-sdlc/REFERENCE.md`, follow with skill=review-sdlc, step=Step 0 — skill/review.js execution, error=stderr.

**Do NOT read the manifest file contents into the main context.** The orchestrator will read it.

---

## Step 1 — Dry Run Check

Only if `--dry-run` was passed in `$ARGUMENTS`:

Read `MANIFEST_FILE` and output **exactly** this format:

```
Review Plan (dry run — no subagents dispatched)

  Base branch:    {manifest.base_branch}
  Changed files:  {manifest.git.changed_files.length}
  Dimensions:     {manifest.summary.active_dimensions} active, {manifest.summary.skipped_dimensions} skipped

| Dimension | Files | Severity | Status |
|-----------|-------|----------|--------|
{one row per entry in manifest.dimensions}

Plan critique:
  - Uncovered files:       {manifest.plan_critique.uncovered_files.join(', ') or "none"}
  - Over-broad:            {manifest.plan_critique.over_broad_dimensions.join(', ') or "none"}
  - Suggested dimensions:  {manifest.plan_critique.uncovered_suggestions.map(s => s.dimension).join(', ') or "none"}

To execute the full review, run /review-sdlc (without --dry-run).
```

Stop here. The `trap` declared at Step 1 cleans up `$MANIFEST_FILE` automatically on shell exit.

---

## Step 2 — Spawn Orchestrator Agent

Spawn a single Agent using `subagent_type: sdlc:review-orchestrator` with the following
context as the prompt:

```
MANIFEST_FILE: {the temp file path from Step 0}
PROJECT_ROOT: {current working directory}
```

The orchestrator will read the manifest, resolve resources/REFERENCE.md, dispatch dimension
subagents, critique/deduplicate, format the comment, and persist the consolidated
comment body to `${diff_dir}/review-comment.md`. It does NOT post to a PR and does
NOT prompt the user — the skill handles posting in Step 4.

Wait for the orchestrator to return its summary.

**On orchestrator failure:** Re-dispatch once with the same inputs. If the second
attempt also fails, invoke error-report-sdlc with skill=review-sdlc,
step=Step 2 — orchestrator dispatch, error=agent error output. A failure retry counts
as the same attempt for quality-gate G4 — user confirmation in Step 4 MUST NOT trigger
a new orchestrator dispatch.

---

## Step 3 — Parse Orchestrator Summary and Display Full Comment Body

This step implements R13 and quality gate G5: the user MUST see the full
consolidated review (every per-dimension finding, every severity) in the terminal
before any posting prompt. The orchestrator summary alone contains only severity
counts and is insufficient.

1. Display the orchestrator's summary to the user verbatim.

2. Parse the summary to extract:

   - `comment_file` — absolute path to `${diff_dir}/review-comment.md`
   - `pr.exists` (boolean), `pr.owner`, `pr.repo`, `pr.number`
   - `verdict` — one of `CHANGES REQUESTED`, `APPROVED WITH NOTES`, `APPROVED`
   - `scope` — scope label from the summary
   - `branch` — current branch name
   - `diff_dir` — absolute path to the orchestrator's working diff dir

3. **Display full comment body (implements R13).** Use the Read tool to load the
   file at `comment_file`, then emit its full contents verbatim to the user inside
   a fenced markdown block. No summarization, no truncation, no per-severity
   collapsed table, no "Additional finding (see PR comment for details)"
   placeholders. The full body must be visible in the terminal before Step 4's
   posting prompt is shown.

   ### DO NOT (Step 3 display)

   - Do NOT summarize or paraphrase findings — emit the file contents byte-for-byte
   - Do NOT collapse any finding to a placeholder like
     "Additional finding (see PR comment for details)"
   - Do NOT synthesize a severity/count table in place of the persisted body —
     the orchestrator summary already provides counts; Step 3 must emit the
     per-finding detail
   - Do NOT skip the Read step even if the orchestrator summary appears
     "complete" — the summary is metadata only

Do NOT delete the manifest file here — cleanup happens in Step 6 on every terminal branch.

---

## Step 4 — Handle Posting

This step runs entirely in the main context. It MUST NOT dispatch a new Agent, and
MUST NOT re-invoke the orchestrator. The comment body at `comment_file` is authoritative.

### PR exists (`pr.exists == true`)

Prompt in the main context:

```text
Post this review comment to PR #{pr.number}? (yes / save / cancel)
  yes    — post the comment to the PR
  save   — save review to .sdlc/reviews/<branch>-<YYYY-MM-DD>.md instead
  cancel — keep in terminal only (already shown above)
```

Wait for the user's reply.

- `yes` → **link verification (R14, issue #198) — HARD GATE.** Before `gh api … /comments`, validate every URL embedded in the consolidated review comment body via the shared link validator. The script reads the body from `--file` and auto-derives `expectedRepo` from `parseRemoteOwner(cwd)` and `jiraSite` from `~/.sdlc-cache/jira/` — the skill MUST NOT construct ctx JSON.

  ```shell
<PLUGIN_ROOT>/skills/review-sdlc/scripts/validate_links.sh
```

> **Contract (Input/Output):**
> - **Input**: Concatenated reply bodies (one per line) fed strictly via `stdin`. No CLI arguments are expected.
> - **Output**: Prints violations to `stderr` and exits non-zero if invalid links are found. Exits 0 on success.

  On non-zero exit (`LINK_EXIT != 0`):
  - The script has already printed the violation list to stderr.
  - Do NOT execute `gh api … /comments`. Surface the violation list verbatim to the user.
  - Stop. Do not retry. Do not edit URLs without user input. Do not bypass.

  On zero exit, post the comment via `gh api` using the file body form (safe for large markdown, backticks, quotes):

  ```bash
  gh api repos/{pr.owner}/{pr.repo}/issues/{pr.number}/comments -F body=@{comment_file}
  ```

  `SDLC_LINKS_OFFLINE=1` skips network reachability while keeping context-aware checks — use in sandboxed CI.

- `save` →

  ```bash
  BRANCH_SAFE="${branch//\//-}"
  mkdir -p .sdlc/reviews
  cp "{comment_file}" ".sdlc/reviews/${BRANCH_SAFE}-$(date +%Y-%m-%d).md"
  ```

- `cancel` → no action. The comment is already visible in the terminal from Step 3.

### No PR, branch scope (`scope` is `all`, `committed`, or `worktree`)

Prompt:

```text
No PR found. Options:
  1. Create a draft PR and attach this review as a comment
  2. Save review to .sdlc/reviews/<branch>-<YYYY-MM-DD>.md
  3. Keep in terminal only
```

- Option 1 → invoke `pr-sdlc` from the main context in draft mode, wait for PR
  creation, then post via the `gh api … -F body=@{comment_file}` command above using
  the newly created PR's owner/repo/number.
- Option 2 → same `save` command as above.
- Option 3 → no action.

### No PR, local scope (`scope` is `staged` or `working`)

Prompt:

```text
Reviewing local changes — no PR to post to. Options:
  1. Save review to .sdlc/reviews/<branch>-<YYYY-MM-DD>.md
  2. Keep in terminal only
```

- Option 1 → `save` command above.
- Option 2 → no action.

---

## Step 5 — Offer Self-Fix

If the verdict is **CHANGES REQUESTED** or **APPROVED WITH NOTES**, offer to fix:

> The review found actionable items. Address them now?

- **fix** — invoke `received-review-sdlc` (findings are in conversation context)
- **harden** — run `/harden-sdlc` to analyze why this failed and propose stronger guardrails / dimensions / instructions that would catch it earlier next time. Opt-in — no surface is edited without your approval. (Offered only when verdict is **CHANGES REQUESTED** with at least one dimension blocker; suppressed when `--auto` is set.)
- **no** — done

When the user selects **harden**, dispatch `Skill(harden-sdlc)` with `--failure-text "Review verdict CHANGES REQUESTED — dimension blocker(s): <dimension-list>"`, `--skill review-sdlc`, `--step "Step 5 — actionable findings"`, `--operation "self-fix offer"`. Implements R16.

If verdict is **APPROVED**: skip — nothing to fix.

---

## Step 6 — Cleanup

Clean up the manifest file and the temporary diff directory by running:

```shell
<PLUGIN_ROOT>/skills/review-sdlc/scripts/cleanup.sh "$MANIFEST_FILE"
```

---

## DO NOT

- Do NOT read the manifest JSON into main context (the orchestrator reads it)
- Do NOT read resources/REFERENCE.md in main context (the orchestrator resolves it)
- Do NOT read the orchestrator agent definition into main context — pass the file path or use the sdlc:review-orchestrator subagent_type
- Do NOT invoke error-report-sdlc for user errors — only for script crashes (exit 2)
- Do NOT re-dispatch the orchestrator to post the comment — use the `comment_file` from its summary

## See Also

- `agents/review-orchestrator.md` — full orchestration logic
- `resources/REFERENCE.md` — dimension format spec, subagent prompt template, comment template
- [`/setup-sdlc --dimensions`](../setup-sdlc/SKILL.md) — creates review dimensions
- [`/received-review-sdlc`](../received-review-sdlc/SKILL.md) — responds to findings
- [`/commit-sdlc`](../commit-sdlc/SKILL.md) — commit after review approval
