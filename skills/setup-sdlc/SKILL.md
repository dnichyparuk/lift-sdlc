---
name: setup-sdlc
description: "Use this skill when setting up Lift-SDLC for a project, initializing configuration, or when any skill reports missing config. Renders a selective-section menu so users choose which sections to configure; each selected section prints a verbose header (purpose, files-modified, consuming skills, per-option description) before any prompt. Supports direct sub-flow entry via --only, --dimensions, --pr-template, --guardrails, --execution-guardrails, --openspec-enrich, --learn. Arguments: [--migrate] [--skip <section>] [--force] [--only <ids>] [--dimensions] [--pr-template] [--guardrails] [--execution-guardrails] [--openspec-enrich] [--learn] [--remove-openspec] [--add] [--no-copilot]"
user-invocable: true
argument-hint: "[--migrate] [--skip <section>] [--force] [--only <ids>] [--dimensions] [--pr-template] [--guardrails] [--execution-guardrails] [--openspec-enrich] [--learn] [--remove-openspec] [--add] [--no-copilot]"
---

# SDLC Setup

Unified setup skill that detects existing configuration, migrates legacy files, walks the user through selected sections, and delegates content creation to specialized sub-flows.

**Announce at start:** "I'm using setup-sdlc (sdlc v{sdlc_version})." -- extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

> Cold-path details (manifest schema, migration edge rules, `preReleaseCompat`, field coercion, specialized section notes, and the full Step 3.S scan checklist) live in `./resources/section-and-migration-guide.md`.

---

## Arguments

| Flag | Description | Default |
|------|-------------|---------|
| `--migrate` | Force legacy config migration check even if not auto-detected | off |
| `--skip <section>` | Skip a config section (`version`, `ship`, `jira`, `review`, `commit`, `pr`, `learn`) | none |
| `--force` | Pre-check every menu row instead of only `not-set` rows | off |
| `--only <ids>` | Comma-separated `prepare.sections[].id` list to configure non-interactively (skips menu): `version`, `ship`, `jira`, `review`, `commit`, `pr`, `pr-labels`, `review-dimensions`, `pr-template`, `plan-guardrails`, `execution-guardrails`, `openspec-block`, `hooks`, `learn` | none |
| `--dimensions` / `--pr-template` / `--guardrails` / `--execution-guardrails` / `--openspec-enrich` / `--learn` | Direct-entry aliases for `--only` (see Step 0 routing table) | off |
| `--remove-openspec` | Remove the managed block from `openspec/config.yaml` (with `--openspec-enrich`) | off |
| `--add` | Expansion mode (with `--dimensions` or `--guardrails`) | off |
| `--no-copilot` | Skip GitHub Copilot instructions (with `--dimensions`) | off |

---

## Plan Mode Check

If the system context contains "Plan mode is active":

1. Announce: "This skill requires write operations. Exit plan mode first, then re-invoke `/setup-sdlc`."
2. Stop. Do not proceed to subsequent steps.

---

## Workflow

### Step 0 -- Pre-flight

Run `skill/setup.js` via `run_command` from the project root to get current state:

> **VERBATIM** -- Run this shell block exactly as written, invoking the script with `node` and its absolute path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin; the strict script location pattern is `<PLUGIN_ROOT>/scripts/<group>/<script-name>.js`, where `<group>` is one of `skill`, `util`, `lib`, `state`, or `ci`). There is no shell wrapper — always call `node` on the `.js` file directly. Do not modify, rephrase, or simplify the commands.

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

**Outdated CI scripts warning:** Check `prepare.scriptVersions.outdatedCount`. If `> 0`, print a report-only warning (do not auto-fix or block):

```
⚠ Outdated CI pipeline scripts detected (N file(s)):
<for each file where action is 'outdated' or 'missing': "  - <file> (installed: v<installedVersion || 'missing'>, current: v<currentVersion>)">
Run `/setup-sdlc --migrate` or `/version-sdlc --init` to update.
```

**Flag routing:** Translate direct-entry flags (when `--only` is not passed) into `--only <id>`:

| Flag | `--only` id |
|------|-------------|
| `--dimensions` | `review-dimensions` |
| `--pr-template` | `pr-template` |
| `--guardrails` | `plan-guardrails` |
| `--execution-guardrails` | `execution-guardrails` |
| `--openspec-enrich` | `openspec-block` |
| `--learn` | `learn` |

If `--only <ids>` is set (directly or via translation), skip Step 1's menu and proceed to Step 2 → Step 3 with `selectedIds = <ids>`, passing through `--add`, `--no-copilot`, and `--remove-openspec`. Otherwise follow Steps 1 → 2 → 3 → 4. See `./resources/section-and-migration-guide.md` for the full `prepare` JSON schema.

---

### Step 1 -- Selective-Section Menu

<!-- Implements R-menu-1, R-menu-4. Step 1 is plain chat output; ask_question is intentionally NOT used here. -->

1. **Render the status block** using `section.label`, `section.summary`, and `section.state` (`[set]`, `[not set]`, `[legacy]` with `(locked — migration required)` when `section.locked` is true):

```
SDLC Setup
---------------------------------------------------
Detected configuration:

  [set]      <id>            <summary>
  [not set]  <id>            <summary or "—">
  [legacy]   <id>            <summary>  (locked — migration required)
```

2. **Print the numbered menu directly to chat** in `prepare.sections[]` order (1-indexed), sourcing all strings from `scripts/lib/setup-sections.js` (never hardcode labels or descriptions):

```
<N>. [<state>] <section.label> — <first sentence of section.purpose>
```
Locked legacy rows append ` (locked — required)` after `<section.label>`.

3. **Ask via plain chat (NOT `ask_question`)** and end the turn so the user's next message is the reply:

```
Reply with the numbers to configure (e.g. 1,3,5 or 1-3,7), or type:
  all       — configure every section
  not-set   — configure only sections currently [not set]
  none      — exit without changes
  cancel    — exit without changes (alias for none)
Default: <prepare.menuInputContract.defaultToken>
```

4. **Parse the reply** against `prepare.menuInputContract`:
   - Empty reply → `prepare.menuInputContract.defaultToken` (`all` or `not-set`). `all` → all `prepare.sections[].id`; `not-set` → rows with `state === 'not-set'`; `none`/`cancel` → empty list (unless locked rows exist).
   - Comma/space-separated numbers or `M-N` ranges → union of 1-indexed rows.
   - **Always-include rule:** rows where `section.locked === true` are always added regardless of reply (even `none` still sends locked rows to Step 3). If the resolved list is empty, print `No sections selected — no changes made.` and jump to Step 4.
   - **Invalid input:** print `Invalid input: "<token>" is not a number, range, or known keyword. Try again.`, re-print the numbered menu and prompt (max 3 retries; then exit with `No valid input after 3 attempts — no changes made.`).

Store the resolved list as `selectedIds`.

---

### Step 2 -- Migration

**Skip this step if:** `needsMigration` is `false` AND `--migrate` was NOT passed.

Otherwise (`needsMigration === true` — legacy files, misplaced `.sdlc/config.json` sections, v1 `.sdlc/local.json`, or `.sdlc/jira-templates/` — or `--migrate` passed), read `./resources/section-and-migration-guide.md` ("Migration Workflow") and follow it completely before Step 3. Never delete legacy files without explicit `ask_question` confirmation.

---

### Step 3 -- Dispatch Loop (Verbose Per-Section Configuration)

For each `id` in `selectedIds` in `prepare.sections[]` order (`section = prepare.sections.find(s => s.id === id)`):

1. **Print the verbose header** verbatim from `scripts/lib/setup-sections.js` (do NOT rewrite or omit any line):

   ```
   --- Configuring: <section.label> ----------------------------------
   Purpose:        <section.purpose>

   Files modified: <section.filesModified joined with ", ">
   Consumed by:    <section.consumedBy joined with ", ">
   Config file:    <section.configFile> (path: <section.configPath || "—">)
   Current value:  <section.summary or "<none>">
   ```

2. **Print the per-option description block** (when `section.fields.length > 0`):

   ```
   Options:
     <field.name>  ({field.type}, default: <field.default>)
                   <field.description>
   ```

3. **Run the dispatcher for `section.delegatedTo`**:

   | `delegatedTo` value | Dispatcher |
   |---|---|
   | `null` | Generic field-loop (3.G below). `workspace` overrides `layout`-field rendering per `@resources/setup-workspace.md` (read and follow in full; writes `.sdlc/local.json`). `hooks` sets `agentIsolationGuard.enabled` in `.sdlc/local.json`. |
   | `'inline-commit-builder'` | Read and follow `@resources/setup-patterns.md` ("Commit-pattern builder") |
   | `'inline-pr-builder'` | Read and follow `@resources/setup-patterns.md` ("PR-pattern builder"; `same-as-commit` depends on `commit` running first) |
   | `'setup-dimensions'` | Run Step 3.S scan, then read and follow `@resources/setup-dimensions.md` with Scan Input (pass `--add`, `--no-copilot`) |
   | `'setup-pr-template'` | Run Step 3.S scan, then read and follow `@resources/setup-pr-template.md` with Scan Input (pass `--add`) |
   | `'setup-pr-labels'` | Read and follow `@resources/setup-pr-labels.md` (runs `gh label list` itself) |
   | `'setup-guardrails'` | Read and follow `@resources/setup-guardrails.md` (pass `--add`) |
   | `'setup-execution-guardrails'` | Read and follow `@resources/setup-execution-guardrails.md` (pass `--add`) |
   | `'setup-openspec'` | Read and follow `@resources/setup-openspec.md` (pass `--remove-openspec` as `--remove`) |

#### 3.G. Generic field loop (`delegatedTo === null`)

- If `section.confirmDetected === true` (e.g. `version`), ask via `ask_question` whether to use detected values (`yes`), `customize` each field, or `skip`. On `yes`, write `prepare.detected.*` directly (omitting `preRelease`).
- When iterating `section.fields[]`, issue **exactly one `ask_question` per unskipped entry** (do not batch or hand-enumerate):
  - Skip immediately if `field.skip === true` (prepare-sourced gate) or upstream answer makes it irrelevant (e.g., `versionFile`/`fileType` when `mode === 'tag'`, `changelogFile` when `changelog === false`).
  - Use `field.label`, `field.description`, `field.options` (or free-text when `null`), `field.default`, and `field.validate`.
- For `version` with non-empty `preRelease` and `mode !== 'tag'`, run the `prepare.preReleaseCompat[<fileType>]` check before storing.
- Read `./resources/section-and-migration-guide.md` ("Generic Field Loop & Section Details") for full `confirmDetected`, `preReleaseCompat` branching, field-type coercion (`number`, `list`, `rebase` exception), and `workspace`/`hooks` details.

#### 3.S. Scan phase (delegated content sections only)

Run once per invocation (cache Scan Input across delegated sections) before `setup-dimensions` or `setup-pr-template`. Follow the full checklist and shell-safety rules (`find_by_name` for files, `run_command` only for `git`/`gh`/`which`) in `./resources/section-and-migration-guide.md` ("Project Signal Scan").

#### Diff preview (HARD GATE before config write)

Compare the Step 0 preflight snapshot against the assembled answers using `lib/config.js::computeConfigDiff`:

```shell
node "<PLUGIN_ROOT>/scripts/util/setup-diff-write-config.js" --before '<BEFORE_JSON>' --after '<AFTER_JSON>'
```
> **Contract (Input/Output):**
> - **Input**: Config changes.
> - **Output**: Computes/applies config diff for `.sdlc/config.json`.

Render `DIFF_JSON.changed[]` as a markdown table (`| path | before | after |`).
- If `DIFF_JSON.changed.length === 0`: print `No changes — nothing to write.`, skip `util/setup-init.js`, and proceed to Step 3b.
- Otherwise, confirm the diff via `ask_question` (suppressed when `--auto` is set). On rejection, print `Write cancelled — no changes made.` and skip writing.

#### Writing config files (HARD RULE)

After confirming the diff preview, write project and local configs deterministically via `util/setup-init.js` (only include configured, non-skipped sections):

```shell
SETUP_INIT_FILE=$(node "<PLUGIN_ROOT>/scripts/util/setup-init.js" --output-file --project-config '<PROJECT_CONFIG_JSON>' --local-config '<LOCAL_CONFIG_JSON>')
```
> **Contract (Input/Output):**
> - **Input**: Configuration parameters.
> - **Output**: Bootstraps `.sdlc/`, `.sdlc/.gitignore`, writes `.sdlc/config.json` and `.sdlc/local.json` via read-merge-write (`writeProjectConfig` / `writeLocalConfig`), and updates the idempotent `# >>> lift-sdlc managed` `.gitignore` block.

Read `$SETUP_INIT_FILE`, parse the JSON, check for errors, and delete `$SETUP_INIT_FILE` with `rm -f "$SETUP_INIT_FILE"`.

### Step 3b -- Validate Written Config

Re-run `skill/setup.js` to verify written config files:

```bash
VALIDATE_OUTPUT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/setup.js")
```

Read `$VALIDATE_OUTPUT_FILE` and parse its JSON (do not redirect stdout; `skill/setup.js` prints only the manifest path). Confirm `projectConfig.exists === true` with written sections and `localConfig.exists === true` (when local sections were written). If validation fails, warn the user and offer to retry before any content setup.

---

### Step 4 -- Summary & Idempotency

Print a concise summary showing only sections actually created, updated, or migrated (omitting skipped/unchanged sections):

```
Setup complete
---------------------------------------------------
Created/updated:  .sdlc/config.json / .sdlc/local.json
Content:          Review dimensions / PR template / Plan guardrails
Migrated:         <legacy file> -- merged [deleted | kept]
```

Re-running `/setup-sdlc` is idempotent: `writeProjectConfig` and `writeLocalConfig` perform read-merge-write so unrelated sections are preserved.

---

## DO NOT

- Run full-suite or wide-subset `promptfoo eval` automatically — single targeted test scoped to the change is allowed; tight-loop retries are not.
- Delete legacy files without explicit user confirmation via `ask_question`
- Invoke removed skills (`/review-init-sdlc`, `/pr-customize-sdlc`, `/guardrails-init-sdlc`) -- they no longer exist as standalone skills; use the sub-flows (`@resources/setup-dimensions.md`, `@resources/setup-pr-template.md`, `@resources/setup-guardrails.md`) instead
- Modify Jira templates directly -- delegate to `/jira-sdlc` via the Skill tool
- Write config files using `write_to_file` or `replace_file_content` directly -- always go through `lib/config.js` functions (`writeProjectConfig`, `writeLocalConfig`) via inline Node.js in `run_command` (or `util/setup-init.js`)
- Invoke sub-skills via `invoke_subagent` or run inline as specified
- Skip `ask_question` for any user interaction (other than Step 1's plain-chat menu) -- do not print questions and wait for freeform input
- Assume `mode` for the version section without asking or detecting it -- it is a required field enforced by the JSON schema; default to `mode: "file"` when `detected.versionFile` is present, otherwise `mode: "tag"`, and always include `mode` in the written config

---

## Gotchas & Learning Capture

- **Run `skill/setup.js` from project root** (`process.cwd()` locates configs; wrong cwd silently returns empty results).
- **Developer-local files:** `ship`, `workspace`, and `hooks` belong in `.sdlc/local.json` (gitignored), never `.sdlc/config.json`.
- **Learning Capture:** Append notable project quirks, migration edge cases, or non-default preferences to `.sdlc/learnings/log.md` (`## YYYY-MM-DD -- setup-sdlc: <summary>`).

## See Also

- [`/version-sdlc`](../version-sdlc/SKILL.md) -- version bumps and release tags
- [`/ship-sdlc`](../ship-sdlc/SKILL.md) -- end-to-end feature shipping pipeline
- [`/review-sdlc`](../review-sdlc/SKILL.md) -- multi-dimension code review
- [`/jira-sdlc`](../jira-sdlc/SKILL.md) -- Jira integration
