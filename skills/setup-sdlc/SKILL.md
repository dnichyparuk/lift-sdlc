---
name: setup-sdlc
description: "Use this skill when setting up Lift-SDLC for a project, initializing configuration, or when any skill reports missing config. Renders a selective-section menu so users choose which sections to configure; each selected section prints a verbose header (purpose, files-modified, consuming skills, per-option description) before any prompt. Supports direct sub-flow entry via --only, --dimensions, --pr-template, --guardrails, --execution-guardrails, --openspec-enrich. Arguments: [--migrate] [--skip <section>] [--force] [--only <ids>] [--dimensions] [--pr-template] [--guardrails] [--execution-guardrails] [--openspec-enrich] [--remove-openspec] [--add] [--no-copilot]"
user-invocable: true
argument-hint: "[--migrate] [--skip <section>] [--force] [--only <ids>] [--dimensions] [--pr-template] [--guardrails] [--execution-guardrails] [--openspec-enrich] [--remove-openspec] [--add] [--no-copilot]"
model: gemini-3.8-flash-medium
---

# SDLC Setup

Unified setup skill that replaces the fragmented first-use experience. Detects existing
configuration, migrates legacy files, walks the user through missing sections, and
delegates content creation to specialized skills.

**Announce at start:** "I'm using setup-sdlc (sdlc v{sdlc_version})." -- extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

---

## Arguments

| Flag | Description | Default |
|------|-------------|---------|
| `--migrate` | Force migration of legacy config files even if no legacy files are auto-detected | off |
| `--skip <section>` | Skip a config section during setup. Valid values: `version`, `ship`, `jira`, `review`, `commit`, `pr` | none |
| `--force` | Pre-check every menu row (reconfigure everything) instead of selecting only `not-set` rows | off |
| `--only <ids>` | Comma-separated section ids to configure non-interactively (skips the menu). Valid ids match `prepare.sections[].id`: `version`, `ship`, `jira`, `review`, `commit`, `pr`, `pr-labels`, `review-dimensions`, `pr-template`, `plan-guardrails`, `execution-guardrails`, `openspec-block` | none |
| `--dimensions` | Jump directly to review dimensions sub-flow (alias for `--only review-dimensions`) | off |
| `--pr-template` | Jump directly to PR template sub-flow (skip config builder) | off |
| `--guardrails` | Jump directly to plan guardrails sub-flow (skip config builder) | off |
| `--execution-guardrails` | Jump directly to execution guardrails sub-flow (skip config builder) | off |
| `--openspec-enrich` | Jump directly to openspec config enrichment sub-flow | off |
| `--remove-openspec` | Remove the managed block from openspec/config.yaml (with --openspec-enrich) | off |
| `--add` | Expansion mode (with --dimensions or --guardrails) | off |
| `--no-copilot` | Skip GitHub Copilot instructions (with --dimensions) | off |

---

## Plan Mode Check

If the system context contains "Plan mode is active":

1. Announce: "This skill requires write operations. Exit plan mode first, then re-invoke `/setup-sdlc`."
2. Stop. Do not proceed to subsequent steps.

---

## Workflow

### Step 0 -- Pre-flight

Run `skill/setup.js` via Bash to get current state:

> **VERBATIM** -- Run this bash block exactly as written, invoking the script with `node` and its absolute path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin; the strict script location pattern is `<PLUGIN_ROOT>/scripts/<group>/<script-name>.js`, where `<group>` is one of `skill`, `util`, `lib`, `state`, or `ci`). There is no shell wrapper — always call `node` on the `.js` file directly. Do not modify, rephrase, or simplify the commands.

```shell
PREPARE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/setup.js" $ARGUMENTS)
EXIT_CODE=$?
echo "PREPARE_OUTPUT_FILE=$PREPARE_OUTPUT_FILE"
echo "EXIT_CODE=$EXIT_CODE"
```
> **Contract (Input/Output):**
> - **Input**: None.
> - **Output**: Prints the path of a temp JSON manifest (via `writeOutput`).

Parse the JSON output from `$PREPARE_OUTPUT_FILE`. If exit code != 0, display the error and stop. Delete the manifest with `rm -f "$PREPARE_OUTPUT_FILE"` once parsed — do not leave it behind.

**Outdated CI scripts warning:** After parsing, check `prepare.scriptVersions.outdatedCount`. If `outdatedCount > 0`, print a visible warning before continuing:

```
⚠ Outdated CI pipeline scripts detected (N file(s)):
<list each file where action is 'outdated' or 'missing': "  - <file> (installed: v<installedVersion || 'missing'>, current: v<currentVersion>)">
Run `/setup-sdlc --migrate` or `/version-sdlc --init` to update.
```

Do not auto-fix. Do not block the rest of setup. This is a report-only warning (mirrors version-sdlc Step 7.5 pattern).

**Flag routing (check after pre-flight succeeds):**

Each direct-entry flag is sugar for the `--only <id>` value below. If any is passed (and `--only` is not), translate it into `--only <id>`:

| Flag | `--only` id |
|------|-------------|
| `--dimensions` | `review-dimensions` |
| `--pr-template` | `pr-template` |
| `--guardrails` | `plan-guardrails` |
| `--execution-guardrails` | `execution-guardrails` |
| `--openspec-enrich` | `openspec-block` |

If `--only <ids>` is passed (directly or via translation), skip Step 1's menu and proceed to Step 2 → Step 3 with `selectedIds = <ids>`. Pass through `--add`, `--no-copilot`, and `--remove-openspec` to the relevant sub-flow when invoked.

If none of the direct-entry flags or `--only` were passed: continue with the full interactive flow (Steps 1 → 2 → 3 → 5).

The JSON contains these top-level keys:
- `projectConfig` -- `{ exists, sections, misplaced, path }`
- `localConfig` -- `{ exists, path }`
- `legacy` -- `{ version, ship, review, reviewLegacy, jira, jiraTemplates }` each with `{ exists, path }`. `jiraTemplates.exists` is true when `.sdlc/jira-templates/` is present.
- `openspecConfig` -- `{ exists, path, managedBlockVersion }` state of `openspec/config.yaml`
- `content` -- `{ reviewDimensions: { count, path }, prTemplate: { exists, path }, jiraTemplates: { count, path } }`
- `detected` -- `{ versionFile, fileType, tagPrefix, defaultBranch }`
- `needsMigration` -- boolean flag (see Step 2 for the full condition set the skill checks before offering migration)
- `sections` -- array of section descriptors driving Steps 1 and 3 (selective menu + verbose dispatch). Each row: `{ id, label, state ('set'|'not-set'|'legacy'), summary, locked, purpose, configFile, configPath, consumedBy, filesModified, optional, delegatedTo, confirmDetected, fields[] }`. Source of truth: `scripts/lib/setup-sections.js`.

---

### Step 1 -- Selective-Section Menu

<!-- Implements R-menu-1, R-menu-4. Step 1 is plain chat output; AskUserQuestion is intentionally NOT used here. -->

**Render the status block**, using `section.label` and `section.summary` verbatim. Badge per row is driven by `section.state`: `[set]` (configured), `[not set]` (no config), `[legacy]` (needs migration; locked when `section.locked` is true):

```
SDLC Setup
---------------------------------------------------
Detected configuration:

  [set]      <id>            <summary>
  [not set]  <id>            <summary or "—">
  [legacy]   <id>            <summary>  (locked — migration required)
  ...
```

**Print the numbered menu directly to chat**, one line per row in `prepare.sections[]` order, N 1-indexed:

```
<N>. [<state>] <section.label> — <first sentence of section.purpose>
```

Locked legacy rows append ` (locked — required)` after the description. All strings MUST come from the manifest (`scripts/lib/setup-sections.js`); do NOT hardcode labels or descriptions. Example:
```
1. [set] Version — Configures how version-sdlc bumps the project version.
2. [not-set] Ship — Configures the ship-sdlc pipeline defaults.
3. [legacy] Review (locked — required) — Configures review dimensions for review-sdlc.
```

**Ask via plain chat (NOT `AskUserQuestion`).** Print the following as a literal chat message, then end the model turn so the user's next message is the answer:

```
Reply with the numbers to configure (e.g. 1,3,5 or 1-3,7), or type:
  all       — configure every section
  not-set   — configure only sections currently [not set]
  none      — exit without changes
  cancel    — exit without changes (alias for none)
Default: <prepare.menuInputContract.defaultToken>
```

**Parse the reply** against `prepare.menuInputContract` (data, not LLM heuristics):
- Empty reply → `prepare.menuInputContract.defaultToken` (`all` or `not-set`). `all` → every `prepare.sections[].id`. `not-set` → ids where `section.state === 'not-set'`. `none`/`cancel` → empty list → print `No sections selected — no changes made.` and jump to Step 4.
- Comma- or space-separated numbers, optionally `M-N` ranges → resolve each token to a row by 1-indexed position; union the results.
- **Always-include rule:** rows where `section.locked === true` are added to the resolved id list regardless of reply content (preserves R-menu-3). If the only resolved ids are locked rows and the user replied `none`, the no-changes guard does NOT fire (locked rows still enter Step 3).
- **Invalid input:** print `Invalid input: "<token>" is not a number, range, or known keyword. Try again.`, re-print the numbered list and prompt, and wait for a new reply. Maximum 3 retries; after that, exit with `No valid input after 3 attempts — no changes made.`

Store the resolved section ids as `selectedIds`. Defer migration and field collection to Step 2 / Step 3.

---

### Step 2 -- Migration

**Skip this step if:** `needsMigration` is `false` AND `--migrate` was NOT passed.

`needsMigration` is true when ANY of these conditions hold:
- A legacy config file exists (`.sdlc/version.json`, `.sdlc/ship-config.json`, `.sdlc/jira-config.json`, `.sdlc/review.json`, `.sdlc/review.json`)
- `.sdlc/config.json` contains misplaced sections (e.g. `ship` in the project config)
- `.sdlc/local.json` is v1 schema — has legacy `ship.preset` or `ship.skip` keys, or lacks the top-level `version: 2` stamp (`localIsV1` from prepare output). `readLocalConfig` never migrates on read (it is a pure read, no write) — the fix is re-running the `ship` section through Step 3 below, which fully replaces the section via `writeLocalConfig` and stamps the current schema version.
- `legacy.jiraTemplates.exists` is true (`.sdlc/jira-templates/` detected)

If legacy files exist or `projectConfig.misplaced` is non-empty, use AskUserQuestion:

> Legacy config files detected. Migrate to unified config before proceeding?

If `localIsV1` is true but no legacy files and no misplaced sections exist, use AskUserQuestion:

> Ship config at `.sdlc/local.json` uses a v1 schema (missing `version: 2`, or has legacy `preset`/`skip` keys). Migrate to v2 format?

Options:
- **yes** -- migrate now (recommended)
- **no** -- configure from scratch

On **yes**: there is no separate migration command to run, and no automatic migration happens on read — `lib/config.js::readLocalConfig` is a pure read with no write path, and `config-version.js::verifyAndMigrate` never migrates either (its own docstring: "No migrations are performed"; it always returns `migrated: false`). The actual fix is to go through the `ship` section in Step 3 below: `writeLocalConfig` does a top-level merge, so writing a fresh `ship` value there fully replaces the old `preset`/`skip` object and stamps the current `schemaVersion` in the same write. Re-run the Step 0 prepare command first to refresh state, then proceed to Step 3 and select the `ship` section:

```shell
PREPARE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/setup.js" $ARGUMENTS)
EXIT_CODE=$?
echo "PREPARE_OUTPUT_FILE=$PREPARE_OUTPUT_FILE"
echo "EXIT_CODE=$EXIT_CODE"
```
> **Contract (Input/Output):**
> - **Input**: None.
> - **Output**: Prints the path of a temp JSON manifest (via `writeOutput`), with `legacy` and `projectConfig.misplaced` refreshed.

If `prepare.legacy.jiraTemplates.exists` is true, report the `.sdlc/jira-templates/` directory as a leftover the user may delete manually — nothing migrates it automatically.

Parse the refreshed output from `$PREPARE_OUTPUT_FILE`. Delete the manifest with `rm -f "$PREPARE_OUTPUT_FILE"` once parsed — do not leave it behind. Report what was migrated:
- List each file from `migrated` array
- List each file from `conflicts` array with explanation: "Conflict: unified config already has this section -- legacy file was NOT merged"

Then use AskUserQuestion:

> Delete legacy config files?

Options:
- **yes** -- delete migrated files (keeps backup in git history)
- **no** -- keep legacy files alongside unified config

On **yes**: delete each file listed in `migrated` using Bash `rm`. Do NOT delete files listed in `conflicts`.

After migration, re-run `skill/setup.js` (same bash block as Step 0) to refresh the state before proceeding to Step 3.

On **no** (configure from scratch): proceed directly to Step 3 without migration.

---

### Step 3 -- Dispatch Loop (Verbose Per-Section Configuration)

For each id selected in Step 1 (call this list `selectedIds`), in `prepare.sections[]` order, look up the row `section = prepare.sections.find(s => s.id === id)` and:

1. **Print the verbose header** (every line below sourced from `section.*` — do NOT hardcode):

   ```
   --- Configuring: <section.label> ----------------------------------
   Purpose:        <section.purpose>

   Files modified: <section.filesModified joined with ", ">
   Consumed by:    <section.consumedBy joined with ", ">
   Config file:    <section.configFile> (path: <section.configPath || "—">)
   Current value:  <section.summary or "<none>">
   ```

   The header text comes verbatim from the manifest (`scripts/lib/setup-sections.js`). Do NOT rewrite, paraphrase, or omit any of these four lines for any selected section.

2. **Print the per-option description block** (only when `section.fields.length > 0`):

   ```
   Options:
     <field.name>  ({field.type}, default: <field.default>)
                   <field.description>
     ...
   ```

3. **Run the dispatcher for the section's `delegatedTo` value**:

   | `delegatedTo` value | Dispatcher |
   |---|---|
   | `null` | Generic field-loop (3.G below) — dispatch one AskUserQuestion per `section.fields[]` entry, optionally gated by `section.confirmDetected`. The `workspace` section uses this dispatcher but overrides `layout`-field rendering per `@resources/setup-workspace.md` (read and follow it in full for that section). |
   | `'inline-commit-builder'` | Commit-pattern builder — read and follow `@resources/setup-patterns.md` ("Commit-pattern builder" section), gated by the verbose header above |
   | `'inline-pr-builder'` | PR-pattern builder — read and follow `@resources/setup-patterns.md` ("PR-pattern builder" section) |
   | `'setup-dimensions'` | Run scan phase (Step 3.S below), then read and follow `@resources/setup-dimensions.md` passing scan results as "Scan Input". Pass through `--add` and `--no-copilot` modifiers if present. |
   | `'setup-pr-template'` | Run scan phase (Step 3.S), then read and follow `@resources/setup-pr-template.md` passing scan results. Pass through `--add` if present. |
   | `'setup-pr-labels'` | Read and follow `@resources/setup-pr-labels.md` (it runs `gh label list` itself; no scan input from parent required). |
   | `'setup-guardrails'` | Read and follow `@resources/setup-guardrails.md` (it runs its own scan internally). Pass through `--add` if present. |
   | `'setup-execution-guardrails'` | Read and follow `@resources/setup-execution-guardrails.md`. Pass through `--add` if present. |
   | `'setup-openspec'` | Read and follow `@resources/setup-openspec.md`. Pass through `--remove-openspec` as `--remove` if present. |

After the loop, write any pending project-config and local-config slices via the "Writing config files" sub-section at the end of Step 3.

#### 3.G. Generic field loop (delegatedTo === null)

For sections with `delegatedTo: null` (`version`, `ship`, `jira`, `review`):

If `section.confirmDetected === true` (currently only `version`), dispatch a meta-prompt FIRST using AskUserQuestion:

> Use detected settings, customize each field, or skip this section?

Options: `yes` (write detected values directly), `customize` (iterate `section.fields`), `skip` (write nothing for this section).

- On **yes**: Build the section value from `prepare.detected.*` (e.g., for `version`: `{ mode: 'file', versionFile, fileType, tagPrefix }`; if `prepare.detected.versionFile` is null, use `{ mode: 'tag', tagPrefix }`). Do NOT write `preRelease` on the yes path — the yes path uses detected values only, none of which include `preRelease`. The version compat check (below) does not apply on the yes path since no `preRelease` is collected here.
- On **customize**: continue to the field iteration below.
- On **skip**: stop processing this section; do not write anything.

For each entry `field` in `section.fields` (when iterating), dispatch one AskUserQuestion:

- **Skip gate (prepare-sourced):** If `field.skip === true` (set by the prepare script when a `when.stepInActiveSteps` gate is unsatisfied — see P7), skip this field entirely. Do NOT ask the user anything; do NOT write any value for this field. Move to the next entry.
- **Question prompt:** `field.label`
- **Helper text:** `field.description` (verbatim from manifest)
- **Choices:** `field.options` (or free-text input when `options` is `null`)
- **Default:** `field.default`
- **Validation:** if `field.validate` is defined, re-prompt on failure showing the regex/constraint inline

Skip a field when an upstream answer makes it irrelevant: for `version`, skip `versionFile` and `fileType` if `mode === 'tag'`; skip `changelogFile` if `changelog === false`; omit `preRelease` from the written config when the user enters an empty string.

<!-- Implements R-version-prerelease-compat, G4. -->
**Version pre-release compatibility check:**
After all version section fields are collected and BEFORE storing the section object:

1. If `mode === 'tag'` or `preRelease` is empty/omitted → skip this check (no preRelease to validate).
2. Let `compat = prepare.preReleaseCompat[<chosen-fileType>]`.
3. Branch on `compat.level`:
   - `compatible` → store the section as-is; no prompt.
   - `partial` or `unknown` → print `compat.message`, then use AskUserQuestion (single-select): "Proceed with `preRelease: <value>` for `<fileType>`?" → options `yes` (store as-is), `no` (omit `preRelease` from the stored section).
   - `incompatible` → print `compat.message`, then use AskUserQuestion (single-select): "Pre-release labels are not supported for `<fileType>`. Clear `preRelease`, or proceed anyway?" → options `clear` (omit `preRelease` from the stored section), `proceed` (store as-is, accepting risk).
4. The check runs once per version-section dispatch; it does NOT re-trigger if the same compat verdict was already resolved within a single uninterrupted execution of Step 3 (state-machine idempotency: a single run never asks the same question twice for the same `(fileType, preRelease)` pair).

**Answer mapping when assembling the section object:**
- `enum` fields → write the selected option string verbatim
- `multi-select` fields → write the array of selected options
- `boolean` fields → map `yes` → `true`, `no` → `false` (exception: `rebase` writes `auto`/`skip`/`prompt` verbatim — do NOT translate to yes/no)
- `string` fields → write the entered string; omit when empty (and the field is optional)
- `number` fields → coerce the answer to a JavaScript integer (use `parseInt`); validate against `field.min` (when present, value must be ≥ min) and `field.max` (when present, value must be ≤ max); re-prompt on invalid input, citing the violated bound in the error message
- `list` fields → accept comma-separated input; split on `,` and trim each element to produce a string array; write the resulting array

You MUST issue exactly one AskUserQuestion per `section.fields[]` entry that survives the gating above. Do not batch, reorder, or hand-enumerate fields — the manifest owns the list.

#### 3.commit / 3.pr. Inline commit- and PR-pattern builders

`commit` (`delegatedTo: 'inline-commit-builder'`) and `pr` (`delegatedTo:
'inline-pr-builder'`) both need a sequential-question regex builder. The
verbose header from Step 3 has already been printed. Read and follow
`@resources/setup-patterns.md` in full — it covers both sections (the `pr`
builder's `same-as-commit` option depends on the `commit` section having run
first in `prepare.sections[]` order). Store each assembled section object for
the "Writing config files" step below.

#### 3.workspace. Workspace worktree wizard (workspace section in 3.G)

<!-- Fixes #351. -->

The `workspace` section uses the generic 3.G field-loop dispatcher but the
`layout` field needs a numbered menu with live previews and a mismatch
warning before its AskUserQuestion fires. Read and follow
`@resources/setup-workspace.md` in full for this section's rendering,
per-layout follow-up fields, and write target (`.sdlc/local.json`, gitignored,
per-developer — never `.sdlc/config.json`).

#### 3.hooks. Hook guard configuration (hooks section in 3.G)

Generic 3.G dispatcher; one field: **`agentIsolationGuard.enabled`** (boolean,
default `true`) — "Block Agent SDK `isolation: "worktree"` parameter?
(Recommended: yes — prevents wrong-worktree commits)". On **yes** (default):
omit the key, or write `{"hooks":{"agentIsolationGuard":{"enabled":true}}}`.
On **no**: write `{"hooks":{"agentIsolationGuard":{"enabled":false}}}`. Lands
in `.sdlc/local.json` (gitignored, per-developer) — never in `.sdlc/config.json`.

#### 3.S. Scan phase (delegated content sections only)

Before invoking `setup-dimensions` or `setup-pr-template`, run the project signal scan:

> **Shell safety:** Use the **Glob** tool for all file/directory existence checks.
> Do NOT use Bash `ls` with glob patterns — zsh (macOS default) errors on unmatched globs.
> Use Bash only for `git` commands, `gh` CLI, and `which`.

- **Dependency manifests:** Glob `package.json`, `requirements.txt`, `Pipfile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`; read each found file.
- **Framework config:** Glob `**/jest.config.*`, `**/vitest.config.*`, `**/.eslintrc*`, `**/tsconfig.json`, `**/openapi.yaml`, `**/openapi.json`, `**/.prettierrc*`.
- **Directory structure:** Glob `src/`, `lib/`, `controllers/`, `services/`, `middleware/`, `models/`, `routes/`, `api/`, `pkg/`, `cmd/`, `internal/`, plus patterns from `@resources/scan-patterns.md`.
- **CI/CD config:** Glob `.github/workflows/*.yml`, `Jenkinsfile`, `.circleci/config.yml`, `.gitlab-ci.yml`.
- **Database presence:** Glob `prisma/`, `migrations/`, `alembic.ini`, `db/migrate/`, `**/sequelize*`, `**/typeorm*`, `**/sqlalchemy*`.
- **Test structure:** Glob `test/`, `tests/`, `spec/`, `__tests__/`, `cypress/`, `**/playwright.config.*`.
- **Existing content:** Glob `.sdlc/review-dimensions/*` (dimensions); `.github/PULL_REQUEST_TEMPLATE.md`, `.github/pull_request_template.md`, and `.sdlc/pr-template.md` (PR template); Read `.sdlc/config.json` → `plan.guardrails` if present.
- **AGENTS.md:** Read `AGENTS.md` and `.sdlc/AGENTS.md` if present.
- **GitHub hosting & PR history:** Bash `git remote -v`, `gh repo view`, `gh pr list --limit 5 --json title,body`; Glob `.github/`.
- **JIRA evidence:** Bash `git log --oneline -20`, `git rev-parse --abbrev-ref HEAD`.

Collect all signals into a "Scan Input" object to pass to the sub-flow. Run the scan once per setup invocation; cache the result for any subsequent delegated section in the same selectedIds list.

#### Diff preview

Before invoking `util/setup-init.js`, render an end-of-run diff preview comparing the in-memory snapshot of the project config as read at preflight (Step 0 prepare output) against the accumulated answers from Step 3's dispatch loop. Use `lib/config.js::computeConfigDiff(before, after)` — pure helper, no I/O:

```shell
node "<PLUGIN_ROOT>/scripts/util/setup-diff-write-config.js" --before '<BEFORE_JSON>' --after '<AFTER_JSON>'
```
> **Contract (Input/Output):**
> - **Input**: Config changes.
> - **Output**: Applies updates to `.sdlc/config.json`.

Render `DIFF_JSON.changed[]` as a markdown table:

```text
| path                      | before        | after         |
|---------------------------|---------------|---------------|
| pr.expectedAccount        | (unset)       | dnichyparuk   |
| version.tagPrefix         | v             | release/      |
```

When `DIFF_JSON.changed.length === 0`, skip the preview and print `No changes — nothing to write.`; bypass the write step (`util/setup-init.js` invocation) and proceed directly to Step 3b validation (which is now a no-op confirmation).

Otherwise, ask the user to confirm the diff via AskUserQuestion (suppressed when `--auto` is set; auto mode proceeds to write). On rejection, print `Write cancelled — no changes made.` and skip the write step.

#### Writing config files

After collecting all answers AND confirming the diff preview above, write project config and local config via `util/setup-init.js`:

```shell
SETUP_INIT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/setup-init.js" --output-file --project-config '<PROJECT_CONFIG_JSON>' --local-config '<LOCAL_CONFIG_JSON>')
```
> **Contract (Input/Output):**
> - **Input**: Configuration parameters.
> - **Output**: Bootstraps the `.sdlc` directory structure.

Replace `<PROJECT_CONFIG_JSON>` and `<LOCAL_CONFIG_JSON>` with the actual config objects assembled during Step 3's dispatch loop. Only include sections that were configured (not skipped).

The command prints the manifest path on stdout; read `$SETUP_INIT_FILE` and parse the JSON. Delete the manifest with `rm -f "$SETUP_INIT_FILE"` once parsed — do not leave it behind.

Display created files, check for errors. The `setup-init.js` script deterministically creates `.sdlc/` directory, `.sdlc/.gitignore`, writes config files via `writeProjectConfig` and `writeLocalConfig` (read-merge-write, so existing sections are preserved), and ensures a managed `.gitignore` block exists in the project root listing transient skill artifact patterns (`*-context-*.json`, `*-manifest-*.json`, `*-prepare-*.json`). The managed block is delimited by sentinel comments (`# >>> lift-sdlc managed`/`# <<< lift-sdlc managed`) and is idempotent — re-running setup-sdlc replaces the block contents in place rather than duplicating. Existing user content in `.gitignore` is preserved.

### Step 3b -- Validate Written Config

Re-run `skill/setup.js` to verify the config files were written correctly:

```bash
VALIDATE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/setup.js")
```

`skill/setup.js` always writes its JSON payload to a temp file via `writeOutput()` and prints only the manifest path on stdout — read `$VALIDATE_OUTPUT_FILE` and parse its JSON (do not redirect stdout into a file; that would capture the path, not the payload). Confirm:
- `projectConfig.exists` is `true` and `projectConfig.sections` includes the sections just written
- `localConfig.exists` is `true` (if review scope was configured)

If validation fails (sections missing or file unreadable), warn the user and offer to retry the config write. Do not proceed to content setup with invalid config.

---

### Step 4 -- Summary

Show what was created or updated:

```
Setup complete
---------------------------------------------------
Created/updated:
  .sdlc/config.json      -- project config (version, jira)
  .sdlc/local.json        -- local config (review, ship)

Content:
  Review dimensions       -- [installed via dimensions sub-flow | skipped]
  PR template             -- [installed via PR template sub-flow | skipped]
  Plan guardrails         -- [N configured via guardrails sub-flow | skipped]

Migrated:
  .sdlc/version.json    -- merged into .sdlc/config.json [deleted | kept]
  ...
```

Only show sections that were actually created, updated, or migrated. Omit sections that were skipped or unchanged.

---

## Idempotency

This skill is safe to re-run. Already-configured sections are skipped unless `--force` is passed. The `writeProjectConfig` and `writeLocalConfig` functions use read-merge-write -- each call merges the provided config into the existing file content rather than overwriting it, so re-running does not clobber sections written by other skills and it is safe to write one section at a time.

---

## DO NOT

- Run full-suite or wide-subset `promptfoo eval` automatically — single targeted test scoped to the change is allowed; tight-loop retries are not.
- Delete legacy files without explicit user confirmation via AskUserQuestion
- Invoke removed skills (`/review-init-sdlc`, `/pr-customize-sdlc`, `/guardrails-init-sdlc`) -- they no longer exist as standalone skills; use the sub-flows (`@resources/setup-dimensions.md`, `@resources/setup-pr-template.md`, `@resources/setup-guardrails.md`) instead
- Modify Jira templates directly -- delegate to `/jira-sdlc` via the Skill tool
- Write config files using the Write or Edit tools directly -- always go through `lib/config.js` functions (`writeProjectConfig`, `writeLocalConfig`) via inline Node.js in Bash
- Invoke sub-skills via the Agent tool -- use the Skill tool exclusively
- Skip AskUserQuestion for any user interaction -- do not print questions and wait for freeform input
- Assume `mode` for the version section without asking or detecting it -- it is a required field enforced by the JSON schema; default to `mode: "file"` when `detected.versionFile` is present, otherwise `mode: "tag"`, and always include `mode` in the written config

---

## Gotchas

**skill/setup.js must run from the project root.** It uses `process.cwd()` to locate config files. If the working directory is wrong, detection will silently return empty results.

**Ship config is developer-local.** Ship preferences live in `.sdlc/local.json` (gitignored), not in `.sdlc/config.json`. Each developer has their own ship preferences.

**Legacy review config has two possible locations.** `.sdlc/review.json` and `.sdlc/review.json` are both legacy paths. `migrateConfig()` prefers `.sdlc/review.json` when both exist.

---

## Learning Capture

After completing setup or encountering unexpected behavior, append to `.sdlc/learnings/log.md`:

```
## YYYY-MM-DD -- setup-sdlc: <brief summary>
<what happened, what was learned>
```

Record entries for: projects with unusual version file locations, migration edge cases, legacy file conflicts, or user preferences that differ from defaults.

---

## See Also

- [`/version-sdlc`](../version-sdlc/SKILL.md) -- version bumps and release tags
- [`/ship-sdlc`](../ship-sdlc/SKILL.md) -- end-to-end feature shipping pipeline
- [`/review-sdlc`](../review-sdlc/SKILL.md) -- multi-dimension code review
- [`/jira-sdlc`](../jira-sdlc/SKILL.md) -- Jira integration
