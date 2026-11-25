---
name: version-sdlc
description: "Use this skill when bumping a project version, creating a git release tag, generating a changelog, performing a full semantic release workflow, updating the changelog entry for the current version, or retagging the current version at HEAD. Consumes pre-computed context from skill/version.js and handles the complete release process. Use --changelog without a bump type to update the changelog for the already-tagged current version. Use --retag to move an existing tag to HEAD. Arguments: [major|minor|patch|<label>] [--init] [--pre <label>] [--no-push] [--changelog] [--hotfix] [--retag] [--auto]. The positional `<label>` form (e.g. `version-sdlc rc`) is sugar for `--bump patch --pre <label>` and accepts any pre-release label matching `^[a-z][a-z0-9]*$`. Triggers on: version bump, create release, bump version, tag release, generate changelog, semantic versioning, semver bump, pre-release, release candidate, retag release. Use --auto to skip interactive approval prompts (release plan is still displayed)."
user-invocable: true
argument-hint: "[major|minor|patch|<label>] [--init] [--pre <label>] [--no-push] [--changelog] [--hotfix] [--retag] [--auto]"
---

# Versioning Releases Skill

Consume pre-computed version context from `skill/version.js` and execute one-time init setup, a full semantic release (version bump, annotated git tag, optional CHANGELOG entry, release commit, push), changelog update, or retag.

**Announce at start:** "I'm using version-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

> Branch A/B edge rules (provenance flags, pre-release & ticket-ID edge rules, CI staleness handling, Step 8 transaction failure recovery, error-recovery matrix, and release gotchas) live in `./resources/branch-fallback-rules.md`.

---

## Step 0 — Plan Mode Check & Run `skill/version.js`

If the system context contains "Plan mode is active":
1. Announce: "This skill requires write operations (git tag, git push). Exit plan mode first, then re-invoke `/version-sdlc`."
2. Stop. Do not proceed to subsequent steps.

> **VERBATIM** — Run this block exactly as written, replacing `<PLUGIN_ROOT>` with the absolute path to this plugin. Note the strict script location pattern: `node "<PLUGIN_ROOT>/scripts/<group>/<script-name>.js"` — the scripts are Node CLI files invoked with `node`. Do not modify, rephrase, or simplify the commands.

```shell
VERSION_CONTEXT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/version.js" --output-file $ARGUMENTS)
EXIT_CODE=$?

echo "VERSION_CONTEXT_FILE: $VERSION_CONTEXT_FILE"
echo "STATUS: $EXIT_CODE"
```

Read and parse `VERSION_CONTEXT_FILE` as `VERSION_CONTEXT_JSON`. `skill/version.js` writes into the OS temp directory — do not add scattered `rm -f` calls.

- **Exit 1:** JSON still contains `errors`; display each error and stop.
- **Exit 2 (script crash):** Show `Script error — see output above` and stop; invoke `error-report-sdlc` (`find_by_name` `**/error-report-sdlc/REFERENCE.md`) with `skill=version-sdlc`, `step=Step 0 — skill/version.js execution`, `error=stderr`.
- **Non-empty `VERSION_CONTEXT_JSON.errors`:** Display each error and stop.
- **Non-empty `VERSION_CONTEXT_JSON.warnings`:** Display warnings. For `"You have uncommitted changes"`, use `ask_question` (`proceed` / `commit first` → invoke `/commit-sdlc` then re-invoke `/version-sdlc` with original args / `cancel`).

Branch on `VERSION_CONTEXT_JSON.flow` and `VERSION_CONTEXT_JSON.mode`:
- `mode === "retag"` → **Branch D: Retag Workflow**
- `flow === "init"` → **Branch A: Init Workflow**
- `flow === "release"` → **Branch B: Release Workflow**
- `flow === "changelog-update"` → **Branch C: Changelog-Update Workflow**

---

### Branch A: Init Workflow (`flow === "init"`)

> When `flow === "init"`, read `./resources/init-workflow.md` now for the complete init workflow steps. See `./resources/branch-fallback-rules.md` for additional edge rules.

---

### Branch B: Release Workflow (`flow === "release"`)

#### Step 1 (CONSUME): Read the Context

Extract key fields from `VERSION_CONTEXT_JSON` (see `./resources/branch-fallback-rules.md` for full provenance & `ticketIds` details):

| Field | Description |
| ----- | ----------- |
| `versionSource.currentVersion` | Current version string |
| `config.mode` / `config.changelog` | `"file"` or `"tag"`; default changelog flag |
| `requestedBump` | Resolved `"major"`, `"minor"`, `"patch"`, or `null` |
| `conventionalSummary` | `{ suggestedBump, hasBreakingChanges }` (**informational only**, never a bump source) |
| `bumpPromotionDetected` | `true` when `suggestedBump` outranks `requestedBump` (triggers Step 2 diagnostic) |
| `bumpOptions` | `{ major, minor, patch, preRelease }` — pre-computed next versions |
| `tags.latest` / `commits` | Most recent tag and commits since last tag |
| `flags` | `{ preLabel, noPush, changelog, hotfix, auto, bumpFromFlag, bumpFromLabel, preLabelExplicit, preLabelFromConfig }` |
| `conflictsWithNext` | `{ major, minor, patch }` — whether each tag already exists |

#### Step 2 (PLAN): Determine Bump Type and Draft CHANGELOG

Select the version verbatim from `VERSION_CONTEXT_JSON` (do not re-derive bump from raw CLI args or consult `config.bump` after Step 1):

| # | Condition (from prepare output) | Bump source |
| - | ------------------------------- | ----------- |
| 1 | `flags.bumpFromFlag === true` | `requestedBump` (`--bump` named flag — authoritative) |
| 2 | `requestedBump` set AND `flags.bumpFromFlag === false` | `requestedBump` (positional bump or label-form) |
| 3 | `config.preRelease` active AND no bump | `requestedBump` auto-injected as `"patch"` (`flags.preLabelFromConfig === true`) |
| 4 | otherwise | `requestedBump = "patch"` default |

- **Bump-promotion diagnostic:** If `bumpPromotionDetected === true`, print verbatim:
  `Commits suggest <suggestedBump> bump but <requestedBump> requested — staying with <requestedBump>. Override with \`--bump <suggestedBump>\` if intentional.`
- **Pre-release & breaking-change gate:** Use `bumpOptions.preRelease` when `flags.preLabel` is set, else `bumpOptions[requestedBump]`. If `hasBreakingChanges === true` and resolved bump != `major` and `flags.preLabel` is null, warn/suggest `major`. (Full provenance & pre-release rules in `./resources/branch-fallback-rules.md`.)
- **Draft CHANGELOG entry** (only when `flags.changelog === true`): Keep a Changelog format `## [x.y.z] - YYYY-MM-DD`, mapping `feat` → **Added**, `fix` → **Fixed**, `refactor`/`perf` → **Changed**, marking breaking commits `(BREAKING)`, skipping internal `chore`/`docs`/`test`/`ci`/`build`/`style` unless user-facing, and appending `(TICKET-ID)` when `config.ticketPrefix` is set (see `./resources/branch-fallback-rules.md`).

#### Step 2.5 (BRANCH-GUARD): HARD GATE — Expected Branch Check

Check `branchGuard.active` and `branchGuard.ok` from `VERSION_CONTEXT_JSON`:
- If `branchGuard.active === true` AND `branchGuard.ok === false`: surface `branchGuard.message` verbatim and **halt immediately** (do NOT re-derive branch via shell commands or proceed to Step 3).
- Otherwise proceed to Step 3.

#### Step 3–4 (CRITIQUE & IMPROVE)

Review the planned version and CHANGELOG draft against every gate in `## Quality Gates` below. Fix any failing gate (max 2 iterations per gate) before Step 5.

#### Step 5 (DO): Present Release Plan for Approval

Display the full release plan (and draft CHANGELOG if `flags.changelog === true`). **Do not execute any git commands before explicit approval via `ask_question` (or implicit approval when `flags.auto === true`).**

```
Release Plan
────────────────────────────────────────────
Version:    1.2.3 → 1.3.0
Tag:        v1.3.0 (annotated)
File:       package.json
Push:       yes (to origin/main)
Changelog:  yes             ← 'yes' when flags.changelog === true, else 'no'
Hotfix:     yes             ← only shown when flags.hotfix === true
────────────────────────────────────────────
```

Prompt via `ask_question`: `Execute this release?` (`yes` / `edit` / `cancel`). On `edit`, revise and re-present until `yes` or `cancel`. Under `flags.auto === true`, skip `ask_question` and proceed after displaying the plan.

#### Step 6–7 (Pre-conditions) & Step 7.5 (CI Script Check)

Verify pre-conditions: version file exists (`config.mode === "file"`), `conflictsWithNext[bumpType]` is false, warn via `git status --porcelain` if uncommitted changes exist, note `remoteState.hasUpstream` (Step 8 self-heals missing upstream), and confirm `git config user.name` & `git config user.email` are non-empty. Fix any blocker before continuing.

**Step 7.5 (Informational CI script check):** Include `--changelog` only when `config.changelog === true`:

```bash
SCAFFOLD_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/scaffold-ci.js" --check-only --output-file)
# Add --changelog if config.changelog === true:
# SCAFFOLD_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/scaffold-ci.js" --check-only --changelog --output-file)
```

If any file has `action: "outdated"` or `"missing"`, prompt via `ask_question` (auto-`yes` under `flags.auto`) and on `yes` run `SCAFFOLD_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/scaffold-ci.js" --force)` (plus `--changelog` if applicable). See `./resources/branch-fallback-rules.md` for details.

#### Step 8 (EXECUTE): Execute the Release

**Only execute after explicit `yes` from Step 5 or `flags.auto === true`.**

1. **Update version file** (only if `config.mode === "file"`):
   - Use `replace_file_content` with a single targeted replacement (`StartLine`/`EndLine`) updating only the version string (e.g. `"version": "<currentVersion>"` or `version = "<currentVersion>"`).
   - **DO NOT use `write_to_file`. DO NOT rewrite the file or touch any other field.** The diff-gate in sub-step 4 aborts if more than one line changes.
2. **Update CHANGELOG** (only if `flags.changelog === true`): Prepend the entry after `## [Unreleased]` (or file header) via `replace_file_content`, or create `CHANGELOG.md` with `write_to_file`.
3. **Link verification — HARD GATE** (skip if changelog is disabled and no release-notes body exists):

```shell
node "<PLUGIN_ROOT>/scripts/util/version-validate-links.js" --file <path-to-body>
LINK_EXIT=$?
```
> **Contract (Input/Output):**
> - **Input**: CHANGELOG entry body via stdin or `--file <path>` (script auto-derives `expectedRepo` and `jiraSite`).
> - **Output**: Prints violations to stderr and exits non-zero on broken links.

On `LINK_EXIT != 0`: surface the stderr violation list verbatim and **stop immediately** — do NOT run sub-step 4, retry, or edit URLs without user input. (`SDLC_LINKS_OFFLINE=1` skips network checks in sandboxed CI.)

4. **Run the release transaction** (re-checks version-file diff gate, stages, commits, creates annotated tag, pushes):

```shell
node "<PLUGIN_ROOT>/scripts/util/version-execute.js" release --tag <newTag> --version-file <versionFile> --changelog-file CHANGELOG.md
```
> **Contract (Input/Output):**
> - **Input**: `--tag <newTag>` (required); `--hotfix` when `flags.hotfix === true`; `--version-file <versionFile>` only when `config.mode === "file"`; `--changelog-file CHANGELOG.md` only when `flags.changelog === true`; `--no-push` when `flags.noPush === true`; `--set-upstream <currentBranch>` when `remoteState.hasUpstream === false` (at least one of `--version-file` / `--changelog-file` is required).
> - **Output**: One JSON line: `{"status":"ok","tag":"<newTag>"}` or `{"status":"failed","failedStep":"...","reason":"..."}`.

Handle JSON result (`diff-gate`, `add|commit|tag`, `push` with `rolledBackTag: true`, `push-tags` with `rolledBackTag: false` & `recovery` command) and exit-2 crashes per `./resources/branch-fallback-rules.md` ("Step 8 Release Transaction Failure & Recovery Rules").

Display result:
```
✓ Release v1.3.0 complete.
  Commit: abc1234 — chore(release): v1.3.0
  Tag:    v1.3.0
  Pushed: yes → origin/main
```
(Append `(hotfix)` / `[hotfix]` / `(annotated with Type: hotfix)` when `flags.hotfix === true`.)

---

### Branch C: Changelog-Update Workflow (`flow === "changelog-update"`)

> When `VERSION_CONTEXT_JSON.flow === 'changelog-update'`, read `./resources/changelog-workflow.md` now for the complete workflow and accuracy/limitations notes.

### Branch D: Retag Workflow (`mode === "retag"`)

> When `VERSION_CONTEXT_JSON.mode === "retag"` (never re-derive from raw `$ARGUMENTS`), read `./resources/retag-workflow.md` now for the complete retag workflow.

---

## Quality Gates

| Gate | Check | Pass Criteria |
| ---- | ----- | ------------- |
| Semver correctness | New version is valid semver | `major.minor.patch[-pre]`, no leading zeros |
| Breaking change bump | If `hasBreakingChanges`, bump is major (or pre-release) | Warn if minor/patch chosen with breaking commits |
| Tag conflict | New tag does not already exist | `conflictsWithNext[bumpType]` is false |
| Changelog completeness | All user-facing commits represented | No feat/fix commits silently omitted (if enabled) |
| No fabricated entries | Every CHANGELOG entry traces to a real commit | (if changelog enabled) |
| Commit count | There are commits to release | `commits.length > 0` OR pre-release |
| Version file writable | File type is supported | `fileType` is in the known list |

---

## DO NOT

- Execute any git commands without explicit user approval (`yes`) or auto-mode implicit approval (`flags.auto === true`)
- Fabricate commit descriptions or changelog entries not backed by real commits
- Skip the CRITIQUE step even if the plan looks obviously correct
- Push to remote without checking `flags.noPush`
- Modify the version file if `config.mode === "tag"` — in tag mode, the version lives in git only
- Omit the pre-condition verification in Step 6 before executing

---

## Error Recovery, Gotchas & Learning Capture

- **Error Recovery & Gotchas:** See `./resources/branch-fallback-rules.md` for the full failure/recovery table, `error-report-sdlc` arguments, `--retag` vs `retag-release.yml` distinction, and version-file edit hard gate details.
- **Learning Capture:** Append notable version-file quirks, tag conventions, monorepo patterns, or release edge cases to `.sdlc/learnings/log.md` (`## YYYY-MM-DD — version-sdlc: <summary>`).

## See Also

- [`/commit-sdlc`](../commit-sdlc/SKILL.md) — commit changes before tagging a release
- [`/jira-sdlc`](../jira-sdlc/SKILL.md) — update Jira ticket status after release
- [`/pr-sdlc`](../pr-sdlc/SKILL.md) — the PR that triggered this release
