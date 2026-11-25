# Setup Section & Migration Guide

Reference details for `setup-sdlc` cold paths: `skill/setup.js` manifest schema, legacy config migration, generic field-loop edge rules, specialized section notes, and the delegated project-signal scan.

---

## Pre-flight Manifest Schema (`skill/setup.js`)

Top-level keys returned in `$PREPARE_OUTPUT_FILE`:
- `projectConfig` — `{ exists, sections, misplaced, path }`
- `localConfig` — `{ exists, path }`
- `legacy` — `{ version, ship, review, reviewLegacy, jira, jiraTemplates }`, each `{ exists, path }`. `jiraTemplates.exists` is `true` when `.sdlc/jira-templates/` is present.
- `openspecConfig` — `{ exists, path, managedBlockVersion }` state of `openspec/config.yaml`
- `content` — `{ reviewDimensions: { count, path }, prTemplate: { exists, path }, jiraTemplates: { count, path } }`
- `detected` — `{ versionFile, fileType, tagPrefix, defaultBranch }`
- `needsMigration` — boolean flag (see Migration Workflow below)
- `preReleaseCompat` — compatibility map keyed by `fileType` for `version.preRelease`
- `menuInputContract` — `{ defaultToken }` for Step 1 menu reply parsing
- `scriptVersions` — `{ outdatedCount, ... }` for Step 0 CI script staleness warning
- `sections` — array of section descriptors driving Steps 1 and 3 (`{ id, label, state ('set'|'not-set'|'legacy'), summary, locked, purpose, configFile, configPath, consumedBy, filesModified, optional, delegatedTo, confirmDetected, fields[] }`). Source of truth: `scripts/lib/setup-sections.js`.

---

## Migration Workflow (Step 2)

`needsMigration` is `true` when ANY of these conditions hold:
- A legacy config file exists (`.sdlc/version.json`, `.sdlc/ship-config.json`, `.sdlc/jira-config.json`, `.sdlc/review.json`).
- `.sdlc/config.json` contains misplaced sections (e.g., `ship` in project config).
- `.sdlc/local.json` uses the v1 schema — has legacy `ship.preset` or `ship.skip` keys, or lacks the top-level `version: 2` stamp (`localIsV1` from prepare output).
- `legacy.jiraTemplates.exists` is `true` (`.sdlc/jira-templates/` detected).

### Confirmation & Execution

1. If legacy files exist or `projectConfig.misplaced` is non-empty, use `ask_question`:
   > Legacy config files detected. Migrate to unified config before proceeding?
2. Else if `localIsV1` is `true`, use `ask_question`:
   > Ship config at `.sdlc/local.json` uses a v1 schema (missing `version: 2`, or has legacy `preset`/`skip` keys). Migrate to v2 format?
3. Options:
   - **yes** — migrate now (recommended)
   - **no** — configure from scratch

**On yes:**
- Note that `lib/config.js::readLocalConfig` never migrates on read (pure read, no write path) and `config-version.js::verifyAndMigrate` never migrates either (`migrated: false`). For `localIsV1`, the actual fix is running the `ship` section through Step 3: `writeLocalConfig` does a top-level merge, replacing the legacy `preset`/`skip` object and stamping the current schema version.
- Re-run `skill/setup.js` to refresh state (`legacy` and `projectConfig.misplaced`):

```shell
PREPARE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/setup.js" $ARGUMENTS)
EXIT_CODE=$?
echo "PREPARE_OUTPUT_FILE=$PREPARE_OUTPUT_FILE"
echo "EXIT_CODE=$EXIT_CODE"
```
> **Contract (Input/Output):**
> - **Input**: None.
> - **Output**: Prints the path of a temp JSON manifest (via `writeOutput`), with `legacy` and `projectConfig.misplaced` refreshed.

- Parse `$PREPARE_OUTPUT_FILE` and delete it with `rm -f "$PREPARE_OUTPUT_FILE"`.
- If `prepare.legacy.jiraTemplates.exists` is `true`, report `.sdlc/jira-templates/` as a leftover the user may delete manually (nothing migrates it automatically).
- Report migration results:
  - List each file from `migrated`.
  - List each file from `conflicts` with explanation: `"Conflict: unified config already has this section -- legacy file was NOT merged"`.
- Prompt with `ask_question`:
  > Delete legacy config files?
  Options: **yes** (delete migrated files — keeps backup in git history) / **no** (keep legacy files alongside unified config).
- On **yes**, delete each file listed in `migrated` using `run_command` (`rm`). **Do NOT delete files listed in `conflicts`.**
- Re-run `skill/setup.js` (same command block as Step 0) to refresh state before Step 3.

**On no (configure from scratch):** Proceed directly to Step 3 without migration.

---

## Generic Field Loop & Section Details (Step 3)

### `confirmDetected` Meta-Prompt (`version`)

When `section.confirmDetected === true`:
1. Dispatch `ask_question`:
   > Use detected settings, customize each field, or skip this section?
   Options: `yes` (write detected values directly), `customize` (iterate `section.fields`), `skip` (write nothing for this section).
2. **On yes:** Build the section value from `prepare.detected.*` (for `version`: `{ mode: 'file', versionFile, fileType, tagPrefix }`; if `prepare.detected.versionFile` is `null`, use `{ mode: 'tag', tagPrefix }`). Do **not** write `preRelease` on the `yes` path, and skip the `preReleaseCompat` check below.
3. **On customize:** Iterate `section.fields[]`.
4. **On skip:** Stop processing this section; write nothing.

### Field Gating & Answer Mapping

For each entry `field` in `section.fields[]`:
- **Prepare-sourced skip gate:** If `field.skip === true` (set when a `when.stepInActiveSteps` gate is unsatisfied), skip the field without prompting or writing a value.
- **Upstream answer skips:** For `version`, skip `versionFile` and `fileType` if `mode === 'tag'`; skip `changelogFile` if `changelog === false`; omit `preRelease` from written config when the user enters an empty string.
- **Prompt structure:** Question = `field.label`, helper text = `field.description` (verbatim from manifest), choices = `field.options` (or free-text when `null`), default = `field.default`. If `field.validate` is defined, re-prompt on failure showing the regex/constraint inline.
- **Answer mapping:**
  - `enum` → selected option string verbatim
  - `multi-select` → array of selected options
  - `boolean` → `yes` → `true`, `no` → `false` (**exception:** `rebase` writes `auto`/`skip`/`prompt` verbatim)
  - `string` → entered string; omit when empty and optional
  - `number` → coerce via `parseInt`; validate `field.min` / `field.max`, re-prompting on invalid input with the violated bound cited
  - `list` → split comma-separated input on `,`, trim each element, write string array

### Version Pre-Release Compatibility Check (`preReleaseCompat`)

After collecting all `version` fields and **before** storing the section object:
1. If `mode === 'tag'` or `preRelease` is empty/omitted → skip this check.
2. Look up `compat = prepare.preReleaseCompat[<chosen-fileType>]`.
3. Branch on `compat.level`:
   - `compatible` → store section as-is; no prompt.
   - `partial` or `unknown` → print `compat.message`, then `ask_question` (single-select): `"Proceed with \`preRelease: <value>\` for \`<fileType>\`?"` → `yes` (store as-is) / `no` (omit `preRelease`).
   - `incompatible` → print `compat.message`, then `ask_question` (single-select): `"Pre-release labels are not supported for \`<fileType>\`. Clear \`preRelease\`, or proceed anyway?"` → `clear` (omit `preRelease`) / `proceed` (store as-is, accepting risk).
4. State-machine idempotency: run at most once per `(fileType, preRelease)` pair in a single uninterrupted Step 3 execution.

### Specialized Section Notes

- **`commit` & `pr` (`inline-commit-builder` / `inline-pr-builder`):** Read and follow `@resources/setup-patterns.md` in full after printing the Step 3 verbose header. The `pr` builder's `same-as-commit` option depends on `commit` running first in `prepare.sections[]` order.
- **`workspace` (`delegatedTo: null`):** Uses 3.G, but overrides `layout`-field rendering with a numbered menu, live previews, and mismatch warning. Read and follow `@resources/setup-workspace.md` in full. Writes to `.sdlc/local.json` (gitignored, per-developer) — never `.sdlc/config.json`.
- **`hooks` (`delegatedTo: null`):** Single boolean field `agentIsolationGuard.enabled` (default `true`) — *"Block Agent SDK `isolation: \"worktree\"` parameter? (Recommended: yes — prevents wrong-worktree commits)"*. On **yes**: omit or write `{"hooks":{"agentIsolationGuard":{"enabled":true}}}`. On **no**: write `{"hooks":{"agentIsolationGuard":{"enabled":false}}}`. Lands in `.sdlc/local.json` — never `.sdlc/config.json`.

---

## Project Signal Scan (Step 3.S)

Run once per setup invocation before invoking `setup-dimensions` or `setup-pr-template`, and cache the resulting "Scan Input" object across subsequent delegated sections in `selectedIds`.

> **Shell safety:** Use `find_by_name` for all file/directory existence checks. Do NOT use `run_command` `ls` with glob patterns (zsh errors on unmatched globs). Use `run_command` only for `git`, `gh`, and `which`.

Collect:
- **Dependency manifests:** `find_by_name` `package.json`, `requirements.txt`, `Pipfile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`; read each via `read_file`.
- **Framework config:** `find_by_name` `**/jest.config.*`, `**/vitest.config.*`, `**/.eslintrc*`, `**/tsconfig.json`, `**/openapi.yaml`, `**/openapi.json`, `**/.prettierrc*`.
- **Directory structure:** `find_by_name` `src/`, `lib/`, `controllers/`, `services/`, `middleware/`, `models/`, `routes/`, `api/`, `pkg/`, `cmd/`, `internal/`, plus patterns from `@resources/scan-patterns.md`.
- **CI/CD config:** `find_by_name` `.github/workflows/*.yml`, `Jenkinsfile`, `.circleci/config.yml`, `.gitlab-ci.yml`.
- **Database presence:** `find_by_name` `prisma/`, `migrations/`, `alembic.ini`, `db/migrate/`, `**/sequelize*`, `**/typeorm*`, `**/sqlalchemy*`.
- **Test structure:** `find_by_name` `test/`, `tests/`, `spec/`, `__tests__/`, `cypress/`, `**/playwright.config.*`.
- **Existing content:** `find_by_name` `.sdlc/review-dimensions/*` (dimensions); `.github/PULL_REQUEST_TEMPLATE.md`, `.github/pull_request_template.md`, `.sdlc/pr-template.md` (PR template); `read_file` `.sdlc/config.json` → `plan.guardrails`.
- **AGENTS.md:** `read_file` `AGENTS.md` and `.sdlc/AGENTS.md` if present.
- **GitHub hosting & PR history:** `run_command` `git remote -v`, `gh repo view`, `gh pr list --limit 5 --json title,body`; `find_by_name` `.github/`.
- **JIRA evidence:** `run_command` `git log --oneline -20`, `git rev-parse --abbrev-ref HEAD`.
