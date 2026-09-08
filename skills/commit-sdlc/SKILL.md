---
name: commit-sdlc
description: "Use this skill when committing staged changes, creating a git commit, or generating a commit message. Analyzes staged diff and recent commit history to generate a message matching the project's style. Stashes unstaged changes to isolate the commit, commits after user confirmation, and auto-restores the stash. Arguments: [--no-stash] [--scope <scope>] [--type <type>] [--amend] [--auto] [--force-default-branch]. Use --auto to skip interactive approval. Triggers on: commit changes, create commit, write commit message, git commit, smart commit, commit staged, stage and commit."
user-invocable: true
argument-hint: "[--no-stash] [--scope <scope>] [--type <type>] [--amend] [--auto] [--force-default-branch]"
model: gemini-3.8-flash-medium
---


# Smart Commit Skill

Consume pre-computed commit context from `skill/commit.js`, generate a commit message
matching the project's style, optionally stash unstaged changes, commit after user
confirmation, and auto-restore the stash.

**Announce at start:** "I'm using commit-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

## Workflow

## Step 0 — Plan Mode Check

If the system context contains "Plan mode is active":

1. Announce: "This skill requires write operations (git commit). Exit plan mode first, then re-invoke `/commit-sdlc`."
2. Stop. Do not proceed to subsequent steps.

---

### Step 0: Resolve and Run skill/commit.js

> **VERBATIM** — Execute this command directly with `node` and the absolute plugin path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin. Note the strict CLI location pattern: `<PLUGIN_ROOT>/scripts/<skill|util|lib>/<script-name>.js`). Do not modify, rephrase, or simplify the flags.

```shell
COMMIT_CONTEXT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/commit.js" $ARGUMENTS)
EXIT_CODE=$?
```
> **Contract (Input/Output):**
> - **Input**: `$ARGUMENTS` (the skill's own arguments), forwarded verbatim.
> - **Output**: Prints the path of a JSON manifest of staged diffs and commit history on stdout — capture it into `COMMIT_CONTEXT_FILE`. Its exit code is `EXIT_CODE`.

Read and parse `COMMIT_CONTEXT_FILE` as `COMMIT_CONTEXT_JSON`.

**On non-zero `EXIT_CODE`:**

- Exit 1: show `COMMIT_CONTEXT_JSON.errors[]`, run `rm -f "$COMMIT_CONTEXT_FILE"`, stop.
- Exit 2 (crash): show `Script error — see output above`, same cleanup, then invoke error-report-sdlc (Glob `**/error-report-sdlc/REFERENCE.md`; skill=commit-sdlc, step=Step 0, error=stderr).

If `COMMIT_CONTEXT_JSON.warnings` is non-empty, show them before continuing.

**Default-branch guard:** `onDefaultBranch === true` is already surfaced by the handling above — `--auto` without `--force-default-branch` blocks via `errors[]`, otherwise the warning is shown and Step 5's AskUserQuestion still lets the user decide. Never re-derive branch state via `git symbolic-ref` or re-parse `$ARGUMENTS`.

### Step 0.5 (BRANCH-GUARD): HARD GATE — Expected Branch Check

Check `branchGuard.active` and `branchGuard.ok` from `COMMIT_CONTEXT_JSON`.

If `branchGuard.active === true` AND `branchGuard.ok === false`:
- Surface `branchGuard.message` verbatim to the user.
- Halt the skill immediately. Do NOT proceed to Step 1 or any `git commit` invocation.
- Do NOT re-derive the current branch via shell commands — use the resolved `branchGuard` field only.

If `branchGuard.active === false` (flag was not passed) or `branchGuard.ok === true` (branches match): proceed to Step 1.

---

### Step 1 (CONSUME): Quick Context Read

Read just enough from `COMMIT_CONTEXT_JSON` for the main-context flow (Step 5 onwards): `currentBranch`, `flags`, `staged.files`, `staged.fileCount`, `staged.diffStat`, `unstaged.hasChanges`, `commitConfig.subjectPattern`, `commitConfig.subjectPatternError`. Heavy fields — `staged.diff`, `recentCommits`, `lastCommitMessage`, full `commitConfig` — are consumed by the orchestrator agent below; do **not** read or quote them in main context.

### Step 1c (WIP-commit squash detection)

`COMMIT_CONTEXT_JSON.wipSquash` reports `wip(execute):` commits from execute-plan-sdlc per-wave commits between the branch's fork-point and `HEAD`: `{ commits: [<sha>,...], stagedClean, forkPoint }`.

- `commits.length === 0`: skip silently, proceed to Step 2 with the staged diff unchanged.
- `commits.length > 0` and `flags.noSquashWip === true`: print `Detected N wip(execute): commit(s) — preserving (--no-squash-wip).` and proceed to Step 2 unchanged; the WIP commits stay in history.
- `commits.length > 0` and `flags.noSquashWip === false` (default): print `Detected N wip(execute): commit(s). The final commit will subsume them via soft-reset.`, then run:
  ```shell
  node "<PLUGIN_ROOT>/scripts/skill/commit.js" --squash-execute --fork-point "<wipSquash.forkPoint>"
  ```
  > **Contract (Input/Output):**
  > - **Input**: `--fork-point <sha>` — the value from `wipSquash.forkPoint` (never re-derived via `git merge-base`).
  > - **Output**: `{"status": "squashed", "forkPoint": "<sha>"}` on success (exit 0), or `{"status": "failed", ..., "message": "<reason>"}` on failure (exit 1). On failure, show `message` and stop — do not proceed to Step 2.

  On success the staged diff reflects the full squashed change (every WIP'd file plus any hand-edits); proceed to Step 2, where the orchestrator generates one conventional-commit subject for it.

**No `wip:` prefix in the final subject:** enforced twice — a reminder in the Step 2 orchestrator prompt, and a deterministic regex check (`^wip(\(|:)`) in `commit.js` before the approval prompt fires (reject + re-dispatch on match).

### Step 2 (PLAN): Dispatch the commit-orchestrator Agent

To keep the main context clean and bound the orchestrator's input to the prepared payload only, dispatch the dedicated `commit-orchestrator` agent.

Use the `Agent` tool with:

- `subagent_type`: `sdlc:commit-orchestrator`
- `model`: `gemini-3.8-flash-low` (overrides agent frontmatter to keep this bounded task on a lightweight model)
- `prompt` (exactly two lines, no other content):

  ```text
  MANIFEST_FILE: <COMMIT_CONTEXT_FILE>
  PROJECT_ROOT: <cwd>
  ```

  Substitute `<COMMIT_CONTEXT_FILE>` with the absolute temp-file path captured in Step 0. Substitute `<cwd>` with the current working directory.

The orchestrator reads the manifest, applies every `commitConfig` constraint (`subjectPattern`, `allowedTypes`, `allowedScopes`, `requireBodyFor`, `requiredTrailers`), detects style from `recentCommits`, runs its own self-critique loop, and returns ONLY the final commit message string. It does not call `git`, does not write files, does not invoke `gh`.

Capture the orchestrator's return value as `MESSAGE`. If `MESSAGE` is empty, the orchestrator detected an `errors[]` array in the manifest — surface those errors and stop.

**OpenSpec scope hint (main context, optional):** If `flags.scope` is NOT set, Glob for `openspec/config.yaml`. If found, Glob `openspec/changes/*/proposal.md` (exclude `archive/`). If exactly one active change exists, or one matches the current branch name, append an `OpenSpec-Change: <change-directory-name>` trailer to `MESSAGE` (after a blank line; only if `MESSAGE` already has a body — do not add a body solely for the trailer). If recent commits don't use scopes, the trailer is still optional.

### Step 3 (CRITIQUE) and Step 4 (IMPROVE)

The orchestrator agent owns Steps 3 (CRITIQUE) and 4 (IMPROVE) internally. The main context does not re-run them; the orchestrator's returned `MESSAGE` is already self-critiqued against the Quality Gates below.

### Step 5 (DO): Present and Execute

Show the full commit plan to the user with the `MESSAGE` returned by the orchestrator and the staged-file summary read in Step 1. **Do not execute any git commands before receiving explicit user approval via AskUserQuestion.**

**Auto mode:** When `flags.auto` is true, skip the AskUserQuestion prompt entirely. Still display the full commit plan for visibility, then proceed directly to execution. Treat the response as an implicit `yes`. The orchestrator's internal critique already ran in Step 2 — only the interactive approval prompt is skipped.

Show a heading (`Commit`/`Amend`), the message (subject + body), the staged file list with diffstat, a `Trailer:` line when an OpenSpec trailer applies, and a `Stash:` line naming the unstaged files that will be stashed and restored.

Use AskUserQuestion to ask:
> Commit as shown?

Options:
- **yes** — commit as shown
- **edit** — tell me what to change
- **cancel** — abort

Omit the `Stash:` line if `unstaged.hasChanges` is false or `flags.noStash` is true.
Show `Amend:` instead of `Commit:` heading when `flags.amend` is true.

**On `yes`:**

0. **Subject pattern gate (hard gate):** If `commitConfig.subjectPattern` is set, validate the subject line first:

   ```shell
   node "<PLUGIN_ROOT>/scripts/util/validate-commit-subject.js" "<subjectPattern>" "<subject line>"
   ```
   Exit 0 → continue to step 1. Exit 1 → show `commitConfig.subjectPatternError` (fallback: the pattern itself), do not commit, and use AskUserQuestion:
   - **edit subject** — revise and re-run the gate
   - **harden** — dispatch `Skill(harden-sdlc)` with `--failure-text "Subject pattern reject: subject '<line>' does not match pattern '<subjectPattern>' — error: <subjectPatternError>"`, `--skill commit-sdlc`, `--step "Step 5 — subject pattern gate"`, `--operation "subject pattern validation"` (opt-in, targets the regex/error message not the subject; suppressed under `--auto`)
   - **cancel** — abort
   No non-edit override of this gate.

1. **Link verification — HARD GATE.** Before `git commit`, validate every URL embedded in the commit message body via the shared link validator. The script reads the body from stdin and auto-derives `expectedRepo` from `parseRemoteOwner(cwd)` and `jiraSite` from `~/.sdlc-cache/jira/` — the skill MUST NOT construct ctx JSON.

   ```shell
node "<PLUGIN_ROOT>/scripts/util/commit-validate-links.js"
```
> **Contract (Input/Output):**
> - **Input**: Commit body via stdin, or via `--file <path>` argument.
> - **Output**: Prints violations to stderr and exits non-zero on broken links.


   On non-zero exit (`LINK_EXIT != 0`):
   - The script has already printed the violation list to stderr (URL, line, reason code, observed/expected detail).
   - Do NOT execute `git commit`. Surface the violation list verbatim to the user.
   - Stop. Do not retry. Do not edit URLs without user input. Do not bypass.

   On zero exit, proceed to the stash + commit steps below. `SDLC_LINKS_OFFLINE=1` skips network reachability while keeping context-aware checks (GitHub identity match, Atlassian host match) — use in sandboxed CI.

2. Run the stash-transaction script — it stashes unstaged changes (unless `flags.noStash`), commits, and pops the stash, in one step:
   ```shell
   node "<PLUGIN_ROOT>/scripts/skill/commit.js" --stash-transaction --message "<message>"
   ```
   Add `--amend` when `flags.amend` is true, and `--no-stash` when `flags.noStash` is true.
   > **Contract (Input/Output):**
   > - **Input**: `--message <msg>` (required), `--amend`, `--no-stash`.
   > - **Output**: one JSON line `{"committed": bool, "hookFailed": bool, "classification": "hook"|"identity"|"gpg"|"nothing-to-commit"|"protected-branch"|"ambiguous"|"other", "popConflict": bool}`, with an additive `reason`/`detail` on a stash-push or commit failure, or `conflictFiles: string[]` when `popConflict` is true.

   Branch on the result:
   - `{"committed": true, "hookFailed": false, "popConflict": false}` — success; any stash was restored cleanly.
   - `{"committed": false, "hookFailed": true, "classification": "hook"|"ambiguous", ...}` — the pre-commit hook failed (or hook presence could not be determined, treated the same way); the stash is deliberately left in place. Inform the user: "Pre-commit hook failed. Your unstaged changes are stashed (`git stash list` to see). Fix the hook issue, re-stage your changes, and re-run `/commit-sdlc`."
   - `{"committed": false, "hookFailed": false, "classification": "identity"|"gpg"|"nothing-to-commit"|"protected-branch"|"other", "reason": "...", "detail": "..."}` — the commit itself failed (not a hook). Show `reason` and `detail`; the stash is deliberately left in place — keep the same stash-recovery note as above (`git stash list`, fix the issue, re-stage, re-run `/commit-sdlc`). Then:
     - `classification` is `identity`, `nothing-to-commit`, or `protected-branch` — user-actionable; show a one-line hint instead of invoking error-report-sdlc:
       - `identity`: "Configure your git identity: `git config user.name` / `git config user.email`."
       - `nothing-to-commit`: "Nothing to commit — stage changes with `git add` and retry."
       - `protected-branch`: "The remote rejected this as a protected branch — target a feature branch or open a PR instead."
     - `classification` is `other` or `gpg` — invoke error-report-sdlc (see Error Recovery below).
   - `{"committed": true, "hookFailed": false, "popConflict": true, "conflictFiles": [...]}` — the commit landed but the stash-pop conflicted; warn the user with `conflictFiles` and suggest `git stash show -p` and manual resolution.
   - `{"committed": false, "hookFailed": false, "popConflict": false, "reason": "git stash push failed", "detail": "..."}` — the stash push itself failed before any commit was attempted; show `detail` and stop.

**On `edit`:** Ask what to change, revise the message, and present again. Loop until explicit `yes` or `cancel`. Re-dispatching the orchestrator is not required for small wording tweaks — apply user-supplied edits to `MESSAGE` directly and re-validate against the subject-pattern gate before re-presenting.

**On `cancel`:** Abort without changes. Run `rm -f "$COMMIT_CONTEXT_FILE"` to clean up the manifest.

### Step 6 (CRITIQUE): Verify

Run `git log -1 --oneline` to confirm the commit was created. If stash was used, confirm it was popped via `git stash list`.

Show the result:

```
✓ Committed: a1b2c3d feat(auth): add OAuth2 PKCE flow
  Files:   3 files changed, +142, -12
  Stash:   restored (2 unstaged files back in working tree)
```

Omit the `Stash:` line if no stash was used.

Run `rm -f "$COMMIT_CONTEXT_FILE"` to clean up the manifest.

---

## Quality Gates

The orchestrator's self-critique (Step 4 of `agents/commit-orchestrator.md`) enforces style match, subject length, accuracy, type/scope correctness, imperative mood, no fabrication, body relevance, and every `commitConfig` pattern/body/trailer requirement before returning `MESSAGE`. The main context runs only the two deterministic post-gates in Step 5: subject-pattern regex and link validation.

## DO NOT

- Include file paths in the subject line
- Pass `--amend`/`--no-stash` to the stash-transaction script except when `flags.amend`/`flags.noStash` say so
- Assume untracked files get stashed — the script uses `--keep-index` with no `--include-untracked`

## Error Recovery

> **Flow**: detect → diagnose → auto-recover (retry once if transient) → invoke `error-report-sdlc` for persistent failures.

`commit.js` crashes (exit 2) and `git stash push` failures invoke error-report-sdlc. For a commit failure, only `classification ∈ {other, gpg}` invokes error-report-sdlc — `identity`, `nothing-to-commit`, and `protected-branch` are user-actionable and get the one-line hint in Step 5 instead; `hook`/`ambiguous` are the existing hook-failure message, not an error report. User-facing errors (`errors[]`, no staged changes, hook failure, stash-pop conflict — see Step 0/Step 5 above) do not invoke error-report-sdlc. When invoking, provide: **Skill**: commit-sdlc, **Step**: Step 0 or Step 5, **Operation**: the failing command, **Error**: exit code + stderr, **Suggested investigation**: git identity, branch protection rules, hook scripts.

---

## Gotchas

- **Amend on main/master**: A warning is shown when `--amend` is used on a protected branch. The skill does not block — this is the user's decision.
- **Empty body**: A commit body is optional. Only include one when the staged diff is non-trivial and the "why" adds real value.
- **Single commit in repo**: `git log --oneline -15` may return fewer than 15 lines on a new repo. This is fine — the LLM falls back to conventional commits as the default style.

## Learning Capture

After completing a commit, if the project's detected commit style was non-conventional or unusual, append to `.sdlc/learnings/log.md`:

```
## YYYY-MM-DD — commit-sdlc: <brief summary>
<what was learned about this project's commit style or any edge case encountered>
```

## See Also

- [`/review-sdlc`](../review-sdlc/SKILL.md) — review changes after committing
- [`/pr-sdlc`](../pr-sdlc/SKILL.md) — create a PR after committing
- [`/version-sdlc`](../version-sdlc/SKILL.md) — tag a release after committing
