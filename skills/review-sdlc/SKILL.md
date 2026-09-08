---
name: review-sdlc
description: "Use this skill when reviewing code changes across project-defined dimensions (security, performance, docs, concurrency, etc.). Runs skill/review.js to pre-compute all git data, then delegates to the review-orchestrator agent. Arguments: [--base <branch>] [--committed] [--staged] [--working] [--worktree] [--set-default] [--dimensions <name,...>] [--dry-run]. Triggers on: review changes, code review, review PR, multi-dimension review, run review."
user-invocable: true
argument-hint: "[--base <branch>] [--committed] [--staged] [--working] [--worktree] [--set-default] [--dimensions <name,...>] [--dry-run]"
model: gemini-3.8-flash-medium
---

# Reviewing Changes

Thin dispatcher — runs the prepare script, then delegates everything to the
`review-orchestrator` agent (which spawns dimension subagents in parallel).

**Announce at start:** "I'm using review-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

## Step 0 — Resolve and Run skill/review.js

> **VERBATIM** — Run this command exactly as written, invoking the script with `node` and its absolute path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin. Note the strict script location pattern: `<PLUGIN_ROOT>/scripts/<group>/<script-name>.js`, where `<group>` is one of `skill`, `util`, `lib`, `state`, or `ci`). There is no shell wrapper — always call `node` on the `.js` file directly. Do not modify, rephrase, or simplify the commands.

```shell
MANIFEST_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/review.js" $ARGUMENTS)
EXIT_CODE=$?
```

`review.js` forwards `$ARGUMENTS` verbatim, writes its JSON payload to a temp file, and prints only that path to stdout — there is no `MANIFEST_FILE:` / `STATUS:` preamble to parse, and no `--json` flag to pass (`review.js` does not parse one; the manifest-file protocol is unconditional). `EXIT_CODE` is the script's own exit status.

**On non-zero `EXIT_CODE`:** exit 1 → show the stderr message and stop; exit 2 → show `Script error — see output above`, then invoke error-report-sdlc (Glob `**/error-report-sdlc/REFERENCE.md`, follow with skill=review-sdlc, step=Step 0 — skill/review.js execution, error=stderr) and stop.

**Do NOT read the manifest file contents into the main context.** The orchestrator will read it.

## Step 1 — Dry Run Check

Only if `--dry-run` was passed in `$ARGUMENTS`: read `MANIFEST_FILE` and output **exactly** this format:

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

Then clean up and stop:

```shell
node "<PLUGIN_ROOT>/scripts/util/review-cleanup.js" "$MANIFEST_FILE"
```

## Step 2 — Spawn Orchestrator Agent

Spawn a single Agent (`subagent_type: sdlc:review-orchestrator`) with this prompt:

```
MANIFEST_FILE: {the temp file path from Step 0}
PROJECT_ROOT: {current working directory}
```

The orchestrator reads the manifest, dispatches dimension subagents, and persists the
consolidated comment to `${diff_dir}/review-comment.md`. It does not post to a PR and
does not prompt the user — Step 4 handles posting. Wait for it to return its summary.

**On orchestrator failure:** Re-dispatch once with the same inputs. If the second
attempt also fails, invoke error-report-sdlc with skill=review-sdlc,
step=Step 2 — orchestrator dispatch, error=agent error output. A retry counts as the
same attempt — user confirmation in Step 4 MUST NOT trigger a new orchestrator dispatch.

## Step 3 — Parse Orchestrator Summary and Display Full Comment Body

The user MUST see the full consolidated review (every finding, every severity) in the
terminal before any posting prompt — the orchestrator summary alone contains only
severity counts.

1. Display the orchestrator's summary to the user verbatim.
2. Parse from it: `comment_file` (absolute path to `${diff_dir}/review-comment.md`),
   `pr.exists`/`pr.owner`/`pr.repo`/`pr.number`, `verdict` (`CHANGES REQUESTED` /
   `APPROVED WITH NOTES` / `APPROVED`), `scope`, `branch`, `diff_dir`.
3. Read `comment_file` with the Read tool and emit its full contents byte-for-byte
   inside a fenced markdown block — no summarization, no truncation, no collapsed
   severity table, no "see PR comment for details" placeholders. This must be visible
   before Step 4's posting prompt.

Do NOT delete the manifest file here — cleanup happens in Step 6 on every terminal branch.

## Step 4 — Handle Posting

This step runs entirely in the main context. It MUST NOT dispatch a new Agent, and
MUST NOT re-invoke the orchestrator. The comment body at `comment_file` is authoritative.

Shared **save** action (used by every scope below):

```bash
BRANCH_SAFE="${branch//\//-}"
mkdir -p .sdlc/reviews
cp "{comment_file}" ".sdlc/reviews/${BRANCH_SAFE}-$(date +%Y-%m-%d).md"
```

Shared **post** action (used only when `pr.exists == true`): link verification is a
**HARD GATE** before posting. Validate every URL in the comment body:

```shell
node "<PLUGIN_ROOT>/scripts/util/review-validate-links.js" --file <body-path>
```

It auto-derives `expectedRepo` from `parseRemoteOwner(cwd)` and `jiraSite` from
`~/.sdlc-cache/jira/`, and exits non-zero (violations printed to stderr) if any link is
invalid; `SDLC_LINKS_OFFLINE=1` skips network reachability while keeping context-aware
checks (use in sandboxed CI).

- Non-zero exit → do NOT post. Surface the violation list verbatim. Stop — do not
  retry, edit URLs unprompted, or bypass.
- Zero exit → post via `gh api` (file-body form, safe for large markdown):

  ```bash
  gh api repos/{pr.owner}/{pr.repo}/issues/{pr.number}/comments -F body=@{comment_file}
  ```

### PR exists (`pr.exists == true`)

```text
Post this review comment to PR #{pr.number}? (yes / save / cancel)
  yes    — post the comment to the PR
  save   — save review to .sdlc/reviews/<branch>-<YYYY-MM-DD>.md instead
  cancel — keep in terminal only (already shown above)
```

`yes` → run the **post** action above. `save` → run the **save** action above.
`cancel` → no action.

### No PR, branch scope (`scope` is `all`, `committed`, or `worktree`)

```text
No PR found. Options:
  1. Create a draft PR and attach this review as a comment
  2. Save review to .sdlc/reviews/<branch>-<YYYY-MM-DD>.md
  3. Keep in terminal only
```

Option 1 → invoke `pr-sdlc` from the main context in draft mode, wait for PR creation,
then run the **post** action using the newly created PR's owner/repo/number. Option 2 →
run the **save** action. Option 3 → no action.

### No PR, local scope (`scope` is `staged` or `working`)

```text
Reviewing local changes — no PR to post to. Options:
  1. Save review to .sdlc/reviews/<branch>-<YYYY-MM-DD>.md
  2. Keep in terminal only
```

Option 1 → run the **save** action. Option 2 → no action.

## Step 5 — Offer Self-Fix

If the verdict is **CHANGES REQUESTED** or **APPROVED WITH NOTES**, offer to fix:

> The review found actionable items. Address them now?

- **fix** — invoke `received-review-sdlc` (findings are in conversation context)
- **harden** — run `/harden-sdlc` to analyze why this failed and propose stronger guardrails / dimensions / instructions that would catch it earlier next time. Opt-in — no surface is edited without your approval. (Offered only when verdict is **CHANGES REQUESTED** with at least one dimension blocker; suppressed when `--auto` is set.)
- **no** — done

When the user selects **harden**, dispatch `Skill(harden-sdlc)` with `--failure-text "Review verdict CHANGES REQUESTED — dimension blocker(s): <dimension-list>"`, `--skill review-sdlc`, `--step "Step 5 — actionable findings"`, `--operation "self-fix offer"`.

If verdict is **APPROVED**: skip — nothing to fix.

## Step 6 — Cleanup

Clean up the manifest file and the temporary diff directory by running:

```shell
node "<PLUGIN_ROOT>/scripts/util/review-cleanup.js" "$MANIFEST_FILE"
```

## DO NOT

- Do NOT read resources/REFERENCE.md in main context (the orchestrator resolves it)
- Do NOT read the orchestrator agent definition into main context — pass the file path or use the sdlc:review-orchestrator subagent_type
- Do NOT invoke error-report-sdlc for user errors — only for script crashes (exit 2)

## See Also

- `agents/review-orchestrator.md` — full orchestration logic
- `resources/REFERENCE.md` — dimension format spec, subagent prompt template, comment template
- [`/setup-sdlc --dimensions`](../setup-sdlc/SKILL.md) — creates review dimensions
- [`/received-review-sdlc`](../received-review-sdlc/SKILL.md) — responds to findings
- [`/commit-sdlc`](../commit-sdlc/SKILL.md) — commit after review approval
