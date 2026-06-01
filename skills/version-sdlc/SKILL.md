---
name: version-sdlc
description: "Use this skill when bumping a project version, creating a git release tag, generating a changelog, or performing a full semantic release workflow, updating an existing changelog entry for the current version, or retagging the current version at HEAD. Consumes pre-computed context from skill/version.js and handles the complete release process. Use --changelog without a bump type to update the changelog for the already-tagged current version. Use --retag to move an existing tag to HEAD. Arguments: [major|minor|patch|<label>] [--init] [--pre <label>] [--no-push] [--changelog] [--hotfix] [--retag] [--auto]. The positional `<label>` form (e.g. `version-sdlc rc`) is sugar for `--bump patch --pre <label>` and accepts any pre-release label matching `^[a-z][a-z0-9]*$`. Triggers on: version bump, create release, bump version, tag release, generate changelog, semantic versioning, semver bump, pre-release, release candidate, retag release. Use --auto to skip interactive approval prompts (release plan is still displayed)."
user-invocable: true
argument-hint: "[major|minor|patch|<label>] [--pre <label>] [--changelog] [--hotfix] [--retag] [--auto]"
model: gemini-3.5-flash
---

# Versioning Releases Skill

Consume pre-computed version context from `skill/version.js` and execute either
the one-time init setup or a full semantic release: version bump, annotated git tag,
optional CHANGELOG entry, release commit, and push to origin.

**Announce at start:** "I'm using version-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

## When to Use This Skill

- Bumping the project version (patch, minor, major)
- Creating an annotated git release tag
- Generating a Keep a Changelog entry for a release
- Running a full semantic release workflow end-to-end
- Creating or incrementing pre-release versions (alpha, beta, rc)
- When the `/version` command delegates here after running `skill/version.js`
- Updating a CHANGELOG entry for an already-tagged release (e.g., after a squash merge added commits not captured in the original entry)

## Workflow

## Step 0 — Plan Mode Check

If the system context contains "Plan mode is active":

1. Announce: "This skill requires write operations (git tag, git push). Exit plan mode first, then re-invoke `/version-sdlc`."
2. Stop. Do not proceed to subsequent steps.

---

### Step 0: Resolve and Run skill/version.js

> **VERBATIM** — Run this bash block exactly as written. Do not modify, rephrase, or simplify the commands.

```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

SCRIPT="$SDLC_ROOT/scripts/skill/version.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/version.js. Is the sdlc plugin installed?" >&2; exit 2; }

VERSION_CONTEXT_FILE=$(node "$SCRIPT" --output-file $ARGUMENTS)
EXIT_CODE=$?
# Single canonical cleanup: trap fires unconditionally on EXIT/INT/TERM, so
# the manifest is removed even if the release is cancelled or errors out.
trap 'rm -f "$VERSION_CONTEXT_FILE"' EXIT INT TERM

```

Read and parse `VERSION_CONTEXT_FILE` as `VERSION_CONTEXT_JSON`. The `trap` above guarantees cleanup on any exit path — do not add scattered `rm -f` calls in success/cancel branches.

**On non-zero `EXIT_CODE`:**

- Exit code 1: The JSON still contains an `errors` array. Show each error to the user and stop.
- Exit code 2: Show `Script error — see output above` and stop.

**On script crash (exit 2):** Invoke error-report-sdlc — Glob `**/error-report-sdlc/REFERENCE.md`, follow with skill=version-sdlc, step=Step 0 — skill/version.js execution, error=stderr.

**If `VERSION_CONTEXT_JSON.errors` is non-empty**, show each error message and stop.

**If `VERSION_CONTEXT_JSON.warnings` is non-empty**, show the warnings to the user before continuing.
For the warning `"You have uncommitted changes"`, use AskUserQuestion to ask:
> You have uncommitted changes that will NOT be included in this release.

Options:
- **proceed** — release without the uncommitted changes
- **commit first** — run /commit-sdlc to commit changes, then re-invoke /version-sdlc
- **cancel** — abort the release

On **commit first**: invoke `/commit-sdlc` via the Skill tool. After the commit completes, re-invoke `/version-sdlc` with the same original arguments.

---

The workflow then branches based on `VERSION_CONTEXT_JSON.flow` and `VERSION_CONTEXT_JSON.mode`:
- If `mode === "retag"` → **Branch D: Retag Workflow** (see below). `flow` will be `"retag"`.
- If `flow === "init"` → Branch A.
- If `flow === "release"` → Branch B.
- If `flow === "changelog-update"` → Branch C.

---

### Branch A: Init Workflow (`flow === "init"`)

> If the user invoked with `--init`, read `./init-workflow.md` now for the complete init workflow steps.

---

### Branch B: Release Workflow (`flow === "release"`)

### Step 1 (CONSUME): Read the Context

Read `VERSION_CONTEXT_JSON`. Key fields to extract:

| Field | Description |
| ----- | ----------- |
| `versionSource.currentVersion` | Current version string |
| `config.mode` | `"file"` or `"tag"` |
| `config.changelog` | Whether changelog is enabled by default |
| `requestedBump` | `"major"`, `"minor"`, `"patch"`, or `null`. May be auto-set to `"patch"` by the script when `flags.bumpFromLabel === true` (positional `<label>` sugar) or when `flags.preLabelFromConfig === true` (config-driven default). Authoritative bump source when `flags.bumpFromFlag === true` (R-bump-flag). |
| `conventionalSummary.suggestedBump` | Auto-detected bump type from commits — **informational only**, never a bump source (R-bump-promote). |
| `conventionalSummary.hasBreakingChanges` | Whether any commit is a breaking change |
| `bumpPromotionDetected` | Boolean — `true` when `conventionalSummary.suggestedBump` outranks `requestedBump` (commits hint at a larger bump than was requested). Drives the Step 2 diagnostic line; does NOT change the resolved bump. (R-bump-promote) |
| `bumpOptions` | `{ major, minor, patch, preRelease }` — pre-computed next versions. `preRelease` is populated whenever any pre-release source is active (`--pre`, label-form `<bump>`, or `config.preRelease`). |
| `tags.latest` | Most recent tag |
| `commits` | Array of commits since last tag |
| `flags` | `{ preLabel, noPush, changelog, hotfix, auto, bumpFromFlag, bumpFromLabel, preLabelExplicit, preLabelFromConfig }` — parsed CLI flags plus bump and pre-release provenance fields. `bumpFromFlag` is `true` when the bump came from the named `--bump <value>` flag (R-bump-flag). The pre-release provenance flags are mutually exclusive: at most one of `bumpFromLabel`, `preLabelExplicit`, `preLabelFromConfig` is `true`. |
| `flags.hotfix` | Whether this release is a hotfix (for DORA metrics tracking) |
| `flags.auto` | Whether `--auto` was passed — skip interactive approval prompts |
| `config.ticketPrefix` | Optional Jira/project key prefix (e.g. `"PROJ"`). When set, ticket IDs matching this prefix are extracted from commits. |
| `commits[].ticketIds` | Array of extracted ticket IDs (e.g. `["PROJ-123"]`) found in the commit subject and body. Empty array if none. |
| `conflictsWithNext` | `{ major, minor, patch }` — whether each tag already exists |

### Step 2 (PLAN): Determine Bump Type and Draft CHANGELOG

**Implements R-bump-flag, R-bump-promote (docs/specs/version-sdlc.md).**

**Determine new version:**

The script (`skill/version.js`) does all label validation and bump-source resolution before this step runs. Read the resolved values from `VERSION_CONTEXT_JSON` and select the version verbatim — do not re-derive bump type from the original CLI string and do not consult `config.bump` after Step 1.

**Bump precedence (single source of truth — highest to lowest):**

| # | Condition (from prepare output) | Bump source |
| - | ------------------------------- | ----------- |
| 1 | `flags.bumpFromFlag === true` | `requestedBump` (from `--bump` named flag — authoritative) |
| 2 | `requestedBump` set AND `flags.bumpFromFlag === false` | `requestedBump` (positional bump — `major`/`minor`/`patch` or label-form) |
| 3 | `config.preRelease` active AND no bump | `requestedBump` auto-injected as `"patch"` (script-set; signalled by `flags.preLabelFromConfig === true`) |
| 4 | otherwise | `requestedBump = "patch"` default |

`conventionalSummary.suggestedBump` is **informational only** — it never participates in this precedence. It exists solely to drive the `bumpPromotionDetected` diagnostic below; never treat it as a bump source.

**Bump-promotion diagnostic (R-bump-promote):**
When `bumpPromotionDetected === true` in the prepare output, print this line verbatim before proceeding:
```
Commits suggest <suggestedBump> bump but <requestedBump> requested — staying with <requestedBump>. Override with `--bump <suggestedBump>` if intentional.
```
Substitute `<suggestedBump>` with `conventionalSummary.suggestedBump` and `<requestedBump>` with the resolved bump from the precedence above. This is informational only — do not change the bump and do not pause for approval here.

**Pre-release label resolution (orthogonal to bump):**

Pre-release intent comes from three mutually-exclusive sources, signalled by the provenance flags `flags.bumpFromLabel`, `flags.preLabelExplicit`, and `flags.preLabelFromConfig` (at most one is `true`):

1. Explicit `--pre <label>` (`flags.preLabelExplicit === true`) — combines with whichever bump was resolved above
2. Positional label-form (e.g. `version-sdlc rc`, `flags.bumpFromLabel === true`) — script auto-set `requestedBump = "patch"`
3. `config.preRelease` default (`flags.preLabelFromConfig === true`) — script auto-set `requestedBump = "patch"`

When `flags.preLabel` is set, use `bumpOptions.preRelease`. Otherwise use `bumpOptions[requestedBump]`. The script has already computed both pre-release semantics (counter increment, label reset, label switch) and the next-version values.

**Implements R3 (breaking-change gate):** if `conventionalSummary.hasBreakingChanges` is `true` AND the resolved bump is not `major`, suggest `major` UNLESS the resolved bump is a pre-release from any source. Detect "is a pre-release" by checking that `flags.preLabel` is non-null. Pre-release trains skip this warning to avoid nagging on every RC iteration.

**Draft CHANGELOG entry** (only if `flags.changelog === true`) — `flags.changelog` is the resolved value (`config.changelog` OR `--changelog`) emitted by `skill/version.js`:

- Use Keep a Changelog format with today's date: `## [x.y.z] - YYYY-MM-DD`
- Map commit types to sections:
  - `feat` → **Added**
  - `fix` → **Fixed**
  - `refactor`, `perf` → **Changed**
  - breaking commits → note `(BREAKING)` inline within their section
- Skip: `chore`, `docs`, `test`, `ci`, `build`, `style` — unless they are clearly user-facing from the description
- Rewrite unclear or implementation-focused commit messages into user-facing language
- Merge closely related commits into single entries where appropriate
- Never fabricate entries not backed by a real commit

**Ticket ID references** — when `config.ticketPrefix` is set and a commit has non-empty `ticketIds`:
- Append the ticket IDs in parentheses at the end of the changelog entry: `- Added bulk operations endpoint (PROJ-456)`
- Multiple IDs for one commit: `(PROJ-456, PROJ-789)`
- Multiple commits contributing to one merged entry: include all unique ticket IDs from those commits
- Only include ticket IDs when `config.ticketPrefix` is set — otherwise skip them to avoid false positives from random uppercase patterns

### Step 2.5 (BRANCH-GUARD): HARD GATE — Expected Branch Check

**Implements R-expected-branch (docs/specs/version-sdlc.md, issues #347, #348, #349).**

Check `branchGuard.active` and `branchGuard.ok` from `VERSION_CONTEXT_JSON`.

If `branchGuard.active === true` AND `branchGuard.ok === false`:
- Surface `branchGuard.message` verbatim to the user.
- Halt the skill immediately. Do NOT proceed to Step 3 (commit/tag/push).
- Do NOT re-derive the current branch via shell commands — use the resolved `branchGuard` field only.

If `branchGuard.active === false` (flag was not passed) or `branchGuard.ok === true` (branches match): proceed to Step 3.

### Step 3 (CRITIQUE): Self-review Against Quality Gates

Review the planned version and CHANGELOG draft against every quality gate in the table below. Note every failing gate before proceeding.

### Step 4 (IMPROVE): Revise Based on Critique

Fix each issue found in Step 3. Continue until all gates pass (max 2 iterations per gate).

### Step 5 (DO): Present Release Plan for Approval

**Auto mode:** When `flags.auto` is true, skip the AskUserQuestion prompt entirely. Still display the full release plan for visibility, then proceed directly to Step 6 (pre-condition verification). Treat the response as an implicit `yes`. All critique gates (Steps 3–4) still run — only the interactive approval prompt is skipped. Breaking change warnings are still displayed.

Show the full release plan to the user. **Do not execute any git commands before receiving explicit user approval via AskUserQuestion.**

```
Release Plan
────────────────────────────────────────────
Version:    1.2.3 → 1.3.0
Tag:        v1.3.0 (annotated)
File:       package.json
Push:       yes (to origin/main)
Changelog:  yes             ← render 'yes' when flags.changelog === true, else 'no' (substitute from flags.changelog)
Hotfix:     yes             ← only shown when flags.hotfix === true
────────────────────────────────────────────

Use AskUserQuestion to ask:
> Execute this release?

Options:
- **yes** — execute all steps
- **edit** — describe what to change
- **cancel** — abort
```

If `flags.changelog === true`, show the draft CHANGELOG entry between the release plan table and the prompt.

If the user chooses `edit`, ask what to change, revise, and present again. Loop until explicit `yes` or `cancel`.

### Step 6 (CRITIQUE post-execution plan): Verify Pre-conditions

Before executing, verify:

- The version file path exists (for `config.mode === "file"`)
- The new tag does not conflict with existing tags (`conflictsWithNext[bumpType]` is false)
- There are no uncommitted changes that would corrupt the release commit (run `git status --porcelain` and warn if non-empty)
- Remote state is known — note `remoteState.hasUpstream` for use in Step 8 (the push step self-heals a missing upstream by emitting `--set-upstream`; no user action required)
- Git identity is configured: run `git config user.name` and `git config user.email`. If either is empty, stop and instruct the user to set them:
  ```
  git config user.name "Your Name"
  git config user.email "you@example.com"
  ```
  (The annotated tag created in Step 8 requires a committer identity.)

### Step 7 (IMPROVE): Fix Any Pre-condition Issues

Resolve any issues found in Step 6 before proceeding. If a blocking issue cannot be resolved, report it clearly and stop.

### Step 7.5 (CHECK): Verify Installed CI Scripts Are Up To Date

Before executing, check whether the project's installed CI scripts need updating.
This ensures projects that ran `--init` in a prior session get notified about improvements.

Locate and run the scaffold script in check-only mode:

```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

SCRIPT="$SDLC_ROOT/scripts/skill/scaffold-ci.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/scaffold-ci.js. Is the sdlc plugin installed?" >&2; exit 2; }

```

Run the check (include `--changelog` only when `config.changelog === true`).

> **Why `config.changelog`, not `flags.changelog`, here?** Step 7.5 scaffolds *persistent* CI scripts that ship with the project; the relevant question is whether the project opts into changelog enforcement long-term, not whether `--changelog` was passed for this single release. This is the only legitimate post-CONSUME reference to `config.changelog` per spec R18 — every other site (Step 2 draft, Step 5 display, Step 8.2 write) gates on `flags.changelog`. Do not "fix" this divergence.

```bash
SCAFFOLD_OUTPUT_FILE=$(node "$SCRIPT" --check-only --output-file)
# Add --changelog if config.changelog === true:
# SCAFFOLD_OUTPUT_FILE=$(node "$SCRIPT" --check-only --changelog --output-file)
```

Read the JSON output. If any files have `action: "outdated"` or `action: "missing"`:
   - Show what changed and which files would be updated (use `installedVersion` / `currentVersion` from the output)
   - Use AskUserQuestion to ask: "Update CI scripts? (yes / no) — this does not block the release."
   - **Auto mode:** When `flags.auto` is true, skip the AskUserQuestion and treat the response as `yes` — update outdated CI scripts automatically.
   - On `yes`: run `node "$SCRIPT" --force` (add `--changelog` if applicable) to overwrite the outdated files
   - On `no`: warn and continue with the release

The release proceeds regardless of the user's answer. This is informational, not a gate.

### Step 8 (EXECUTE): Execute the Release

**Only execute after explicit `yes` from Step 5, or when `flags.auto` is true (implicit approval).**

1. **Update version file** (only if `config.mode === "file"`):
   - **For all version-file formats (JSON, TOML, YAML — package.json, plugin.json, Cargo.toml, pyproject.toml, etc.):** use the Edit tool with a single targeted string replacement. The `old_string` must contain the current version string in its on-disk form (e.g. `"version": "<currentVersion>"` for JSON, `version = "<currentVersion>"` for TOML). The `new_string` substitutes the new version only.
   - **DO NOT use the Write tool. DO NOT rewrite the file. DO NOT touch any other field.**
   - **Verify after edit (HARD GATE):** run `git diff <versionFile>`. Exactly one line must differ — the version line. If more than one line differs, abort the release immediately, restore with `git checkout -- <versionFile>`, and surface the diff to the user.
2. **Update CHANGELOG** (only if `flags.changelog === true` — same gate as Step 2 draft): Use the Edit or Write tool to prepend the new entry after the `## [Unreleased]` section if present, or after the file header if not. Create `CHANGELOG.md` if it does not exist.
3. **Stage changed files**: `git add <versionFile> CHANGELOG.md` — include only files that were actually changed.
3b. **Link verification (R17, issue #198) — HARD GATE.** Before `git commit`, validate every URL embedded in the staged CHANGELOG entry (and any release-notes body) via the shared link validator. The script reads the body via `--file` and auto-derives `expectedRepo` from `parseRemoteOwner(cwd)` and `jiraSite` from `~/.sdlc-cache/jira/` — the skill MUST NOT construct ctx JSON. Skip this sub-step entirely when changelog is disabled and no release-notes body was generated.

   ```bash
for d in "antigravity" "plugins/sdlc" "plugins/sdlc-utilities" "$HOME/.gemini/config/plugins/sdlc" "$HOME/.gemini/plugins/sdlc"; do [ -f "$d/plugin.json" ] && SDLC_ROOT="$d" && break; done
[ -z "$SDLC_ROOT" ] && { echo "ERROR: SDLC plugin root not found." >&2; exit 2; }

LINKS_LIB="$SDLC_ROOT/scripts/lib/links.js"
[ ! -f "$LINKS_LIB" ] && { echo "ERROR: Could not locate scripts/lib/links.js. Is the sdlc plugin installed?" >&2; exit 2; }
   [ -z "$LINKS_LIB" ] && [ -f "plugins/sdlc-utilities/scripts/lib/links.js" ] && LINKS_LIB="plugins/sdlc-utilities/scripts/lib/links.js"
   [ -z "$LINKS_LIB" ] && { echo "ERROR: Could not locate scripts/lib/links.js. Is the sdlc plugin installed?" >&2; exit 2; }
   # Validate the new CHANGELOG entry only (not the entire historical file).
   printf '%s' "$new_changelog_entry" | node "$LINKS_LIB" --json
   LINK_EXIT=$?
   
```

   On non-zero exit (`LINK_EXIT != 0`):
   - The script has already printed the violation list to stderr.
   - Do NOT execute `git commit` or `git tag`. Surface the violation list verbatim to the user.
   - Stop. Do not retry. Do not edit URLs without user input. Do not bypass.

   On zero exit, proceed to step 4. `SDLC_LINKS_OFFLINE=1` skips network reachability while keeping context-aware checks — use in sandboxed CI.

4. **Commit**:
   - If `flags.hotfix === true`: `git commit -m "chore(release): ${newTag} [hotfix]"`
   - Otherwise: `git commit -m "chore(release): ${newTag}"`
5. **Tag**:
   - If `flags.hotfix === true`:
     ```bash
     git tag -a ${newTag} -m "$(printf 'Release %s\n\nType: hotfix' ${newTag})"
     ```
   - Otherwise: `git tag -a ${newTag} -m "Release ${newTag}"`
6. **Push** (unless `flags.noPush === true`):
   - If `remoteState.hasUpstream === true` (R11): `git push && git push --tags`
   - If `remoteState.hasUpstream === false` (R15): `git push --set-upstream origin <currentBranch> && git push --tags` — uses `currentBranch` from the prepare-script `version-context` output. This auto-heals first push from a fresh feature branch; no manual `git push -u` is required.

**If any git command fails** (commit, tag, or push) with a non-auth error, show the error.

**On script crash (exit 2):** Invoke error-report-sdlc — Glob `**/error-report-sdlc/REFERENCE.md`, follow with skill=version-sdlc, step=Step 8 — Release execution, error=git command failure message.

Display result:

```
✓ Release v1.3.0 complete.
  Commit: abc1234 — chore(release): v1.3.0
  Tag:    v1.3.0
  Pushed: yes → origin/main
```

If `flags.hotfix === true`, show instead:

```
✓ Release v1.3.0 complete (hotfix).
  Commit: abc1234 — chore(release): v1.3.0 [hotfix]
  Tag:    v1.3.0  (annotated with Type: hotfix)
  Pushed: yes → origin/main
```

---

### Branch C: Changelog-Update Workflow (`flow === "changelog-update"`)

> When `VERSION_CONTEXT_JSON.flow === 'changelog-update'` (set by the script when `--changelog` is passed without a bump type), read `./changelog-workflow.md` now for the complete changelog-update workflow steps.

---

### Branch D: Retag Workflow (`mode === "retag"`) — R-RETAG, G8 (implements #424)

**Entry condition:** `VERSION_CONTEXT_JSON.mode === "retag"`. This flow ONLY activates when `mode` from prepare output equals `"retag"` — never re-derive this from raw `$ARGUMENTS` (flag-coherence-cross-skill).

**Difference from `retag-release.yml`:** `/version-sdlc --retag` is user-initiated — you deliberately move the existing tag to HEAD. The CI workflow `retag-release.yml` is CI-automated squash-drift fix — it fires on push. They are orthogonal; do not conflate.

#### Step D1 (CHECK): Validate Prepare Output

Read `VERSION_CONTEXT_JSON` for the retag flow:

| Field | Description |
|---|---|
| `mode` | Must be `"retag"` — gate for this branch |
| `currentTag` | The tag to be retagged (e.g., `v1.2.3`) |
| `oldSha` | The SHA the tag currently points to |
| `head` | The SHA of HEAD (the new target) |
| `errors` | Any validation errors from prepare script (exclusivity, tag-not-found) |
| `flags.auto` | Whether `--auto` was passed (suppresses confirmation prompt) |

If `errors.length > 0`, display each error and stop. Example error: `--retag cannot be combined with 'patch'`.

#### Step D2 (CONFIRM): Show Retag Plan and Get Approval

Print the retag plan:

```
Retag Plan
────────────────────────────────
Tag:     <currentTag>
From:    <oldSha[:7]> (current remote tag)
To:      <head[:7]> (HEAD)
────────────────────────────────
```

**Interactive mode** (when `flags.auto` is false): Use AskUserQuestion:
> About to retag `<currentTag>` from `<oldSha[:7]>` to `<head[:7]>` (HEAD). Continue?

Options: **yes** — proceed | **no** — cancel

On **no**: stop. Print "Retag cancelled."

**Auto mode** (when `flags.auto` is true): Skip the confirmation prompt. Print the retag plan and proceed immediately.

#### Step D3 (EXECUTE): Perform the Retag Sequence

Execute each step explicitly and in order. All five git operations are required:

**1. Delete local tag:**
```bash
git tag -d <currentTag>
```
If this fails, stop and report the error. Do not proceed.

**2. Delete remote tag:**
```bash
git push origin :refs/tags/<currentTag>
```
If this fails, stop and report. Note: the local tag has already been deleted at this point — the user may need to recreate it manually.

**3. Create new annotated tag at HEAD:**
```bash
git tag -a <currentTag> -m "Retag <currentTag>"
```
If this fails, stop and report.

**4. Push new tag:**
```bash
git push origin <currentTag>
```
If this fails, stop and report.

**5. Verify new tag points to HEAD:**
```bash
git rev-parse refs/tags/<currentTag>
```
Compare output to `<head>`. If they differ, report a warning (proceed — the user can verify manually).

#### Step D4 (REPORT): Summary

```
Retag complete
────────────────────────────────
Tag:     <currentTag>
Old SHA: <oldSha[:7]>
New SHA: <head[:7]>
────────────────────────────────
```

---

## Quality Gates

| Gate | Check | Pass Criteria |
| ---- | ----- | ------------- |
| Semver correctness | New version is valid semver | `major.minor.patch[-pre]`, no leading zeros |
| Breaking change bump | If `hasBreakingChanges`, bump is major (or is a pre-release) | Warn if minor/patch chosen with breaking commits |
| Tag conflict | New tag does not already exist | `conflictsWithNext[bumpType]` is false |
| Changelog completeness | All user-facing commits are represented | No feat/fix commits silently omitted (if changelog enabled) |
| No fabricated entries | Every CHANGELOG entry traces to a real commit | (if changelog enabled) |
| Commit count | There are commits to release | `commits.length > 0` OR pre-release (allow empty pre-releases) |
| Version file writable | File type is supported | fileType is in the known list |

## Best Practices

1. Always show the full release plan before executing any git commands
2. Use `--pre beta` or `--pre rc` for pre-release versions; they auto-increment (e.g. `rc.1` → `rc.2`). The shorthand `version-sdlc rc` (positional label-form bump) is equivalent to `--bump patch --pre rc`.
3. For pre-releases: running the full release without `--pre` "graduates" the pre-release to a stable version. An explicit `--bump major|minor|patch` always overrides `config.preRelease` and graduates out of the pre-release train.
4. Breaking changes require a major bump — suggest it even if the user requested a lower bump type. The suggestion is suppressed when the resolved bump is a pre-release from any source (`--pre`, label-form, or `config.preRelease`).
5. Changelog entries should be user-facing and outcome-focused, not implementation-focused
6. Set `version.preRelease` in `.sdlc/config.json` to default to a pre-release label (e.g. `"rc"`) on every bump until explicit graduation. Configure interactively via `/setup-sdlc`.

## DO NOT

- Execute any git commands without explicit user approval (`yes`) or auto-mode implicit approval (`flags.auto === true`)
- Fabricate commit descriptions or changelog entries not backed by real commits
- Skip the CRITIQUE step even if the plan looks obviously correct
- Push to remote without checking `flags.noPush`
- Modify the version file if `config.mode === "tag"` — in tag mode, the version lives in git only
- Omit the pre-condition verification in Step 6 before executing

## Error Recovery

> **Flow**: detect → diagnose → auto-recover (retry once if transient) → invoke `error-report-sdlc` for persistent actionable failures.

| Error | Recovery | Invoke error-report-sdlc? |
|-------|----------|---------------------------|
| `skill/version.js` exit 1 | Show `errors[]`, stop | No — user input error |
| `skill/version.js` exit 2 (crash) | Show stderr, stop | Yes |
| Tag already exists (`conflictsWithNext` true) | Suggest next patch/minor/major; let user choose | No — user decision |
| `git commit` fails | Show error; check for uncommitted changes or hook failure | Yes if non-hook failure |
| `git tag` fails | Show error; check for duplicate tag or missing git identity | Yes if non-duplicate failure |
| `git push --tags` fails | Show error; check remote connectivity and branch protection rules | Yes if non-auth failure |

When invoking `error-report-sdlc`, provide:
- **Skill**: version-sdlc
- **Step**: Step 0 (script crash) or Step 8 (git command failure)
- **Operation**: `skill/version.js` execution or `git commit`/`git tag`/`git push`
- **Error**: exit code 2 + stderr, or git error output
- **Suggested investigation**: Check installed plugin version; verify git identity is configured; confirm remote is accessible

---

## Gotchas

- **`/version-sdlc --retag` vs `retag-release.yml`:** `/version-sdlc --retag` is user-initiated — you deliberately move the existing tag to HEAD after a deliberate decision. The CI workflow `retag-release.yml` is CI-automated squash-drift fix — it fires automatically on push when the tag points to a commit that was squash-merged away. They are orthogonal features; the CI workflow is unaffected by `--retag`, and vice versa. (Implements #424.)
- **Squash merge orphans tags**: When using GitHub's "squash and merge" strategy, the annotated tag created on the feature branch points to the pre-merge commit, which becomes unreachable from main after merge. The `retag-release.yml` workflow (scaffolded during init) automatically moves the tag to the squash commit on main whenever a push lands on main. Without this workflow, tags are orphaned and `git describe` / `git log --decorate` on main will not show them.
- `bumpOptions.preRelease` is pre-computed in the JSON only when `--pre` was passed at script time. If the user requests a different pre-label during `edit`, re-run the script — the `preRelease` field reflects the label passed at script invocation, not a label added mid-session.
- **Version-file edit hard gate:** for ALL version-file formats (JSON, TOML, YAML — package.json, plugin.json, Cargo.toml, pyproject.toml, etc.) use the Edit tool with a single targeted string replacement and verify with `git diff <versionFile>` that exactly one line changed. If more than one line differs, abort and `git checkout -- <versionFile>`. Never use the Write tool or rewrite the file from memory — LLMs reliably truncate or paraphrase fields like `description` (see #211).
- `git push && git push --tags` are two separate pushes. `git push --tags` alone does NOT push the release commit — both commands are required.
- **Auto-`--set-upstream` on first push (R15):** When `remoteState.hasUpstream === false`, Step 8 emits `git push --set-upstream origin <currentBranch>` instead of bare `git push`. This eliminates the `fatal: The current branch has no upstream` error on releases cut from a fresh feature branch. The branch comes from `currentBranch` in the `version-context` JSON — never hardcode it. The subsequent `git push --tags` is unchanged.
- If the working tree has uncommitted changes at execution time, the release commit will include only the staged version file and changelog changes. Warn the user so they are not surprised by files missing from the commit.
- `conventionalSummary.suggestedBump` is derived from commit types. If there are no conventional commits since the last tag, the suggested bump may default to `patch` — confirm with the user if this seems wrong.

## Changelog Accuracy and Limitations

The automated changelog is a **draft, not a source of truth**. Correctness is the developer's responsibility. The tooling makes changelog maintenance fast, but cannot guarantee accuracy in all workflows.

### Known Limitations

| Limitation | Why it happens | Impact |
|---|---|---|
| **Squash merge loses commit granularity** | Squash-merge collapses N commits into 1. After retag, `previousTag..currentTag` on main sees only the squash commit. | Changelog drafted on the feature branch reflects individual commits; after squash, that detail no longer exists in main's git history. |
| **Post-tag commits not in changelog** | Commits added after tagging but before merge (e.g. code review fixes). | These changes are released but not documented in the original changelog entry. |
| **Parallel branches / merge order** | Multiple feature branches tag releases concurrently. Merge order determines which squash commit each tag lands on after retag. | Tag may end up on a different commit than intended; changelog was written against a different commit range. |
| **Conventional commit compliance** | Changelog quality depends on developers writing `feat:`, `fix:`, etc. Non-conforming commits show as "other" and may be skipped. | Incomplete or inaccurate changelog entries. |
| **LLM-drafted content** | The changelog entry is generated by an LLM from commit data and may misinterpret scope or miss nuances. | Entries require human review before they are authoritative. |

### Mitigation: 4-Layer Defense

1. **CI validates presence** — `check-changelog.cjs` (scaffolded during init when changelog is enabled) fails on push to main if no `## [version]` heading exists. Ensures at least a placeholder entry.
2. **`/version-sdlc --changelog` on main** — After merge, switch to main and run this command. It re-derives the changelog from the actual `previousTag..currentTag` range (not the feature branch), shows a diff against the existing entry, and lets you approve or edit the update without creating a new tag.
3. **Retag script advisory** — After retagging, `retag-release.cjs` prints a warning if `changelog: true` and no entry exists for the tag. Reminds developers to verify.
4. **Manual review** — Before release communications, treat the CHANGELOG as a draft to review, not a finished document.

## Learning Capture

After completing a release or encountering unexpected behavior, append to `.sdlc/learnings/log.md`:

```
## YYYY-MM-DD — version-sdlc: <brief summary>
<what happened, what was learned>
```

Record entries for: project-specific version file locations, non-standard tag conventions,
monorepo versioning patterns, CI requirements that gate tag pushes, or any edge cases
encountered during release execution.

## What's Next

After completing the release, common follow-ups include:
- `/jira-sdlc` — update Jira ticket status

## See Also

- [`/commit-sdlc`](../commit-sdlc/SKILL.md) — commit changes before tagging a release
- [`/jira-sdlc`](../jira-sdlc/SKILL.md) — update Jira ticket status after release
- [`/pr-sdlc`](../pr-sdlc/SKILL.md) — the PR that triggered this release
