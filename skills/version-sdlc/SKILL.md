---
name: version-sdlc
description: "Use this skill when bumping a project version, creating a git release tag, generating a changelog, or performing a full semantic release workflow, updating an existing changelog entry for the current version, or retagging the current version at HEAD. Consumes pre-computed context from skill/version.js and handles the complete release process. Use --changelog without a bump type to update the changelog for the already-tagged current version. Use --retag to move an existing tag to HEAD. Arguments: [major|minor|patch|<label>] [--init] [--pre <label>] [--no-push] [--changelog] [--hotfix] [--retag] [--auto]. The positional `<label>` form (e.g. `version-sdlc rc`) is sugar for `--bump patch --pre <label>` and accepts any pre-release label matching `^[a-z][a-z0-9]*$`. Triggers on: version bump, create release, bump version, tag release, generate changelog, semantic versioning, semver bump, pre-release, release candidate, retag release. Use --auto to skip interactive approval prompts (release plan is still displayed)."
user-invocable: true
argument-hint: "[major|minor|patch|<label>] [--init] [--pre <label>] [--no-push] [--changelog] [--hotfix] [--retag] [--auto]"
model: gemini-3.8-flash-medium
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

> **VERBATIM** — Run this block exactly as written, replacing `<PLUGIN_ROOT>` with the absolute path to this plugin. Note the strict script location pattern: `node "<PLUGIN_ROOT>/scripts/<group>/<script-name>.js"` — the scripts are Node CLI files invoked with `node`. Do not modify, rephrase, or simplify the commands.

```shell
VERSION_CONTEXT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/version.js" --output-file $ARGUMENTS)
EXIT_CODE=$?

echo "VERSION_CONTEXT_FILE: $VERSION_CONTEXT_FILE"
echo "STATUS: $EXIT_CODE"
```

Read and parse `VERSION_CONTEXT_FILE` as `VERSION_CONTEXT_JSON`. `skill/version.js` writes the manifest into the system temp directory and prints only its path, so the OS reclaims it on any exit path — do not add scattered `rm -f` calls in success/cancel branches.

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

> If the user invoked with `--init`, read `./resources/init-workflow.md` now for the complete init workflow steps.

---

### Branch B: Release Workflow (`flow === "release"`)

### Step 1 (CONSUME): Read the Context

Read `VERSION_CONTEXT_JSON`. Key fields to extract:

| Field | Description |
| ----- | ----------- |
| `versionSource.currentVersion` | Current version string |
| `config.mode` | `"file"` or `"tag"` |
| `config.changelog` | Whether changelog is enabled by default |
| `requestedBump` | `"major"`, `"minor"`, `"patch"`, or `null`. May be auto-set to `"patch"` by the script when `flags.bumpFromLabel === true` (positional `<label>` sugar) or when `flags.preLabelFromConfig === true` (config-driven default). Authoritative bump source when `flags.bumpFromFlag === true`. |
| `conventionalSummary.suggestedBump` | Auto-detected bump type from commits — **informational only**, never a bump source. |
| `conventionalSummary.hasBreakingChanges` | Whether any commit is a breaking change |
| `bumpPromotionDetected` | Boolean — `true` when `conventionalSummary.suggestedBump` outranks `requestedBump` (commits hint at a larger bump than was requested). Drives the Step 2 diagnostic line; does NOT change the resolved bump. |
| `bumpOptions` | `{ major, minor, patch, preRelease }` — pre-computed next versions. `preRelease` is populated whenever any pre-release source is active (`--pre`, label-form `<bump>`, or `config.preRelease`). |
| `tags.latest` | Most recent tag |
| `commits` | Array of commits since last tag |
| `flags` | `{ preLabel, noPush, changelog, hotfix, auto, bumpFromFlag, bumpFromLabel, preLabelExplicit, preLabelFromConfig }` — parsed CLI flags plus bump and pre-release provenance fields. `bumpFromFlag` is `true` when the bump came from the named `--bump <value>` flag. The pre-release provenance flags are mutually exclusive: at most one of `bumpFromLabel`, `preLabelExplicit`, `preLabelFromConfig` is `true`. |
| `flags.hotfix` | Whether this release is a hotfix (for DORA metrics tracking) |
| `flags.auto` | Whether `--auto` was passed — skip interactive approval prompts |
| `config.ticketPrefix` | Optional Jira/project key prefix (e.g. `"PROJ"`). When set, ticket IDs matching this prefix are extracted from commits. |
| `commits[].ticketIds` | Array of extracted ticket IDs (e.g. `["PROJ-123"]`) found in the commit subject and body. Empty array if none. |
| `conflictsWithNext` | `{ major, minor, patch }` — whether each tag already exists |

### Step 2 (PLAN): Determine Bump Type and Draft CHANGELOG

**Determine new version:**

The script (`skill/version.js`) does all label validation and bump-source resolution before this step runs. Read the resolved values from `VERSION_CONTEXT_JSON` and select the version verbatim — do not re-derive bump type from the original CLI string and do not consult `config.bump` after Step 1.

**Bump precedence (single source of truth — highest to lowest):**

| # | Condition (from prepare output) | Bump source |
| - | ------------------------------- | ----------- |
| 1 | `flags.bumpFromFlag === true` | `requestedBump` (from `--bump` named flag — authoritative) |
| 2 | `requestedBump` set AND `flags.bumpFromFlag === false` | `requestedBump` (positional bump — `major`/`minor`/`patch` or label-form) |
| 3 | `config.preRelease` active AND no bump | `requestedBump` auto-injected as `"patch"` (script-set; signalled by `flags.preLabelFromConfig === true`) |
| 4 | otherwise | `requestedBump = "patch"` default |

**Bump-promotion diagnostic:**
When `bumpPromotionDetected === true` in the prepare output, print this line verbatim before proceeding:
```
Commits suggest <suggestedBump> bump but <requestedBump> requested — staying with <requestedBump>. Override with `--bump <suggestedBump>` if intentional.
```
Substitute `<suggestedBump>` with `conventionalSummary.suggestedBump` and `<requestedBump>` with the resolved bump from the precedence above. Diagnostic only — do not change the bump or pause for approval here.

**Pre-release label resolution (orthogonal to bump):**

Pre-release intent comes from three mutually-exclusive sources, signalled by the provenance flags `flags.bumpFromLabel`, `flags.preLabelExplicit`, and `flags.preLabelFromConfig` (see field table above):

1. Explicit `--pre <label>` (`flags.preLabelExplicit === true`) — combines with whichever bump was resolved above
2. Positional label-form (e.g. `version-sdlc rc`, `flags.bumpFromLabel === true`) — script auto-set `requestedBump = "patch"`
3. `config.preRelease` default (`flags.preLabelFromConfig === true`) — script auto-set `requestedBump = "patch"`

When `flags.preLabel` is set, use `bumpOptions.preRelease`. Otherwise use `bumpOptions[requestedBump]`. The script has already computed both pre-release semantics (counter increment, label reset, label switch) and the next-version values.

**Breaking-change gate:** if `conventionalSummary.hasBreakingChanges` is `true` AND the resolved bump is not `major`, suggest `major` UNLESS the resolved bump is a pre-release from any source (`--pre`, label-form, or `config.preRelease`). Detect "is a pre-release" by checking that `flags.preLabel` is non-null. Pre-release trains skip this warning to avoid nagging on every RC iteration.

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

**Ticket ID references** — when `config.ticketPrefix` is set and a commit has non-empty `ticketIds`:
- Append the ticket IDs in parentheses at the end of the changelog entry: `- Added bulk operations endpoint (PROJ-456)`
- Multiple IDs for one commit: `(PROJ-456, PROJ-789)`
- Multiple commits contributing to one merged entry: include all unique ticket IDs from those commits
- Only include ticket IDs when `config.ticketPrefix` is set — otherwise skip them to avoid false positives from random uppercase patterns

### Step 2.5 (BRANCH-GUARD): HARD GATE — Expected Branch Check

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

Before executing, check whether the project's installed CI scripts need updating (notifies projects that ran `--init` in a prior session about improvements). Include `--changelog` only when `config.changelog === true` — the one legitimate post-CONSUME use of `config.changelog` (every other site gates on `flags.changelog`); do not "fix" this divergence.

```bash
SCAFFOLD_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/scaffold-ci.js" --check-only --output-file)
# Add --changelog if config.changelog === true:
# SCAFFOLD_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/scaffold-ci.js" --check-only --changelog --output-file)
```

Read the JSON output. If any files have `action: "outdated"` or `action: "missing"`:
   - Show what changed and which files would be updated (use `installedVersion` / `currentVersion` from the output)
   - Use AskUserQuestion to ask: "Update CI scripts? (yes / no) — this does not block the release."
   - **Auto mode:** When `flags.auto` is true, skip the AskUserQuestion and treat the response as `yes` — update outdated CI scripts automatically.
   - On `yes`: run `SCAFFOLD_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/scaffold-ci.js" --force)` (add `--changelog` if applicable) to overwrite the outdated files — `scaffold-ci.js` prints a manifest path, so capture it rather than calling `node …` bare
   - On `no`: warn and continue with the release

The release proceeds regardless of the user's answer. This is informational, not a gate.

### Step 8 (EXECUTE): Execute the Release

**Only execute after explicit `yes` from Step 5, or when `flags.auto` is true (implicit approval).**

1. **Update version file** (only if `config.mode === "file"`):
   - **For all version-file formats (JSON, TOML, YAML — package.json, plugin.json, Cargo.toml, pyproject.toml, etc.):** use the Edit tool with a single targeted string replacement. The `old_string` must contain the current version string in its on-disk form (e.g. `"version": "<currentVersion>"` for JSON, `version = "<currentVersion>"` for TOML). The `new_string` substitutes the new version only.
   - **DO NOT use the Write tool. DO NOT rewrite the file. DO NOT touch any other field.** The one-changed-line gate inside the release transaction (sub-step 4) aborts the release if a rewrite lands.
2. **Update CHANGELOG** (only if `flags.changelog === true` — same gate as Step 2 draft): Use the Edit or Write tool to prepend the new entry after the `## [Unreleased]` section if present, or after the file header if not. Create `CHANGELOG.md` if it does not exist.
3. **Link verification — HARD GATE.** Before the release transaction commits anything, validate every URL embedded in the new CHANGELOG entry (and any release-notes body) via the shared link validator. The script reads the body via `--file` and auto-derives `expectedRepo` from `parseRemoteOwner(cwd)` and `jiraSite` from `~/.sdlc-cache/jira/` — the skill MUST NOT construct ctx JSON. Skip this sub-step entirely when changelog is disabled and no release-notes body was generated.

   ```shell
node "<PLUGIN_ROOT>/scripts/util/version-validate-links.js" --file <path-to-body>
LINK_EXIT=$?
```

> **Contract (Input/Output):**
> - **Input**: CHANGELOG entry body via stdin, or via `--file <path>` argument.
> - **Output**: Prints violations to stderr and exits non-zero on broken links.

   On non-zero exit (`LINK_EXIT != 0`):
   - The script has already printed the violation list to stderr.
   - Do NOT run the release transaction (sub-step 4) — nothing may be committed or tagged. Surface the violation list verbatim to the user.
   - Stop. Do not retry. Do not edit URLs without user input. Do not bypass.

   On zero exit, proceed to step 4. `SDLC_LINKS_OFFLINE=1` skips network reachability while keeping context-aware checks — use in sandboxed CI.

4. **Run the release transaction** — one scripted step that re-checks the version-file diff gate, stages the changed files, creates the release commit, creates the annotated tag (with the `Type: hotfix` trailer under `--hotfix`), and performs the two-command push:

   ```shell
   node "<PLUGIN_ROOT>/scripts/util/version-execute.js" release --tag <newTag> --version-file <versionFile> --changelog-file CHANGELOG.md
   ```

   > **Contract (Input/Output):**
   > - **Input**: `--tag <newTag>` (required). Add `--hotfix` when `flags.hotfix === true`; `--version-file <versionFile>` only when `config.mode === "file"`; `--changelog-file CHANGELOG.md` only when `flags.changelog === true`; `--no-push` when `flags.noPush === true`; `--set-upstream <currentBranch>` when `remoteState.hasUpstream === false` — take `currentBranch` from the `version-context` output, never hardcode it. This auto-heals the first push from a fresh feature branch; no manual `git push -u` is required. At least one of `--version-file` / `--changelog-file` is required — with neither there is nothing to stage.
   > - **Output**: one JSON line — `{"status":"ok","tag":"<newTag>"}` on success (plus `"pushed":false` under `--no-push`), or `{"status":"failed","failedStep":"...","reason":"..."}`, with an additive `rolledBackTag` on a push failure and an additive `recovery` when the tag push failed after the release commit already reached the remote, and additive `restoredVersionFile` / `diff` when the version-file gate rejected the release.

   Branch on the result:
   - `{"status":"ok", ...}` — the commit, the tag, and (unless `--no-push`) both pushes landed. Continue to the result display.
   - `{"status":"failed","failedStep":"diff-gate", ...}` — more than the version line changed in `<versionFile>`, or the version edit never landed. The release is aborted; `restoredVersionFile` reports whether the file was restored. Surface `reason` and `diff` verbatim and stop.
   - `{"status":"failed","failedStep":"add"|"commit"|"tag", ...}` — nothing was pushed and no tag survives. Show `reason` and stop.
   - `{"status":"failed","failedStep":"push","rolledBackTag":true, ...}` — the release commit push failed before the tag reached the remote, so nothing landed and the local tag was deleted to keep the repo consistent. Show `reason`, resolve the push cause (auth, branch protection, non-fast-forward), and re-run the release.
   - `{"status":"failed","failedStep":"push-tags","rolledBackTag":false,"recovery":"...", ...}` — the release commit is already on the remote and only the tag push failed; the local tag is **kept** (it is the only recovery handle — the version-file gate makes a re-run impossible now that the bump has landed). Show `reason`, then run the `recovery` command verbatim (`git push <remote> <tag>`) to finish the release. Do **not** re-run the release.

**On script crash (exit 2):** Invoke error-report-sdlc — Glob `**/error-report-sdlc/REFERENCE.md`, follow with skill=version-sdlc, step=Step 8 — Release execution, error=stderr plus the `failedStep`/`reason` from the JSON line.

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

> When `VERSION_CONTEXT_JSON.flow === 'changelog-update'` (set by the script when `--changelog` is passed without a bump type), read `./resources/changelog-workflow.md` now for the complete changelog-update workflow steps.

See `resources/changelog-workflow.md` → Accuracy and limitations before trusting the draft.

---

### Branch D: Retag Workflow (`mode === "retag"`)

> When `VERSION_CONTEXT_JSON.mode === "retag"` (this flow ONLY activates when `mode` equals `"retag"` — never re-derive from raw `$ARGUMENTS`), read `./resources/retag-workflow.md` now for the complete retag workflow steps.

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
4. Changelog entries should be user-facing and outcome-focused, not implementation-focused
5. Set `version.preRelease` in `.sdlc/config.json` to default to a pre-release label (e.g. `"rc"`) on every bump until explicit graduation. Configure interactively via `/setup-sdlc`.

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
| `skill/version.js` node -e 'process.exit(1)' | Show `errors[]`, stop | No — user input error |
| `skill/version.js` node -e 'process.exit(2)' (crash) | Show stderr, stop | Yes |
| Tag already exists (`conflictsWithNext` true) | Suggest next patch/minor/major; let user choose | No — user decision |
| `release` returns `failedStep: "commit"` | Show `reason`; check for uncommitted changes or hook failure | Yes if non-hook failure |
| `release` returns `failedStep: "tag"` | Show `reason`; check for duplicate tag or missing git identity | Yes if non-duplicate failure |
| `release` returns `failedStep: "push"` | Show `reason`; check remote connectivity and branch protection rules; the tag was rolled back (`rolledBackTag: true`); re-run the release once resolved | Yes if non-auth failure |
| `release` returns `failedStep: "push-tags"` | Show `reason`; the release commit is already on the remote and the local tag is kept (`rolledBackTag: false`) — run the `recovery` command verbatim; do NOT re-run the release | Yes if non-auth failure |
| `retag` returns `status: "failed"` | Show `failedStep` and `reason`; when `recovered` is false the local tag must be recreated manually | Yes if non-auth failure |

When invoking `error-report-sdlc`, provide:
- **Skill**: version-sdlc
- **Step**: Step 0 (script crash) or Step 8 (release transaction failure)
- **Operation**: `skill/version.js` execution or `util/version-execute.js release`/`retag`
- **Error**: exit code 2 + stderr, or the `failedStep` and `reason` from the JSON line
- **Suggested investigation**: Check installed plugin version; verify git identity is configured; confirm remote is accessible

---

## Gotchas

- **`/version-sdlc --retag` vs `retag-release.yml`:** `--retag` is user-initiated (you deliberately move the tag to HEAD). `retag-release.yml` (scaffolded during init) is CI-automated: it fires on every push to main and fixes squash-merge drift — GitHub's "squash and merge" leaves the feature-branch tag pointing at a pre-merge commit that's unreachable from main, so the workflow moves it to the squash commit. The two are orthogonal; do not conflate them. Without the workflow, orphaned tags won't show in `git describe` / `git log --decorate` on main.
- `bumpOptions.preRelease` is pre-computed in the JSON only when `--pre` was passed at script time. If the user requests a different pre-label during `edit`, re-run the script — the `preRelease` field reflects the label passed at script invocation, not a label added mid-session.
- **Version-file edit hard gate:** never use the Write tool or rewrite the version file from memory — LLMs reliably truncate or paraphrase fields like `description`. The Step 8 release transaction enforces this: it aborts the release when more than one line of `<versionFile>` differs, and restores the file.
- If the working tree has uncommitted changes at execution time, the release commit will include only the staged version file and changelog changes. Warn the user so they are not surprised by files missing from the commit.
- `conventionalSummary.suggestedBump` is derived from commit types. If there are no conventional commits since the last tag, the suggested bump may default to `patch` — confirm with the user if this seems wrong.

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
