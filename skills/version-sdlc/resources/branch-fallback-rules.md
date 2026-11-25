# Version Branch A/B Edge & Fallback Rules

Reference guide for `version-sdlc` cold paths: Branch A/B context provenance, pre-release & changelog edge rules, CI script staleness handling, Step 8 transaction failure recovery, error-report matrix, and release gotchas.

---

## Branch B Context Provenance (`Step 1` Details)

Additional fields in `VERSION_CONTEXT_JSON`:
- `requestedBump` — `"major"`, `"minor"`, `"patch"`, or `null`. Auto-set to `"patch"` by `skill/version.js` when `flags.bumpFromLabel === true` (positional `<label>` sugar) or `flags.preLabelFromConfig === true` (config-driven default). Authoritative when `flags.bumpFromFlag === true`.
- `conventionalSummary.suggestedBump` — auto-detected bump type from commits (**informational only**, never a bump source).
- `bumpPromotionDetected` — `true` when `conventionalSummary.suggestedBump` outranks `requestedBump`. Drives the Step 2 diagnostic line without altering the resolved bump.
- `flags` — `{ preLabel, noPush, changelog, hotfix, auto, bumpFromFlag, bumpFromLabel, preLabelExplicit, preLabelFromConfig }`. The three pre-release provenance flags (`bumpFromLabel`, `preLabelExplicit`, `preLabelFromConfig`) are mutually exclusive.
- `config.ticketPrefix` & `commits[].ticketIds` — when `config.ticketPrefix` (e.g., `"PROJ"`) is set, ticket IDs extracted from commit subjects and bodies populate `commits[].ticketIds`.

---

## Pre-Release, Breaking-Change & Changelog Edge Rules (`Step 2` Details)

### Pre-Release Label Resolution (Orthogonal to Bump)

`skill/version.js` pre-computes `bumpOptions.preRelease` (including counter increments, label resets, and label switches) from one of three mutually-exclusive sources:
1. Explicit `--pre <label>` (`flags.preLabelExplicit === true`) — combines with whichever bump was resolved.
2. Positional label-form (e.g., `version-sdlc rc`, `flags.bumpFromLabel === true`) — script auto-sets `requestedBump = "patch"`.
3. `config.preRelease` default (`flags.preLabelFromConfig === true`) — script auto-sets `requestedBump = "patch"`.

When `flags.preLabel` is set, select `bumpOptions.preRelease`; otherwise select `bumpOptions[requestedBump]`.

### Breaking-Change Gate

If `conventionalSummary.hasBreakingChanges` is `true` AND the resolved bump is not `major`, suggest `major` **unless** `flags.preLabel` is non-null (pre-release trains from `--pre`, label-form, or `config.preRelease` skip this warning to avoid nagging on every RC iteration).

### Changelog Drafting & Ticket Formatting Details

- Map `feat` → **Added**, `fix` → **Fixed**, `refactor`/`perf` → **Changed**; mark breaking commits `(BREAKING)` inline in their section.
- Skip `chore`, `docs`, `test`, `ci`, `build`, `style` unless clearly user-facing from the description.
- Rewrite implementation-focused commit messages into user-facing, outcome-focused language and merge closely related commits into single entries.
- **Ticket IDs** (only when `config.ticketPrefix` is set — skip otherwise to avoid false positives):
  - Append at the end of the entry in parentheses: `- Added bulk operations endpoint (PROJ-456)` or `(PROJ-456, PROJ-789)`.
  - For merged entries across multiple commits, include all unique ticket IDs.

---

## Outdated CI Scripts Handling (`Step 7.5` Details)

After running `SCAFFOLD_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/scaffold-ci.js" --check-only --output-file)` (adding `--changelog` **only** when `config.changelog === true` — the one legitimate post-CONSUME use of `config.changelog`):
- If any entries have `action: "outdated"` or `action: "missing"`:
  1. Display which files changed and their `installedVersion` / `currentVersion`.
  2. Use `ask_question`: `"Update CI scripts? (yes / no) — this does not block the release."`
  3. **Auto mode:** When `flags.auto === true`, skip `ask_question` and treat as `yes`.
  4. **On `yes`:** Run `SCAFFOLD_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/scaffold-ci.js" --force)` (plus `--changelog` if applicable; always capture the manifest path printed by `scaffold-ci.js`).
  5. **On `no`:** Warn and continue. This check is informational and never blocks the release.

---

## Step 8 Release Transaction Failure & Recovery Rules

`util/version-execute.js release` emits one JSON line:
- `{"status":"ok","tag":"<newTag>"}` (plus `"pushed":false` under `--no-push`) — commit, tag, and pushes landed.
- `{"status":"failed","failedStep":"diff-gate", ...}` — more than the version line changed in `<versionFile>`, or the edit never landed. Release aborted; `restoredVersionFile` indicates restoration. Surface `reason` and `diff` verbatim and stop.
- `{"status":"failed","failedStep":"add"|"commit"|"tag", ...}` — nothing pushed and no tag survives. Show `reason` and stop.
- `{"status":"failed","failedStep":"push","rolledBackTag":true, ...}` — commit push failed before the tag reached remote; local tag was deleted to stay consistent. Show `reason`, resolve the push cause (auth, branch protection, non-fast-forward), and re-run the release.
- `{"status":"failed","failedStep":"push-tags","rolledBackTag":false,"recovery":"...", ...}` — release commit is already on remote and only the tag push failed; local tag is **kept** (version-file gate prevents re-running). Show `reason` and run the `recovery` command verbatim (`git push <remote> <tag>`). **Do not** re-run the release.

**On script crash (exit 2):** Invoke `error-report-sdlc` (`find_by_name` `**/error-report-sdlc/REFERENCE.md`) with `skill=version-sdlc`, `step=Step 8 — Release execution`, `error=stderr` plus `failedStep`/`reason`.

---

## Error Recovery Matrix

> **Flow**: detect → diagnose → auto-recover (retry once if transient) → invoke `error-report-sdlc` for persistent actionable failures.

| Error | Recovery | Invoke `error-report-sdlc`? |
|-------|----------|-----------------------------|
| `skill/version.js` exit 1 | Show `errors[]`, stop | No — user input error |
| `skill/version.js` exit 2 (crash) | Show stderr, stop | Yes |
| Tag already exists (`conflictsWithNext` true) | Suggest next patch/minor/major; let user choose | No — user decision |
| `release` → `failedStep: "commit"` | Show `reason`; check uncommitted changes or hook failure | Yes if non-hook failure |
| `release` → `failedStep: "tag"` | Show `reason`; check duplicate tag or missing git identity | Yes if non-duplicate failure |
| `release` → `failedStep: "push"` | Show `reason`; check remote/branch protection; tag rolled back (`rolledBackTag: true`); re-run once resolved | Yes if non-auth failure |
| `release` → `failedStep: "push-tags"` | Commit is on remote, local tag kept (`rolledBackTag: false`); run `recovery` command verbatim; do NOT re-run | Yes if non-auth failure |
| `retag` → `status: "failed"` | Show `failedStep` and `reason`; if `recovered: false`, recreate local tag manually | Yes if non-auth failure |

When invoking `error-report-sdlc`, provide:
- **Skill**: `version-sdlc`
- **Step**: Step 0 (script crash) or Step 8 (release transaction failure)
- **Operation**: `skill/version.js` or `util/version-execute.js release`/`retag`
- **Error**: exit code 2 + stderr, or `failedStep` and `reason` from JSON line
- **Suggested investigation**: Check installed plugin version; verify git identity; confirm remote accessibility

---

## Best Practices & Gotchas

1. Running a full release without `--pre` graduates a pre-release to stable; an explicit `--bump major|minor|patch` overrides `config.preRelease` and graduates out of the train.
2. Configure `version.preRelease` in `.sdlc/config.json` interactively via `/setup-sdlc`.
3. **`/version-sdlc --retag` vs `retag-release.yml`:** `--retag` is user-initiated (moves tag to HEAD). `retag-release.yml` (scaffolded on init) is CI-automated on push to `main` to fix squash-merge tag drift; the two are orthogonal.
4. `bumpOptions.preRelease` is only pre-computed when `--pre` (or config/label) was active at script time. If the user picks a different pre-label during `edit`, re-run `skill/version.js`.
5. If the working tree has uncommitted changes at execution time, the release commit stages only the version file and changelog; warn the user beforehand.
6. When no conventional commits exist since the last tag, `conventionalSummary.suggestedBump` may default to `patch` — confirm with the user if unexpected.
