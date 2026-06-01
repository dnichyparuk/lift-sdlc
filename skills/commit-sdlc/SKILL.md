---
name: commit-sdlc
description: "Use this skill when committing staged changes, creating a git commit, or generating a commit message. Analyzes staged diff and recent commit history to generate a message matching the project's style. Stashes unstaged changes to isolate the commit, commits after user confirmation, and auto-restores the stash. Arguments: [--no-stash] [--scope <scope>] [--type <type>] [--amend] [--auto] [--force-default-branch]. Use --auto to skip interactive approval. Triggers on: commit changes, create commit, write commit message, git commit, smart commit, commit staged, stage and commit."
user-invocable: true
argument-hint: "[--no-stash] [--scope <scope>] [--type <type>] [--amend] [--auto] [--force-default-branch]"
model: gemini-3.5-flash
---


# Smart Commit Skill

Consume pre-computed commit context from `skill/commit.js`, generate a commit message
matching the project's style, optionally stash unstaged changes, commit after user
confirmation, and auto-restore the stash.

**Announce at start:** "I'm using commit-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

## When to Use This Skill

- Committing staged changes with an auto-generated message
- Generating a commit message that matches the project's existing style
- Isolating staged changes from unstaged work before committing
- Amending the most recent commit with updated staged changes

## Workflow

## Step 0 — Plan Mode Check

If the system context contains "Plan mode is active":

1. Announce: "This skill requires write operations (git commit). Exit plan mode first, then re-invoke `/commit-sdlc`."
2. Stop. Do not proceed to subsequent steps.

---

### Step 0: Resolve and Run skill/commit.js

> **VERBATIM** — Run this bash block exactly as written. Do not modify, rephrase, or simplify the commands.

```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

SCRIPT="$SDLC_ROOT/scripts/skill/commit.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/commit.js. Is the sdlc plugin installed?" >&2; exit 2; }

COMMIT_CONTEXT_FILE=$(node "$SCRIPT" --output-file $ARGUMENTS)
EXIT_CODE=$?
# No EXIT trap: success-path manifest is persistent (.sdlc/execution/commit-<slug>-<ts>.json)
# so it survives across separate Bash tool invocations. Error-path manifests still write to
# os.tmpdir() via writeOutput. Explicit `rm -f "$COMMIT_CONTEXT_FILE"` at each exit path
# handles both cases.

```

Read and parse `COMMIT_CONTEXT_FILE` as `COMMIT_CONTEXT_JSON`.

**On non-zero `EXIT_CODE`:**

- Exit code 1: The JSON still contains an `errors` array. Show each error to the user, run `rm -f "$COMMIT_CONTEXT_FILE"`, and stop.
- Exit code 2: Show `Script error — see output above`, run `rm -f "$COMMIT_CONTEXT_FILE"`, and stop.

**On script crash (exit 2):** Invoke error-report-sdlc — Glob `**/error-report-sdlc/REFERENCE.md`, follow with skill=commit-sdlc, step=Step 0 — skill/commit.js execution, error=stderr.

**If `COMMIT_CONTEXT_JSON.errors` is non-empty**, show each error message and stop.

**If `COMMIT_CONTEXT_JSON.warnings` is non-empty**, show the warnings to the user before continuing.

**Default-branch guard (R14, fixes #398):** If `COMMIT_CONTEXT_JSON.onDefaultBranch === true`:
- In `--auto` mode without `--force-default-branch`: the prepare script already emitted a `default-branch-auto-block` error in `errors[]` and exited non-zero — the error path above will have already shown the message and stopped. No additional action needed here.
- In interactive mode (or `--auto --force-default-branch`): the warning from `COMMIT_CONTEXT_JSON.warnings[]` matching `default branch` is already shown by the "show warnings" step above. The Step 5 AskUserQuestion prompt still runs — the user makes the final call.
All gates cite `COMMIT_CONTEXT_JSON.onDefaultBranch`, `flags.auto`, `flags.forceDefaultBranch` from prepare output — never re-parse `$ARGUMENTS` or re-run `git symbolic-ref`.

### Step 0.5 (BRANCH-GUARD): HARD GATE — Expected Branch Check

**Implements R-expected-branch (docs/specs/commit-sdlc.md, issues #347, #348, #349).**

Check `branchGuard.active` and `branchGuard.ok` from `COMMIT_CONTEXT_JSON`.

If `branchGuard.active === true` AND `branchGuard.ok === false`:
- Surface `branchGuard.message` verbatim to the user.
- Halt the skill immediately. Do NOT proceed to Step 1 or any `git commit` invocation.
- Do NOT re-derive the current branch via shell commands — use the resolved `branchGuard` field only.

If `branchGuard.active === false` (flag was not passed) or `branchGuard.ok === true` (branches match): proceed to Step 1.

---

### Step 1 (CONSUME): Quick Context Read <!-- implements R1, R2 -->

Read just enough from `COMMIT_CONTEXT_JSON` for the main-context flow (Step 5 onwards): `currentBranch`, `flags`, `staged.files`, `staged.fileCount`, `staged.diffStat`, `unstaged.hasChanges`, `commitConfig.subjectPattern`, `commitConfig.subjectPatternError`. Heavy fields — `staged.diff`, `recentCommits`, `lastCommitMessage`, full `commitConfig` — are consumed by the orchestrator agent below; do **not** read or quote them in main context.

### Step 1c (WIP-commit squash detection) — Fixes #392 / R35

Read `wipSquash` from `COMMIT_CONTEXT_JSON`. The field has the shape:

```json
{
  "wipSquash": {
    "commits": ["<sha>", "<sha>", ...],
    "stagedClean": true
  }
}
```

`commits[]` is the list of commit SHAs whose subject starts with `wip(execute):` between the current branch's fork-point and `HEAD` (per `git log --format='%H %s' <fork>..HEAD`, filtered to subjects matching `^wip\(execute\)`). `stagedClean` is `true` iff `git diff --cached --name-only` returned nothing at prepare time.

**When `wipSquash.commits.length === 0`**: skip this step silently — proceed to Step 2 PLAN with the staged diff unchanged.

**When `wipSquash.commits.length > 0` AND `flags.noSquashWip === true`**: print `Detected N wip(execute): commit(s) from execute-plan-sdlc per-wave commits — preserving (--no-squash-wip).` Skip the squash; proceed to Step 2 with the staged diff unchanged. The WIP commits remain in branch history.

**When `wipSquash.commits.length > 0` AND `flags.noSquashWip === false` (default)**:

1. Print:
   > Detected N `wip(execute):` commit(s) from execute-plan-sdlc per-wave commits. The final commit will subsume them via soft-reset.

2. Resolve the fork-point and soft-reset:
   ```bash
   FORK_POINT=$(git merge-base HEAD "$(git rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null || git symbolic-ref --short HEAD)")
   git reset --soft "$FORK_POINT"
   ```
   The soft-reset preserves all changes in the working tree and index — the WIP commits are dropped from history; nothing on disk changes.

3. Re-stage so user hand-edits on top of the WIP commits (preserved by the soft-reset because `stagedClean === false`) and the unwound WIP file changes are both staged:
   ```bash
   git add -A
   ```

4. The staged diff now reflects the FULL feature change (every file the wave WIPs touched, plus any user hand-edits). Proceed to Step 2 PLAN — the orchestrator will generate a single conventional-commit subject for the squashed change.

**Final-message invariant (no `wip:` prefix):** The orchestrator MUST NOT generate a commit subject starting with `wip:` or `wip(execute):` — those are internal markers. This is enforced at two layers:

1. **LLM-side reminder (defense-in-depth):** Step 2 PLAN dispatch includes a reminder in the orchestrator's prompt: "Even when WIP commits are being squashed, the generated subject MUST NOT start with `wip:` or `wip(execute):` — those are internal markers."
2. **Deterministic post-generation check (load-bearing — `scripts-over-llm-logic` guardrail):** `scripts/skill/commit.js` runs a regex (`^wip(\(|:)`) against the generated subject before the user approval prompt fires. On match, the message is rejected and the orchestrator is re-dispatched with an explicit constraint reminder.

**State-machine idempotency:** Re-running commit-sdlc immediately after a successful squash on the same branch is a no-op: `wipSquash.commits` will be empty (the WIP commits no longer exist between fork-point and HEAD).

### Step 2 (PLAN): Dispatch the commit-orchestrator Agent <!-- implements R3, R4, R5, R6 -->

Issue #202: pinning `model:` in skill frontmatter routes the skill into a subagent that inherits the entire conversation transcript and overflows the smaller-window models on long sessions. To keep the main context clean and bound the orchestrator's input to the prepared payload only, dispatch the dedicated `commit-orchestrator` agent. See `docs/skill-best-practices.md` → "Why frontmatter `model:` is the wrong context-isolation knob" for the rationale.

Use the `Agent` tool with:

- `subagent_type`: `sdlc:commit-orchestrator`
- `model`: `haiku` (the Agent tool `model:` parameter takes precedence over agent frontmatter; passing `haiku` here keeps this bounded task on a lightweight model regardless of the parent context's model)
- `prompt` (exactly two lines, no other content):

  ```text
  MANIFEST_FILE: <COMMIT_CONTEXT_FILE>
  PROJECT_ROOT: <cwd>
  ```

  Substitute `<COMMIT_CONTEXT_FILE>` with the absolute temp-file path captured in Step 0. Substitute `<cwd>` with the current working directory.

The orchestrator reads the manifest, applies every `commitConfig` constraint (`subjectPattern`, `allowedTypes`, `allowedScopes`, `requireBodyFor`, `requiredTrailers`), detects style from `recentCommits`, runs its own self-critique loop, and returns ONLY the final commit message string. It does not call `git`, does not write files, does not invoke `gh`.

Capture the orchestrator's return value as `MESSAGE`. If `MESSAGE` is empty, the orchestrator detected an `errors[]` array in the manifest — surface those errors and stop.

**OpenSpec scope hint (main context, optional):** If `flags.scope` is NOT set, Glob for `openspec/config.yaml`. If found, Glob `openspec/changes/*/proposal.md` (exclude `archive/`). If exactly one active change exists, or one matches the current branch name, append an `OpenSpec-Change: <change-directory-name>` trailer to `MESSAGE` (after a blank line; only if `MESSAGE` already has a body — do not add a body solely for the trailer). If recent commits don't use scopes, the trailer is still optional. The hook context fast-path applies: if the session-start system-reminder has an `OpenSpec active:` line, use it instead of Glob.

### Step 3 (CRITIQUE) and Step 4 (IMPROVE)

The orchestrator agent owns Steps 3 (CRITIQUE) and 4 (IMPROVE) internally. The main context does not re-run them; the orchestrator's returned `MESSAGE` is already self-critiqued against the gate table below.

### Step 5 (DO): Present and Execute

Show the full commit plan to the user with the `MESSAGE` returned by the orchestrator and the staged-file summary read in Step 1. **Do not execute any git commands before receiving explicit user approval via AskUserQuestion.**

**Auto mode:** When `flags.auto` is true, skip the AskUserQuestion prompt entirely. Still display the full commit plan for visibility, then proceed directly to execution. Treat the response as an implicit `yes`. The orchestrator's internal critique already ran in Step 2 — only the interactive approval prompt is skipped.

```
Commit
────────────────────────────────────────────
Message:    feat(auth): add OAuth2 PKCE flow

            Replaces the implicit flow with PKCE to comply with
            the new OAuth 2.1 requirements.

Staged:     3 files changed, +142, -12
  src/auth/pkce.ts
  src/auth/index.ts
  tests/auth/pkce.test.ts

Trailer:    OpenSpec-Change: add-oauth2-pkce  (if applicable)

Stash:      2 unstaged files will be stashed and restored
────────────────────────────────────────────

```

Use AskUserQuestion to ask:
> Commit as shown?

Options:
- **yes** — commit as shown
- **edit** — tell me what to change
- **cancel** — abort

Omit the `Stash:` line if `unstaged.hasChanges` is false or `flags.noStash` is true.
Show `Amend:` instead of `Commit:` heading when `flags.amend` is true.

**On `yes`:**

0. **Subject pattern gate (hard gate):** If `commitConfig` is non-null and `commitConfig.subjectPattern` is set, validate the subject line before proceeding:

   ```bash
   node -e "
     const pattern = new RegExp(process.argv[1]);
     const subject = process.argv[2];
     if (!pattern.test(subject)) { process.exit(1); }
   " "<subjectPattern>" "<subject line>"
   ```

   - If the check **passes** (exit 0): continue to step 1.
   - If the check **fails** (exit 1): show the error message from `commitConfig.subjectPatternError` if set, otherwise show the pattern itself as a fallback. Do **not** proceed with the commit. Use AskUserQuestion to offer:
     - **edit subject** — let the user revise the subject line to match the pattern; re-run the gate
     - **harden** — run `/harden-sdlc` to analyze why this failed and propose stronger guardrails / dimensions / instructions that would catch it earlier next time. Opt-in — no surface is edited without your approval. (This option targets refining the regex or error message in `commitConfig`, not the current subject. Suppressed when `--auto` is set.) When the user selects **harden**, dispatch `Skill(harden-sdlc)` with `--failure-text "Subject pattern reject: subject '<line>' does not match pattern '<subjectPattern>' — error: <subjectPatternError>"`, `--skill commit-sdlc`, `--step "Step 5 — subject pattern gate"`, `--operation "subject pattern validation"`. Implements R13.
     - **cancel** — abort the commit
     Do not allow overriding this gate via a non-edit choice.

1. **Link verification (issue #198, R12) — HARD GATE.** Before `git commit`, validate every URL embedded in the commit message body via the shared link validator. The script reads the body from stdin and auto-derives `expectedRepo` from `parseRemoteOwner(cwd)` and `jiraSite` from `~/.sdlc-cache/jira/` — the skill MUST NOT construct ctx JSON.

   ```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

LINKS_LIB="$SDLC_ROOT/scripts/lib/links.js"
[ ! -f "$LINKS_LIB" ] && { echo "ERROR: Could not locate scripts/lib/links.js. Is the sdlc plugin installed?" >&2; exit 2; }
   [ -z "$LINKS_LIB" ] && [ -f "plugins/sdlc-utilities/scripts/lib/links.js" ] && LINKS_LIB="plugins/sdlc-utilities/scripts/lib/links.js"
   [ -z "$LINKS_LIB" ] && { echo "ERROR: Could not locate scripts/lib/links.js. Is the sdlc plugin installed?" >&2; exit 2; }
   printf '%s' "$message" | node "$LINKS_LIB" --json
   LINK_EXIT=$?
   
```

   On non-zero exit (`LINK_EXIT != 0`):
   - The script has already printed the violation list to stderr (URL, line, reason code, observed/expected detail).
   - Do NOT execute `git commit`. Surface the violation list verbatim to the user.
   - Stop. Do not retry. Do not edit URLs without user input. Do not bypass.

   On zero exit, proceed to the stash + commit steps below. `SDLC_LINKS_OFFLINE=1` skips network reachability while keeping context-aware checks (GitHub identity match, Atlassian host match) — use in sandboxed CI.

2. If `unstaged.hasChanges` is true AND `flags.noStash` is false:
   ```bash
   git stash push --keep-index -m "commit-sdlc: temp stash"
   ```
3. Execute the commit:
   - If `flags.amend` is true: `git commit --amend -m "<message>"`
   - Otherwise: `git commit -m "<message>"`
4. If stash was created in step 2:
   ```bash
   git stash pop
   ```

**On `edit`:** Ask what to change, revise the message, and present again. Loop until explicit `yes` or `cancel`. Re-dispatching the orchestrator is not required for small wording tweaks — apply user-supplied edits to `MESSAGE` directly and re-validate against the subject-pattern gate before re-presenting.

**On `cancel`:** Abort without changes. Run `rm -f "$COMMIT_CONTEXT_FILE"` to clean up the manifest.

**Hook failure handling**: If `git commit` fails due to a pre-commit hook, the stash is still in place. Inform the user: "Pre-commit hook failed. Your unstaged changes are stashed (`git stash list` to see). Fix the hook issue, re-stage your changes, and re-run `/commit-sdlc`."

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

| Gate | Check | Pass Criteria |
| ---- | ----- | ------------- |
| Style match | Message follows project's commit style | Consistent with `recentCommits` patterns |
| Subject length | Subject ≤ 72 characters | `len(subject) <= 72` |
| Accuracy | Message describes the actual staged diff | Every claim traceable to `staged.diff` or `staged.diffStat` (when `diffTruncated` is true) |
| Type correctness | Commit type matches the change | `feat`=new feature, `fix`=bug fix, `refactor`=restructure, `chore`=maintenance |
| Imperative mood | Subject uses imperative form | "add" not "adds" or "added" |
| No fabrication | Nothing invented beyond the diff | Every claim backed by staged changes |
| Body relevance | Body adds value or is absent | Does not restate the subject; no filler |
| Pattern match | Subject matches `commitConfig.subjectPattern` regex | Regex test passes; skip when `commitConfig` is null or `subjectPattern` is absent |
| Required body | Body present when type in `commitConfig.requireBodyFor` | Body non-empty for the selected type; skip when `commitConfig` is null or `requireBodyFor` is absent |
| Required trailers | All `commitConfig.requiredTrailers` keys present in body | Every listed trailer key appears; skip when `commitConfig` is null or `requiredTrailers` is absent |

## Best Practices

1. Read the full staged diff when available; when `staged.diffTruncated` is true, combine included diffs with diffstat for truncated files
2. Match the project's commit style from `recentCommits`
3. Prefer conventional commits when the project uses them
4. Keep the subject concise — details go in the body
5. Body explains "why"; subject explains "what"
6. Present the full diff stat so the user can verify scope before confirming

## DO NOT

- Execute any git command without explicit user approval (`yes`) (unless `--auto` was passed)
- Fabricate changes not present in `staged.diff`
- Skip the critique step (Step 3)
- Include file paths in the subject line
- Run `git stash` if `flags.noStash` is true
- Run `git commit --amend` unless `flags.amend` was explicitly passed
- Stash untracked files — only stash modified tracked files (`--keep-index`, no `--include-untracked`)

## Error Recovery

> **Flow**: detect → diagnose → auto-recover (retry once if transient) → invoke `error-report-sdlc` for persistent actionable failures.

| Error | Recovery | Invoke error-report-sdlc? |
| ----- | -------- | ------------------------- |
| `skill/commit.js` exit 1 | Show `errors[]`, stop | No — user input error |
| `skill/commit.js` exit 2 (crash) | Show stderr, stop | Yes |
| No staged changes (exit 1) | Inform user, suggest `git add` | No — user action needed |
| `git stash push` fails | Abort commit, show error | Yes if non-trivial failure |
| `git commit` fails (hook) | Show hook output; inform user stash is still in place; suggest recovery | No — hook failure is expected |
| `git commit` fails (other) | Show error | Yes |
| `git stash pop` conflict | Warn user, suggest `git stash show -p` and manual resolution | No — user needs to resolve |

When invoking `error-report-sdlc`, provide:
- **Skill**: commit-sdlc
- **Step**: Step 0 (script crash) or Step 5 (commit execution)
- **Operation**: `skill/commit.js` execution or `git stash`/`git commit`/`git stash pop`
- **Error**: exit code + stderr or git error output
- **Suggested investigation**: Check git identity; verify no branch protection rules; inspect hook scripts

---

## Gotchas

- **Stash pop conflicts**: If a staged file also has unstaged modifications, `git stash pop` may produce merge conflicts. The skill warns the user and does NOT attempt auto-resolution.
- **Amend on main/master**: A warning is shown when `--amend` is used on a protected branch. The skill does not block — this is the user's decision.
- **Commit on default branch**: A warning is shown when the current branch is the default branch. In `--auto` mode, the skill refuses (prepare exits non-zero, `errors[]` includes the blocking message); pass `--force-default-branch` to override. In interactive mode, the user sees the warning before Step 5 and the `AskUserQuestion` prompt still runs.
- **Pre-commit hook failure with active stash**: If a hook fails, the stash remains. The skill informs the user and provides recovery instructions — do not silently leave the stash without notifying.
- **Empty body**: A commit body is optional. Only include one when the staged diff is non-trivial and the "why" adds real value.
- **Single commit in repo**: `git log --oneline -15` may return fewer than 15 lines on a new repo. This is fine — the LLM falls back to conventional commits as the default style.

## Learning Capture

After completing a commit, if the project's detected commit style was non-conventional or unusual, append to `.sdlc/learnings/log.md`:

```
## YYYY-MM-DD — commit-sdlc: <brief summary>
<what was learned about this project's commit style or any edge case encountered>
```

## What's Next

After completing the commit, common follow-ups include:
- `/review-sdlc` — review the changes
- `/version-sdlc` — tag a release
- `/pr-sdlc` — create a pull request

## See Also

- [`/review-sdlc`](../review-sdlc/SKILL.md) — review changes after committing
- [`/pr-sdlc`](../pr-sdlc/SKILL.md) — create a PR after committing
- [`/version-sdlc`](../version-sdlc/SKILL.md) — tag a release after committing
