---
name: setup-sdlc
description: "Use this skill when setting up the SDLC plugin for a project, initializing configuration, or when any skill reports missing config. Renders a selective-section menu so users choose which sections to configure; each selected section prints a verbose header (purpose, files-modified, consuming skills, per-option description) before any prompt. Supports direct sub-flow entry via --only, --dimensions, --pr-template, --guardrails, --execution-guardrails, --openspec-enrich. Arguments: [--migrate] [--skip <section>] [--force] [--only <ids>] [--dimensions] [--pr-template] [--guardrails] [--execution-guardrails] [--openspec-enrich] [--remove-openspec] [--add] [--no-copilot]"
user-invocable: true
argument-hint: "[--migrate] [--skip <section>] [--force] [--only <ids>] [--dimensions] [--pr-template] [--guardrails] [--execution-guardrails] [--openspec-enrich] [--remove-openspec] [--add] [--no-copilot]"
model: gemini-3.5-flash-medium
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

> **VERBATIM** -- Run this bash block exactly as written. Do not modify, rephrase, or simplify the commands.

```shell
<PLUGIN_ROOT>/skills/setup-sdlc/scripts/prepare.sh
```
> **Contract (Input/Output):**
> - **Input**: None.
> - **Output**: Prints JSON manifest of current SDLC configuration state.

Parse the JSON output from `$PREPARE_OUTPUT_FILE`. If exit code != 0, display the error and stop.

**Outdated CI scripts warning (R-SCRIPT-VERSIONS, #424):** After parsing, check `prepare.scriptVersions.outdatedCount`. If `outdatedCount > 0`, print a visible warning before continuing:

```
⚠ Outdated CI pipeline scripts detected (N file(s)):
<list each file where action is 'outdated' or 'missing': "  - <file> (installed: v<installedVersion || 'missing'>, current: v<currentVersion>)">
Run `/setup-sdlc --migrate` or `/version-sdlc --init` to update.
```

Do not auto-fix. Do not block the rest of setup. This is a report-only warning (mirrors version-sdlc Step 7.5 pattern).

**Flag routing (check after pre-flight succeeds):**

The legacy direct-entry flags map onto `--only` (which now drives Step 3 directly):

| Flag passed | Equivalent `--only <id>` |
|---|---|
| `--dimensions` | `--only review-dimensions` |
| `--pr-template` | `--only pr-template` |
| `--guardrails` | `--only plan-guardrails` |
| `--execution-guardrails` | `--only execution-guardrails` |
| `--openspec-enrich` | `--only openspec-block` |

If any of those flags is passed (and `--only` is not), translate it into `--only <id>`. If `--only <ids>` is passed (directly or via translation), skip Step 1's menu and proceed to Step 2 → Step 3 with `selectedIds = <ids>`. Pass through `--add`, `--no-copilot`, and `--remove-openspec` to the relevant sub-flow when invoked.

If none of the direct-entry flags or `--only` were passed: continue with the full interactive flow (Steps 1 → 2 → 3 → 5).

The JSON contains these top-level keys:
- `projectConfig` -- `{ exists, sections, misplaced, path }`
- `localConfig` -- `{ exists, path }`
- `legacy` -- `{ version, ship, review, reviewLegacy, jira, jiraTemplates }` each with `{ exists, path }`. `jiraTemplates.exists` is true when `.sdlc/jira-templates/` is present (R-LEGACY-DETECT, #423).
- `openspecConfig` -- `{ exists, path, managedBlockVersion }` state of `openspec/config.yaml`
- `content` -- `{ reviewDimensions: { count, path }, prTemplate: { exists, path }, jiraTemplates: { count, path } }`
- `detected` -- `{ versionFile, fileType, tagPrefix, defaultBranch }`
- `needsMigration` -- boolean: `true` when any legacy file exists OR any misplaced section found in project config
- `sections` -- array of section descriptors driving Steps 1 and 3 (selective menu + verbose dispatch). Each row: `{ id, label, state ('set'|'not-set'|'legacy'), summary, locked, purpose, configFile, configPath, consumedBy, filesModified, optional, delegatedTo, confirmDetected, fields[] }`. Source of truth: `scripts/lib/setup-sections.js`.

---

### Step 1 -- Selective-Section Menu

<!-- Implements R-menu-1, R-menu-4. Fixes #337. Step 1 is plain chat output; AskUserQuestion is intentionally NOT used here. -->

**Direct-entry flag bypass (preserved):** When `--only`, `--force`, `--dimensions`, `--pr-template`, `--guardrails`, `--execution-guardrails`, or `--openspec-enrich` was passed, `selectedIds` are resolved before Step 1 by the flag-alias routing table in Step 0. Skip the entire menu (no numbered list, no chat prompt) and jump to Step 2/3 with the resolved id set.

**Phase 1 — Render the status block.** Print the status block as before, using `section.label` and `section.summary` verbatim:

**State badge per row** (driven by `section.state`):
- `[set]` — section is already configured.
- `[not set]` — section has no config.
- `[legacy]` — section needs migration; locked when `section.locked` is true.

**Layout:**

```
SDLC Setup
---------------------------------------------------
Detected configuration:

  [set]      <id>            <summary>
  [not set]  <id>            <summary or "—">
  [legacy]   <id>            <summary>  (locked — migration required)
  ...
```

**Phase 2 — Print the numbered menu directly to chat.** One line per row in `prepare.sections[]` order, format:

```
<N>. [<state>] <section.label> — <first sentence of section.purpose>
```

- N is 1-indexed, assigned in array order.
- `<state>` mirrors the badge: `set` | `not-set` | `legacy`.
- Locked legacy rows append ` (locked — required)` after the description.
- All strings MUST come from the manifest (`scripts/lib/setup-sections.js`); do NOT hardcode labels or descriptions.

Example rendering:
```
1. [set] Version — Configures how version-sdlc bumps the project version.
2. [not-set] Ship — Configures the ship-sdlc pipeline defaults.
3. [legacy] Review (locked — required) — Configures review dimensions for review-sdlc.
```

**Phase 3 — Ask via plain chat (NOT `AskUserQuestion`).** Print the following prompt as a literal chat message, then end the model turn so the user's next message is the answer:

```
Reply with the numbers to configure (e.g. 1,3,5 or 1-3,7), or type:
  all       — configure every section
  not-set   — configure only sections currently [not set]
  none      — exit without changes
  cancel    — exit without changes (alias for none)
Default: <prepare.menuInputContract.defaultToken>
```

Do NOT wrap this in `AskUserQuestion`. It is a literal chat output followed by a turn boundary.

**Phase 4 — Parse the reply** against `prepare.menuInputContract` (data, not LLM heuristics):
- Empty reply → use `prepare.menuInputContract.defaultToken` (`all` or `not-set`).
- `all` → every `prepare.sections[].id`.
- `not-set` → ids where `section.state === 'not-set'`.
- `none` or `cancel` → empty list → print `No sections selected — no changes made.` and jump to Step 4.
- Comma- or space-separated numbers, optionally including `M-N` ranges → resolve each token to a row by 1-indexed position; union the results.
- **Always-include rule:** rows where `section.locked === true` are added to the resolved id list regardless of reply content (preserves R-menu-3). If the only resolved ids are locked rows and the user replied `none`, the no-changes guard does NOT fire (locked rows still enter Step 3).
- **Invalid input:** if any token is unknown or out of range, print one line: `Invalid input: "<token>" is not a number, range, or known keyword. Try again.` Then re-print the numbered list and the prompt; wait for a new reply. Maximum 3 retries; after that, exit with `No valid input after 3 attempts — no changes made.` and a one-line note.

Store the resolved section ids as `selectedIds`. Defer migration and field collection to Step 2 / Step 3.

---

### Step 2 -- Migration

**Skip this step if:** `needsMigration` is `false` AND `--migrate` was NOT passed.

`needsMigration` is true when ANY of these conditions hold:
- A legacy config file exists (`.sdlc/version.json`, `.sdlc/ship-config.json`, `.sdlc/jira-config.json`, `.sdlc/review.json`, `.sdlc/review.json`)
- `.sdlc/config.json` contains misplaced sections (e.g. `ship` in the project config)
- `.sdlc/local.json` is v1 schema — has legacy `ship.preset` or `ship.skip` keys, or lacks the top-level `version: 2` stamp (`localIsV1` from prepare output). Auto-migrated by `lib/config.js::readLocalConfig` on next read; `--migrate` triggers it explicitly with a banner.
- `legacy.jiraTemplates.exists` is true (`.sdlc/jira-templates/` detected — implements R-LEGACY-DETECT, #423)

If legacy files exist or `projectConfig.misplaced` is non-empty, use AskUserQuestion:

> Legacy config files detected. Migrate to unified config before proceeding?

If `localIsV1` is true but no legacy files and no misplaced sections exist, use AskUserQuestion:

> Ship config at `.sdlc/local.json` uses a v1 schema (missing `version: 2`, or has legacy `preset`/`skip` keys). Migrate to v2 format?

Options:
- **yes** -- migrate now (recommended)
- **no** -- configure from scratch

On **yes**: Run migration via inline Node.js that calls `migrateConfig()` from `lib/config.js`:

```shell
<PLUGIN_ROOT>/skills/setup-sdlc/scripts/migrate_config.sh
```
> **Contract (Input/Output):**
> - **Input**: Legacy config context.
> - **Output**: Migrates config to latest version.

Then dispatch the jira-templates migration shim if `prepare.legacy.jiraTemplates.exists` is true (R-LEGACY-DETECT, #423):

```shell
<PLUGIN_ROOT>/skills/setup-sdlc/scripts/migrate_jira.sh
```
> **Contract (Input/Output):**
> - **Input**: Legacy Jira context.
> - **Output**: Migrates Jira caching configuration.

Parse the output. Report what was migrated:
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
   | `null` | Generic field-loop (3.G below) — dispatch one AskUserQuestion per `section.fields[]` entry, optionally gated by `section.confirmDetected`. The `workspace` section uses this dispatcher with field-specific augmentations described in 3.workspace below (R24). |
   | `'inline-commit-builder'` | Inline commit-pattern builder (3.commit below) — same conditional logic as legacy Step 3e, gated by the verbose header above |
   | `'inline-pr-builder'` | Inline PR-pattern builder (3.pr below) — same conditional logic as legacy Step 3f |
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

<!-- Implements R-version-prerelease-compat, G4. Fixes #338. -->
**Version pre-release compatibility check:**
After all version section fields are collected and BEFORE storing the section object:

1. If `mode === 'tag'` or `preRelease` is empty/omitted → skip this check (no preRelease to validate).
2. Let `compat = prepare.preReleaseCompat[<chosen-fileType>]`.
3. Branch on `compat.level`:
   - `compatible` → store the section as-is; no prompt.
   - `partial` or `unknown` → print `compat.message`, then use AskUserQuestion (single-select): "Proceed with `preRelease: <value>` for `<fileType>`?" → options `yes` (store as-is), `no` (omit `preRelease` from the stored section).
   - `incompatible` → print `compat.message`, then use AskUserQuestion (single-select): "Pre-release labels are not supported for `<fileType>`. Clear `preRelease`, or proceed anyway?" → options `clear` (omit `preRelease` from the stored section), `proceed` (store as-is, accepting risk).
4. The check runs once per version-section dispatch; it does NOT re-trigger if the same compat verdict was already resolved within a single uninterrupted execution of Step 3 (state-machine idempotency: a single run never asks the same question twice for the same `(fileType, preRelease)` pair).

This check applies only to the `version` section and only when `mode === 'file'` (the `fileType` field is known). When `mode === 'tag'`, no `fileType` is configured so the check is skipped.

**Answer mapping when assembling the section object:**
- `enum` fields → write the selected option string verbatim
- `multi-select` fields → write the array of selected options
- `boolean` fields → map `yes` → `true`, `no` → `false` (exception: `rebase` writes `auto`/`skip`/`prompt` verbatim — do NOT translate to yes/no)
- `string` fields → write the entered string; omit when empty (and the field is optional)
- `number` fields → coerce the answer to a JavaScript integer (use `parseInt`); validate against `field.min` (when present, value must be ≥ min) and `field.max` (when present, value must be ≤ max); re-prompt on invalid input, citing the violated bound in the error message
- `list` fields → accept comma-separated input; split on `,` and trim each element to produce a string array; write the resulting array

You MUST issue exactly one AskUserQuestion per `section.fields[]` entry that survives the gating above. Do not batch, reorder, or hand-enumerate fields — the manifest owns the list.

After the field loop, store the assembled section object keyed by id; the "Writing config files" step will persist it.

#### 3.commit. Inline commit-pattern builder (delegatedTo === 'inline-commit-builder')

The verbose header from Step 3 (purpose / files-modified / consumed-by / config-file / current-value) has already been printed. Then run the existing conditional builder:

Use AskUserQuestion:

> Do you enforce commit message patterns in this project?

Options:
- **conventional** -- Conventional commits: `type(scope): description`
- **ticket-prefix** -- Ticket prefix: `PROJ-123: description`
- **custom** -- Enter your own regex pattern
- **skip** -- Don't configure commit patterns

On **conventional**: Use AskUserQuestion for sequential refinement:

1. "Require scope?" -- yes / no → Determines `subjectPattern`:
   - yes: `^(feat|fix|refactor|chore|docs|test|ci)(\\(.*\\)): .+$`
   - no: `^(feat|fix|refactor|chore|docs|test|ci)(\\(.*\\))?: .+$`

2. "Allowed types?" -- multi-select (feat, fix, refactor, chore, docs, test, ci; all selected by default) → Updates regex `(type1|type2|...)`

3. "Allowed scopes?" -- free text comma-separated or skip → Adds scope constraint if provided:
   - If scopes provided: `^(types)(\\((scope1|scope2)\\)): .+$`
   - If skip: use pattern without scope constraint

4. "Require body for which types?" -- multi-select (feat, fix, or skip) → Sets `requiresBody` array

5. "Required trailers?" -- free text comma-separated (e.g., `Ticket`, `Reviewed-By`) or skip → Sets `trailers` array

Assemble the `commit` section object. Only include optional fields if the user provided values; omit empty arrays.

On **ticket-prefix**: Use AskUserQuestion for sequential refinement:

1. "Ticket pattern?" -- free text regex (default: `[A-Z]{2,10}-\\d+` for `PROJ-123`) → Sets `ticketPattern`
2. "Combine with conventional type?" -- yes / no:
   - yes: `subjectPattern` becomes `^PROJ-\\d+ (feat|fix|...)(\\(.*\\))?: .+$`
   - no: `subjectPattern` becomes `^PROJ-\\d+: .+$`
3. If combined with types, ask the same type/scope/body/trailer refinement questions as **conventional**.

On **custom**: Use AskUserQuestion:

1. "Enter your regex pattern for commit subject:" → free text → `subjectPattern`
2. "Enter error message if pattern doesn't match:" → free text → `subjectPatternError`

On **skip**: Do not write a commit section.

Store the assembled `commit` config for use in the "Writing config files" step.

#### 3.pr. Inline PR-pattern builder (delegatedTo === 'inline-pr-builder')

Verbose header from Step 3 already printed. Then:

Use AskUserQuestion:

> Do you enforce PR title patterns?

Options:
- **same-as-commit** -- Use the same pattern as commit (only when 3.commit produced a config)
- **conventional** -- Conventional format
- **ticket-prefix** -- Ticket prefix format
- **custom** -- Enter your own regex
- **skip** -- Don't configure PR title patterns

On **same-as-commit** (if available): Copy the commit config fields to PR config with renamed fields: `subjectPattern` → `titlePattern`, `subjectPatternError` → `titlePatternError`. Keep `allowedTypes`, `allowedScopes`, `requiresBody`, `trailers` as-is.

On **conventional**: Use sequential AskUserQuestion:

1. "Allowed types?" -- multi-select (feat, fix, refactor, chore, docs, test, ci; all selected by default)
2. "Require scope?" -- yes / no
3. "Allowed scopes?" -- free text comma-separated or skip
4. "Required trailers?" -- free text comma-separated or skip

On **ticket-prefix**: Ask same questions as commit (ticket pattern, combine with types, etc.).

On **custom**: Ask:

1. "Enter your regex pattern for PR title:" → free text → `titlePattern`
2. "Enter error message if pattern doesn't match:" → free text → `titlePatternError`

On **skip**: Do not write a pr section.

Store the assembled `pr` config for use in the "Writing config files" step.

#### 3.workspace. Workspace worktree wizard (workspace section in 3.G)

<!-- Implements R24. Fixes #351. -->

The `workspace` section uses the generic 3.G field-loop dispatcher
(`delegatedTo: null`, fields from `scripts/lib/workspace-fields.js::WORKSPACE_FIELDS`),
but the layout field requires a numbered menu with live previews and a
mismatch warning before the AskUserQuestion fires. The augmentations below
override the default 3.G rendering for this section only.

**Pre-computed context.** The workspace section row carries a `context` object
populated by the prepare script (`scripts/skill/setup.js` → `scripts/lib/workspace-context.js`).
It is the single source of truth for menu rendering; do not recompute previews
or mismatches from the SKILL.

- `previews.inside`, `previews.sibling`, `previews.central` — sample resolved paths
  using a sentinel branch (`example-feature`) for each deterministic layout.
- `antigravityIgnored` — boolean; whether the project root `.gitignore` already lists `.sdlc/`.
- `mismatchesByLayout.{inside|sibling|central}` — list of existing worktree paths
  under `git worktree list` that do NOT match the layout being considered. Non-empty
  values mean picking that layout would leave the listed worktrees orphaned (still
  usable, but outside the configured location).
- `existingWorktrees` — full output of `listExistingWorktrees()` for diagnostics.

**Layout field rendering — overrides default 3.G behavior.**

1. **Numbered layout menu, printed as plain chat output (NOT `AskUserQuestion`)
   before the question.** Use the help text returned by
   `workspace-fields.js::layoutField.help({ repoRoot, repoName, home, antigravityIgnored })`
   — it already renders previews 1–3 with their resolved paths and emits the
   `.sdlc/` gitignore note based on `context.antigravityIgnored`. Append a fourth row
   for `template` with the static description from the field's `options[3]`.

   Example shape (the script supplies the exact strings):

   ```
   Where should sdlc create git worktrees?
     1. inside    <preview.inside>
     2. sibling   <preview.sibling>
     3. central   <preview.central>
     4. template  Custom path with placeholders (advanced)
   ```

2. **Then dispatch the AskUserQuestion for the `layout` field** as in 3.G —
   `field.label`, helper text from `field.description`, options
   `inside | sibling | central | template`, default `inside`. Validate via
   `field.validate(answer)` and re-prompt on failure.

3. **Mismatch warning (R24) — runs after the layout answer arrives, before any
   follow-up field is prompted.** When the chosen layout L is one of
   `inside | sibling | central` AND `context.mismatchesByLayout[L]` is non-empty,
   print one warning line per existing worktree path so the user knows the new
   layout will not relocate them:

   ```
   warning: existing worktree at <path> does not match selected layout=<L>.
   It will remain where it is; only future worktrees will use the new layout.
   ```

   Do NOT block — the wizard always proceeds. The warning is informational. The
   check is skipped for `template` layout (custom paths are user-defined and
   cannot be classified deterministically).

**Conditional follow-up fields per layout.** After the layout answer (and any
mismatch warning), iterate `WORKSPACE_FIELDS` in array order and dispatch one
AskUserQuestion per field that is relevant for the chosen layout. Fields use
the field's `description` from `workspace-fields.js` as helper text (verbatim —
do not paraphrase). When a field defines `validate(value, layout, repoContext)`,
re-prompt on failure with the exception message inline.

| Layout | Follow-up fields prompted | Notes |
|---|---|---|
| `inside` | `base` (optional), `ensureGitignore` (boolean, default `true`), `nameTemplate` (optional) | `ensureGitignore=true` enables the SessionStart hook to auto-add `.sdlc/worktrees/` to root `.gitignore`. |
| `sibling` | `base` (optional), `nameTemplate` (optional) | Path resolves alongside the repo dir. |
| `central` | `base` (optional), `nameTemplate` (optional) | Default places under `~/.sdlc/worktrees/<repoName>/`. |
| `template` | `template` (required — must contain `{slug}` or `{branch}`), `nameTemplate` (optional) | Skip `base` and `ensureGitignore`. |

Skip a follow-up field entirely (do NOT prompt) when the chosen layout makes it
irrelevant (e.g., `template` field for non-`template` layouts; `ensureGitignore`
for non-`inside` layouts).

**Live preview for `template`.** When the user enters a `template` value, call
`templateField.preview(value, repoContext)` to render the resolved path using
the sentinel branch. Print the preview line so the user can confirm before
moving to the next field:

```
Template: <user-input>
Preview with sentinel branch `example-feature`:
  <resolved-path>
```

If the preview throws (template missing required placeholders, `..` traversal,
etc.), surface the exception message and re-prompt for the template field.

**Writing the section to `.sdlc/local.json`.** Assemble the section object,
omitting any field the user left blank — `lib/config.js::writeLocalConfig` does
read-merge-write so unspecified fields are preserved:

```json
{ "workspace": { "worktree": { "layout": "<L>", ...optional fields the user set } } }
```

Store the assembled object under the `workspace` key for the "Writing config files"
step. The config lands in `.sdlc/local.json` (gitignored, per-developer) — never in
`.sdlc/config.json`.

#### 3.hooks. Hook guard configuration (hooks section in 3.G)

<!-- Implements R25. Fixes #370, #372. -->

The `hooks` section uses the generic 3.G field-loop dispatcher (`delegatedTo: null`,
`fields` from `lib/setup-sections.js`). One field is surfaced:

**`agentIsolationGuard.enabled`** (boolean, default `true`):
> Block Agent SDK `isolation: "worktree"` parameter? (Recommended: yes — prevents wrong-worktree commits per #370 #372)

Use `AskUserQuestion` with options **yes** (default) / **no**:

- On **yes** (default): omit the key from `.sdlc/local.json` (default behavior, KISS) — OR write `{"hooks":{"agentIsolationGuard":{"enabled":true}}}` if an explicit value is preferred.
- On **no**: write `{"hooks":{"agentIsolationGuard":{"enabled":false}}}` to `.sdlc/local.json`.

The config lands in `.sdlc/local.json` (gitignored, per-developer) — never in `.sdlc/config.json`.

#### 3.S. Scan phase (delegated content sections only)

Before invoking `setup-dimensions` or `setup-pr-template`, run the project signal scan:

> **Shell safety:** Use the **Glob** tool for all file/directory existence checks.
> Do NOT use Bash `ls` with glob patterns — zsh (macOS default) errors on unmatched globs.
> Use Bash only for `git` commands, `gh` CLI, and `which`.

- **Dependency manifests:** Use Glob for `package.json`, `requirements.txt`, `Pipfile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, `build.gradle`. Read each found file.
- **Framework config:** Use Glob for `**/jest.config.*`, `**/vitest.config.*`, `**/.eslintrc*`, `**/tsconfig.json`, `**/openapi.yaml`, `**/openapi.json`, `**/.prettierrc*`.
- **Directory structure:** Use Glob for `src/`, `lib/`, `controllers/`, `services/`, `middleware/`, `models/`, `routes/`, `api/`, `pkg/`, `cmd/`, `internal/` and patterns from `@resources/scan-patterns.md`.
- **CI/CD config:** Use Glob for `.github/workflows/*.yml`, `Jenkinsfile`, `.circleci/config.yml`, `.gitlab-ci.yml`.
- **Database presence:** Use Glob for `prisma/`, `migrations/`, `alembic.ini`, `db/migrate/`, `**/sequelize*`, `**/typeorm*`, `**/sqlalchemy*`.
- **Test structure:** Use Glob for `test/`, `tests/`, `spec/`, `__tests__/`, `cypress/`, `**/playwright.config.*`.
- **Existing review dimensions:** Use Glob for `.sdlc/review-dimensions/*` (count and names).
- **Existing guardrails:** Use Read on `.sdlc/config.json` → `plan.guardrails` array if present.
- **GitHub hosting detection:** Bash for `git remote -v` and `gh repo view` (safe). Use Glob for `.github/`.
- **AGENTS.md / AGENTS.md:** Use Read on `AGENTS.md`, `AGENTS.md`, `.sdlc/AGENTS.md` if present.
- **PR template:** Use Glob for `.github/PULL_REQUEST_TEMPLATE.md`, `.github/pull_request_template.md`.
- **Recent PRs:** Bash for `gh pr list --limit 5 --json title,body` (safe).
- **Existing PR template:** Use Glob for `.sdlc/pr-template.md`.
- **JIRA evidence:** Bash for `git log --oneline -20` and `git rev-parse --abbrev-ref HEAD` (safe).

Collect all signals into a "Scan Input" object to pass to the sub-flow. Run the scan once per setup invocation; cache the result for any subsequent delegated section in the same selectedIds list.

#### Legacy section reference

The historical step labels map onto the dispatcher above for anyone updating tests or docs:

| Legacy step | Manifest section id | Dispatcher branch |
|---|---|---|
| 3a | `version` | 3.G with `confirmDetected: true` |
| 3b | `ship` | 3.G |
| 3c | `jira` | 3.G |
| 3d | `review` | 3.G |
| 3e | `commit` | 3.commit |
| 3f | `pr` | 3.pr |
| 3g | `workspace` | 3.workspace (R24) |
| 3h | `hooks` | 3.hooks (R25) |


#### Diff preview (issue #235)

Before invoking `util/setup-init.js`, render an end-of-run diff preview comparing the in-memory snapshot of the project config as read at preflight (Step 0 prepare output) against the accumulated answers from Steps 3a–3f. Use `lib/config.js::computeConfigDiff(before, after)` — pure helper, no I/O:

```shell
<PLUGIN_ROOT>/skills/setup-sdlc/scripts/diff_write_config.sh
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
<PLUGIN_ROOT>/skills/setup-sdlc/scripts/init.sh
```
> **Contract (Input/Output):**
> - **Input**: Configuration parameters.
> - **Output**: Bootstraps the `.sdlc` directory structure.

Parse the output JSON from `$INIT_OUTPUT_FILE`. The `trap` above guarantees cleanup on any exit path — do not add scattered `rm -f` calls.

Display created files, check for errors. The `setup-init.js` script deterministically creates `.sdlc/` directory, `.sdlc/.gitignore`, writes config files via `writeProjectConfig` and `writeLocalConfig` (read-merge-write, so existing sections are preserved), and ensures a managed `.gitignore` block exists in the project root listing transient skill artifact patterns (`*-context-*.json`, `*-manifest-*.json`, `*-prepare-*.json`). The managed block is delimited by sentinel comments (`# >>> sdlc-utilities managed`/`# <<< sdlc-utilities managed`) and is idempotent — re-running setup-sdlc replaces the block contents in place rather than duplicating. Existing user content in `.gitignore` is preserved (issue #209).

### Step 3b -- Validate Written Config

Re-run `skill/setup.js` to verify the config files were written correctly:

```bash
node "$SCRIPT" > "$PREPARE_OUTPUT_FILE"
```

Parse the output and confirm:
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

This skill is safe to re-run. Already-configured sections are skipped unless `--force` is passed. The `writeProjectConfig` and `writeLocalConfig` functions use read-merge-write, so re-running does not clobber existing config written by other skills.

---

## DO NOT

- Run full-suite or wide-subset `promptfoo eval` automatically — single targeted test scoped to the change is allowed; tight-loop retries are not.
- Delete legacy files without explicit user confirmation via AskUserQuestion
- Invoke removed skills (`/review-init-sdlc`, `/pr-customize-sdlc`, `/guardrails-init-sdlc`) -- they no longer exist as standalone skills; use the sub-flows (`@resources/setup-dimensions.md`, `@resources/setup-pr-template.md`, `@resources/setup-guardrails.md`) instead
- Modify Jira templates directly -- delegate to `/jira-sdlc` via the Skill tool
- Write config files using the Write or Edit tools directly -- always go through `lib/config.js` functions (`writeProjectConfig`, `writeLocalConfig`) via inline Node.js in Bash
- Invoke sub-skills via the Agent tool -- use the Skill tool exclusively
- Skip AskUserQuestion for any user interaction -- do not print questions and wait for freeform input
- Assume `mode` for the version section -- it is a required field, always ask or detect

---

## Gotchas

**skill/setup.js must run from the project root.** It uses `process.cwd()` to locate config files. If the working directory is wrong, detection will silently return empty results.

**The version section requires `mode` as a required field.** The JSON schema enforces this. When `detected.versionFile` is present, default to `mode: "file"`. When null, default to `mode: "tag"`. Always include `mode` in the written config.

**Ship config is developer-local.** Ship preferences live in `.sdlc/local.json` (gitignored), not in `.sdlc/config.json`. Each developer has their own ship preferences.

**Migration may find conflicts.** If both unified config (`.sdlc/config.json`) and legacy files exist for the same section, the unified config wins. The `migrateConfig()` function reports these as `conflicts` -- display them to the user and explain that the legacy values were NOT merged.

**`writeProjectConfig` and `writeLocalConfig` do read-merge-write.** They will not clobber sections written by other skills. Each call merges the provided config into the existing file content. This makes it safe to write one section at a time.

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
