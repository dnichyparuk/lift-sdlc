# SDLC Plugin Changes Log

## ship-sdlc: explicit plan path only (#16)

**Date:** 2026-10-07
**Version:** 0.25.2

### Overview
`/ship-sdlc` now executes only the plan the user names with `--plan <path>`. It no longer takes the newest `*.md` by modification time from `plansDirectory` or `~/.gemini/plans/`; that folder is shared by every repository, so the newest file could be a plan for another repository, and the `execute` step would have implemented it here. The behaviour matches the Claude Code `sdlc` plugin (#505 there).

### Changes Made

#### 1. Prepare Script
- **`scripts/skill/ship.js`**: New `--plan <path>` flag; `--plan-file <path>` and a positional `*.md` stay as aliases, and either flag without a value is now an error. `resolvePlanFile` is explicit-only (no directory scan, no mtime sort) and rejects a missing path or a directory (`planFileNotFound`) and a non-`.md` file (`planFileNotMarkdown`). When the `execute` step will run and no plan path is given, the run stops with `missingPlanFile`. A resumed pipeline (explicit `--resume` or implicit resume of a fresh state file) reuses the plan path recorded as `flags.planFile` in its ship state; the plan-mode-blocked path records it too. The execute step's reason now names the plan file.
- **`scripts/skill/ship.test.js`**: Covers the flag forms, `resolvePlanFile`, and `missingPlanFile`.

#### 2. Skills and Docs
- **`skills/ship-sdlc/SKILL.md`**: `--plan <path>` in `description` and `argument-hint`; Step 1c forwards the user's plan path and never fills it in; context, pipeline table and resume text cite the plan file.
- **`skills/execute-plan-sdlc/SKILL.md`**: Accepts `--plan <path>` and the positional `*.md` path promised by its `argument-hint`, as aliases of `--plan-file`.
- **`docs/configuration.md`**: `plansDirectory` only sets where `/plan-sdlc` writes plans.

### Impact
`/ship-sdlc` without `--plan` and with `execute` in its steps now stops with a clear error instead of executing a guessed plan. To ship changes that are already implemented, leave `execute` out of `--steps`.

## received-review-sdlc Verification Orchestrator

**Date:** 2026-09-14

### Overview
Added a dedicated orchestrator agent for the `received-review-sdlc` skill so that verifying reviewer claims against the actual code is no longer performed inline by the skill itself. When a Step 1a manifest is available, the skill now dispatches `received-review-orchestrator`, which fans out per-file verifier sub-agents, persists a verification report, and returns a bounded `VERIFY_SUMMARY` token back to the skill.

### Changes Made

#### 1. New Orchestrator Agent
- **`agents/received-review-orchestrator.md`**: New agent, locked to `gemini-3.8-flash-low`. Reads the received-review manifest, groups outstanding threads by file, dispatches verifier sub-agents in parallel (flash by default, escalated to pro for any group containing a `severity:critical` thread), persists the verification report to disk, and returns the `VERIFY_SUMMARY` token.

#### 2. New Parsing Library and CLI
- **`scripts/lib/verify-summary.js`**: New module exporting `parseVerifySummary`, `VALID_VERIFICATION_STATUSES`, `VALID_SUMMARY_STATUSES`, and the `MAX_EVIDENCE`, `MAX_RIPPLE`, and `MAX_REASONING_CHARS` bounds used to validate the `VERIFY_SUMMARY:` token.
- **`scripts/util/parse-verify.js`**: New CLI (`runParseVerify`, `parseArgs`, `main`) that reads the orchestrator's response from stdin alongside a `--dispatched-ids` list and exits 0/1/2 depending on parse outcome.
- **`scripts/lib/wave-summary.js`**: Extracted the shared `extractFinalLineToken(text, prefix)` scanner, now exported and reused by `verify-summary.js`.

#### 3. Skill Dispatch Split
- **`skills/received-review-sdlc/SKILL.md`**: Step 3 is now split into Step 3a (dispatches `received-review-orchestrator` when a Step 1a manifest exists) and Step 3b (the prior verbatim inline verification, kept as a fallback when no manifest is available).

### Impact
Received-review verification now runs as an isolated, context-clean agent dispatch with a bounded, machine-parseable summary token, matching the orchestrator pattern already used by `review-sdlc`, `commit-sdlc`, and the other registered plugin agents.

## Model Mapping & Suffix Refactoring

**Date:** 2026-06-13

### Overview
We successfully transitioned Lift-SDLC from a dynamic byte-budgeting model reasoning-depth approach to explicit, hardcoded static model assignments. 

Previously, the plugin dynamically calculated byte budgets using `compute_context_suffix.js` and `dispatch-budget.js`, appending `-low`, `-medium`, or `-high` suffixes to models at runtime. This logic was deprecated because all models in the Antigravity 4 family now uniformly share a 1M token context window, meaning byte-based calculations for context limits are obsolete. The suffixes now purely control the model's reasoning/computation budget.

### Changes Made

#### 1. Removal of Legacy Calculation Scripts
- **`compute_context_suffix.js`**: Completely deleted from `skills/ship-sdlc/scripts/`.
- **`dispatch-budget.js`**: Removed the `contextSuffix` calculation and return. The utility now purely computes wave-size caps without modifying the target execution model.

#### 2. Static Routing in `ship-sdlc` Pipeline
Replaced generic `gemini-3.8-flash` base model placeholders in `ship.js` with explicitly appended static suffixes that define the reasoning depth natively required per step:
- **`gemini-3.1-pro-low`**: `execute` (requires pro logic for DAG sorting, but skips extended thinking loops to minimize orchestration latency)
- **`gemini-3.8-flash-medium`**: `review`, `received-review` (needs moderate reasoning budget to analyze requirements and guardrails)
- **`gemini-3.8-flash-low`**: `commit`, `commit-fixes`, `version`, `pr`, `cleanup`, `archive-openspec`, `learnings-commit` (simple tasks requiring maximum speed).

#### 3. Static Routing in `plan-sdlc` Subagents
Assigned static logic depths to `plan.js` critique subagents previously sharing a generic base flash model:
- **`gemini-3.8-flash-medium`**: Applied to `content-coverage`, `guardrail-compliance`, `dimension-coverage`, and all three `lensReviewers` (Architecture, Requirements, Risk).
- **`gemini-3.8-flash-low`**: Applied to `static-structural` and `file-existence` checks.

- **Orchestrator Lock:** Permanently locked the `wave-runner` orchestrator Agent to `gemini-3.8-flash-low`. It performs mechanical string parsing and looping, and thus never needs deep reasoning loops.
- **Worker Suffix Presets:** Attached explicit reasoning suffixes directly to the workers in the Model Presets table to match the Quality presets (`-low`, `-medium`, `-high`), forming a perfect continuum of cost vs capability.
- **Dynamic Retry Escalation:** Per-task retries now actively escalate the reasoning budget before escalating the model architecture. (e.g., `gemini-3.8-flash-medium` -> `gemini-3.8-flash-high` -> `gemini-3.1-pro-low`).

#### 5. Documentation Upgrades
- **`docs/model-references.md`**: Updated the Inventory Mapping table to replace "Bypasses dynamic suffix" with "Uses static suffixes assigned in ship.js" and updated default pipeline mappings.
- **`docs/sdlc-plugin-architecture-report.md`**: Updated the Model Routing section to clarify that suffixes define reasoning budgets and are now handled via hardcoded static assignments.

### Impact
This change guarantees stable, predictable cost modeling across all pipeline stages, eliminates the disk I/O penalty of querying git histories for byte budgets, and properly aligns the model execution with computational reasoning bounds instead of outdated token context limits.

## CLI hardening and review resilience

**Date:** 2026-09-15

### Overview
Hardened the plugin's CLI scripts against two drift risks: scripts that read stdin before checking for `--help` (hanging when an agent harness holds stdin open), and `scripts/state/execute.js` staying an outlier by silently accepting unknown flags instead of rejecting them. Also improved `review-sdlc`'s resilience around oversized/truncated dimension diffs and dimension-outcome classification, and tightened a git wrapper's stdio defaults and the ship pipeline's plan-detection and completeness-verification error handling.

### Changes Made

#### 1. Help-Before-I/O Fast Path and Contract Test
- **`scripts/ci/cli-help-contract.test.js`** (new): Enumerates every CLI script under `scripts/**/*.js` via `listCliScripts` (excluding `*.test.js` and pure `scripts/lib/*.js` modules), spawns each with `node <script> --help` (`runHelp`) against an open, never-ended stdin pipe and a fresh temp `cwd`, and asserts every script terminates without hanging or dying by signal. Scripts in the `HELP_CONTRACT` set — the six stdin-reading scripts converted to the fast path (`scripts/util/parse-wave.js`, `scripts/util/parse-verify.js`, `scripts/util/parse-proposal.js`, `scripts/lib/markdown-to-adf.js`, `scripts/skill/received-review-cluster.js`, `scripts/skill/verify-pipeline-sdlc-classify.js`) plus four scripts that already printed usage (`scripts/lib/links.js`, `scripts/lib/ship-todos.js`, `scripts/util/execute-workspace-setup.js`, `scripts/util/ship-workspace-setup.js`) — are additionally asserted to exit `0` and print a `/^Usage:/m` line. `scripts/util/create-pr.js` is deliberately excluded from `HELP_CONTRACT` because it forwards `--help` to the `gh` CLI.
- **`scripts/lib/markdown-to-adf.test.js`** (new), **`scripts/skill/verify-pipeline-sdlc-classify.test.js`**: Cover the converted scripts' `--help` fast path and existing behavior.

#### 2. `execute.js` Unknown-Flag Rejection
- **`scripts/state/execute.js`**: Added `GLOBAL_FLAGS` (`--branch`, `--state-file`, `--help`, `-h`) and a per-subcommand accepted-flags table; an unrecognized flag for a subcommand now exits `2` with a message naming the accepted flags, closing the CLI-hardening gap where `execute.js` was the one script that silently ignored unknown flags. `USAGE` and the `parsePlanTasks`/`cmdWaveStart` handlers were updated to match; `cmdWaveStart` seeds `wave.tasks` from `--tasks-json` and is idempotent (re-running for the same wave does not duplicate entries).
- **`scripts/state/execute.test.js`**: Covers the new flag-rejection and `wave-start` idempotency behavior.

#### 3. Git Wrapper and Ship Plan Detection
- **`scripts/lib/git.js`**: `exec`'s `stdio` default is now set before the caller's `execOpts` are spread in, so a caller-supplied `stdio` override still wins.
- **`scripts/lib/git.test.js`**: Covers the stdio-override ordering.
- **`scripts/skill/ship.js`**: Clarified `hasPlan` derivation — it is set whenever a plan file is supplied via any of the accepted flag forms, and `merged.hasPlan` also falls back to `Boolean(cli.planFile)` so the execute step isn't skipped when `--has-plan` itself wasn't passed.
- **`scripts/skill/ship.test.js`**, **`skills/ship-sdlc/SKILL.md`**: Cover/document the `hasPlan` derivation.

#### 4. Verify-Completeness Exit-Code Handling
- **`scripts/util/verify-completeness.js`**: The wrapper now passes through a wrapped `execute.js verify-completeness` child's exit code verbatim on stderr for any code other than `0` (pass) or `65` (incomplete), and calls `markExecuteFailed` only for the `65` case — it never marks the execute step failed for other exit codes.
- **`scripts/util/verify-completeness.test.js`**: Covers the pass-through and `markExecuteFailed` gating.

#### 5. Review Dimension Diff Truncation and Outcome Classification
- **`scripts/skill/review.js`**: Added `DIMENSION_DIFF_WARN_BYTES` (64 KB) and `writeDimensionDiffs`, which independently computes `diff_oversize` and `diff_truncated` per dimension, warns when a dimension's joined diff exceeds the threshold, and emits a dedicated warning when a dimension's `max-diff-bytes` frontmatter value is invalid (in addition to, not instead of, the oversize/truncated warnings). `scripts/lib/dimensions.js`'s `KNOWN_FIELDS` gained `max-diff-bytes` so the new field doesn't trip the D11 unknown-field warning.
- **`scripts/skill/review.test.js`** (new): Covers `writeDimensionDiffs` and the new warnings.
- **`agents/review-orchestrator.md`**: Added Step 2b, which classifies every dimension as returned, returned-via-idle, or not-reviewed; Steps 3-6 operate only on returned dimensions and never block on not-reviewed ones.
- **`skills/review-sdlc/resources/REFERENCE.md`**, **`skills/review-sdlc/SKILL.md`**: Document the dimension-outcome classification and diff-truncation behavior.

#### 6. Plan-sdlc Lens and Lane Prompts
- **`skills/plan-sdlc/resources/lane-file-existence-prompt.md`**: Documents `createdInPlan`, built from every task's `Files: Create:` path, used to validate that a task's `Modify:` path either exists on disk or was created by an earlier task (flagging it as an error, not just missing, when the creating task doesn't precede the modifying one).
- **`skills/plan-sdlc/resources/lens-architecture-prompt.md`**, **`lens-requirements-prompt.md`**, **`lens-risk-prompt.md`**: Their `Output Schema` mirrors the lane schema but adds a `lens` field and drops `gateIds`/`passes`/`laneStatus`.
- **`skills/plan-sdlc/resources/plan-reviewer-prompt.md`**, **`skills/plan-sdlc/SKILL.md`**: Updated to match the lens output schema and lane file-existence check.

### Impact
`execute.js` now matches the unknown-flag-rejection convention already followed by its sibling CLI scripts, and every CLI script in the plugin is guaranteed to terminate on `--help` even with stdin held open by a parent process — both enforced going forward by `scripts/ci/cli-help-contract.test.js`. Review dimension diffs that are oversized or truncated, or whose `max-diff-bytes` frontmatter is invalid, now surface as explicit warnings instead of failing silently, and the review orchestrator's Step 2b keeps later steps from blocking on dimensions that were never reviewed. See `scripts/README.md`'s "CLI contract" section for the rules new scripts must follow.

## Skipped plan checkboxes (`- [~]`)

**Date:** 2026-10-06
**Version:** 0.25.0

### Overview
Plans can mark an acceptance criterion as skipped on purpose with `- [~]`. A skipped box is closed, like `- [x]`, and must carry a `*Skipped on YYYY-MM-DD: <reason>*` comment on its continuation lines. A person (or an agent at a person's request) sets it; `plan-sdlc` keeps generating open `- [ ]` boxes and `execute-plan-sdlc` never writes boxes into the plan.

### Changes Made

#### 1. Shared Checkbox Reader
- **`scripts/lib/plan-checkboxes.js`** (new): `countCheckboxes` counts open, done and skipped boxes (any list marker and nesting level, fenced code ignored, CRLF read as LF) and reports every `[~]` whose comment is missing, misplaced, dated with an invalid calendar date, or has a reason shorter than `MIN_SKIP_REASON` (15) characters.
- **`scripts/lib/plan-checkboxes.test.js`** (new): Unit coverage.

#### 2. Plan Format Validator
- **`scripts/ci/validate-plan-format.js`**: New check PF6 fails each invalid `[~]` and names `<file>:<line>`; it is reported only when the plan has a `[~]`, so reports for other plans are unchanged. PF5 still requires an open `- [ ]` per task (the validator checks a plan before execution); its message notes that a skipped box is closed. The checks are now exported behind a `require.main` guard.
- **`scripts/ci/validate-plan-format.test.js`** (new): Covers PF5/PF6 and the CLI exit codes.

#### 3. Documentation
- **`skills/plan-sdlc/resources/plan-format-reference.md`**: New "Acceptance criteria boxes" section.
- **`scripts/README.md`**: Lists the new shared module.
- **`skills/execute-plan-sdlc/SKILL.md`**: Skipped criteria stay out of the fact sheet's `acceptanceCriteria`; the executor never writes `- [~]`.

### Impact
A plan may record deliberately skipped criteria without losing the audit trail, and the PreToolUse plan validation (`hooks/pre-tool-validate.js`) rejects a skipped box without its comment. OpenSpec `tasks.md` parsing (`scripts/lib/openspec.js`) is unchanged: `[~]` is not part of the OpenSpec format.

## Plan validation hook: executable plans only (#17)

**Date:** 2026-10-07
**Version:** 0.25.1

### Overview
The PreToolUse validation hook no longer blocks legitimate whole-file writes to a `plans` folder. It validates only content that declares itself an executable plan, accepts plans whose boxes are all ticked or skipped, and skips archive directories. `plan-sdlc` gains a final format check, so a plan finished with replace edits is still validated before handoff.

### Changes Made

#### 1. Hook Scope
- **`hooks/pre-tool-validate.js`**: A `write_to_file` to `*/plans/*.md` is validated only when the content has a `**Goal:**` line and at least one `### Task N:` heading outside fenced code; READMEs, plan guidelines, briefs and the Step 0 skeleton pass. Paths under `archive/` or `archived/` are not validated. The validator runs with `--allow-closed-criteria`.
- **`hooks/pre-tool-validate.test.js`**: Covers finished plans, non-plan Markdown (including a fenced example plan), archive paths, and a structural error that is still denied.

#### 2. Plan Format Validator
- **`scripts/ci/validate-plan-format.js`**: New `isExecutablePlan` export; new `--allow-closed-criteria` flag (PF5 counts `[ ]`, `[x]` and `[~]` boxes; the default stays strict). PF1 reads a header value from the same line only (`[ \t]*` instead of `\s*`), so an empty `**Source:**` no longer takes the next line as its value.
- **`scripts/lib/plan-checkboxes.js`**: Exports `markFences`.
- **`scripts/ci/validate-plan-format.test.js`**: Covers the detector, the relaxed PF5 and the PF1 fix.

#### 3. Skill and Reference
- **`skills/plan-sdlc/SKILL.md`**: New Step 6.6, a hard gate that runs `validate-plan-format.js` (strict PF5) on the finished plan before handoff.
- **`skills/plan-sdlc/resources/plan-format-reference.md`**: Documents the hook scope.

### Impact
Plans folders can hold programme documents next to executable plans, and finished or archived plans can be rewritten with a whole-file write. An executable plan with a structural error is still denied, and a `- [~]` without its comment is still denied (PF6).

## execute-plan-sdlc: explicit plan path only

**Date:** 2026-10-07
**Version:** 0.26.0

### Overview
`/execute-plan-sdlc` no longer takes a plan from the conversation context ("Smart loading"). It runs only the plan named by a positional `*.md` path, `--plan <path>` or `--plan-file <path>`, or the plan path recorded in a resumed state file; otherwise it stops with a fix hint. This completes #16 for the standalone executor and matches the Claude Code `sdlc` plugin (R41 there).

### Changes Made
- **`skills/execute-plan-sdlc/SKILL.md`**: `description` and `argument-hint` (`<plan-file-path>` is now required) state that the plan is never inferred from context. Step 1 reads the plan only from the explicit path and gains a Plan-argument gate (no interactive prompt for the path, no context fallback). A resume with a legacy `planPath: null` state no longer asks for the path; it needs the path on the command line.
- **`skills/execute-plan-sdlc/resources/state-format.md`**: `planPath` is always set by current versions.
- **`skills/plan-sdlc/SKILL.md`**: the handoff menus print `/ship-sdlc --plan <path>` and `/execute-plan-sdlc <path>` and pass the written plan path when invoking either skill.
- **`skills/execute-plan-sdlc/plan-source.test.js`** (new): contract test for the skill text.

### Impact
Accepting a plan and then running `/execute-plan-sdlc` without a path now stops with a message instead of executing the plan from the conversation. Pass the plan file path (plan-sdlc prints it in its handoff menu).

## plan-indexer: lint-clean model export

**Date:** 2026-10-07
**Version:** 0.26.1

### Overview
`npm run lint` is clean again. `scripts/lib/plan-indexer/model.js` assigned `window.DeliveryGraphModel` behind a `typeof window` guard; the file is linted as Node code, where `window` is not a declared global, so ESLint reported `'window' is not defined`.

### Changes Made
- **`scripts/lib/plan-indexer/model.js`**: The `window` branch is removed. The file still exports through CommonJS and `globalThis`, and in a browser `globalThis` is `window`, so the class stays reachable in every host. The dashboard (`templates/dashboard/index.html`) embeds its own copy of the model and is not affected.
- **`scripts/lib/plan-indexer/model.test.js`**: Covers the CommonJS and `globalThis` exports and evaluation in a module-less context.

### Impact
No behaviour change. The ESLint config keeps the Node globals for `scripts/` and `skills/`; no rule was disabled.

## Plan catalog: skipped criteria (`- [~]`)

**Date:** 2026-10-07
**Version:** 0.27.0

### Overview
The plan catalog (`catalog-sdlc`) and its dashboard now understand the skipped criterion box `- [~]` added to the plan validator in 0.25.0. A skipped criterion is a distinct state that counts as closed, as in the validator. The plan authoring guidelines deployed to projects document the rule.

### Changes Made

#### 1. Shared Checkbox Reader
- **`scripts/lib/plan-checkboxes.js`**: New `readCheckboxes` lists every box in document order with its state (`open`, `done`, `skipped`), text and, for `[~]`, the skip comment's date, reason and problem. `countCheckboxes` is built on it, so the validator and the indexer use one reader.

#### 2. Plan Indexer and Dashboard
- **`scripts/lib/plan-indexer/markdown-parser.js`**: Acceptance criteria are read from the whole task body with `readCheckboxes`: any list marker and nesting level, fenced code ignored (before, only `- [ ]`/`- [x]` at column 0 were read, so nested criteria such as those in the `PLAN_GUIDELINES.md` template were missed). Each criterion carries `state`; `checked` means closed (`[x]` or `[~]`), so a task whose boxes are all closed is done. Skipped criteria keep `skipDate` and `skipReason`, or `skipProblem` (the PF6 message) when the comment is missing or invalid.
- **`scripts/lib/plan-indexer/model.js`**, **`templates/dashboard/index.html`**: `countCriteria` and `metrics.criteria` (`total`, `open`, `done`, `skipped`, `closed`); data without `state` falls back to `checked`. The task table shows `closed/total (N skipped)`; the drawer shows a skipped criterion struck through with its skip note, or the problem with the comment.
- **`schemas/delivery-graph.schema.json`**: New criterion fields `state`, `skipDate`, `skipReason`, `skipProblem`.

#### 3. Documentation
- **`templates/guidelines/PLAN_GUIDELINES.md`** and **`skills/plan-guide-sdlc/PLAN_GUIDELINES.md`**: Section 2.3 documents `- [~]`: syntax, required comment, counting, PF5/PF6, and who sets it (a person, or an agent at a person's request).
- **`scripts/skill/plan-guide.js`**: The `AGENTS.md` snippet mentions the rule.
- **`skills/catalog-sdlc/SKILL.md`**, **`skills/plan-guide-sdlc/SKILL.md`**, **`skills/plan-sdlc/resources/plan-format-reference.md`**, **`scripts/README.md`**: Updated.

### Impact
Plans with skipped criteria show correct progress in the catalog and dashboard. Nested criteria are now indexed too, so task progress can change for plans that list criteria under an indented `- **Acceptance criteria:**` bullet. Existing projects get the new guideline text by re-running `plan-guide-sdlc --force`.

## English-only plugin

**Date:** 2026-10-07
**Version:** 0.27.1

### Overview
The plugin is now English-only. The last Russian text is translated, and a new test fails `npm test` if Cyrillic comes back into any git-tracked file.

### Changes Made

#### 1. Plan Guidelines Title
- **`templates/guidelines/PLAN_GUIDELINES.md`** and **`skills/plan-guide-sdlc/PLAN_GUIDELINES.md`**: The title is `# Plan Authoring Guidelines`; the Russian subtitle is removed. The two copies stay byte-identical.
- **`scripts/skill/plan-guide.test.js`**: Covers that the two copies are byte-identical and that `plan-guide.js` deploys the English title, also when it overwrites an existing guide with `--force`.

#### 2. Documentation
- **`docs/delivery-dashboard/README.md`**, **`docs/delivery-dashboard/plan.md`**, **`docs/antigravity-skills-migration-analysis.md`**: Translated to English with structure, tables, links, code and status markers unchanged. The JSON and HTML files in `docs/delivery-dashboard/` had no Cyrillic.

#### 3. English-only Guard
- **`scripts/ci/english-only.test.js`**: New test. It scans every git-tracked file for Cyrillic (U+0400–U+04FF) and reports each hit as `file:line:column` with the line. Exemptions go in an explicit `ALLOWED_FILES` map with a required reason, and an exemption with no Cyrillic left fails too. The list is empty.

### Impact
No behaviour change apart from the deployed guideline title. Projects get the English title by re-running `plan-guide-sdlc --force`.

## .sdlc/.gitignore shared with the sdlc plugin

**Date:** 2026-10-10
**Version:** 0.27.2

### Overview
A project that runs lift-sdlc and the Claude Code `sdlc` plugin (0.21.29) no longer sees its tracked `.sdlc/.gitignore` flip between two shapes. Each writer used to strip the other's patterns and append its own block last; lift-sdlc now writes the same bytes the `sdlc` writer leaves, so the file is identical whichever plugin wrote it last.

### Changes Made

#### 1. Writer
- **`scripts/lib/config.js`**: `ensureSdlcGitignore` keeps the first complete `sdlc-utilities managed` block verbatim and places the `lift-sdlc managed` block immediately before it, with project lines first. When that block lists the base patterns (`*`, `!.gitignore`, `!config.json`, `!review-dimensions/`, `!review-dimensions/**`), the lift-sdlc block holds only `!learnings/`, `!learnings/pending/`, `!learnings/pending/**`; without an `sdlc` block, or with one emptied by lift-sdlc 0.27.1 or earlier, it keeps the full allowlist.
- **`.sdlc/.gitignore`**: This repository's file is rewritten to the canonical shape.

#### 2. Tests
- **`scripts/lib/sdlc-gitignore-convergence.test.js`**: New test with a copy of the `sdlc` 0.21.29 writer. Over 362 inputs (empty file, either block alone, both blocks in either order, full and stripped variants, 0-3 project lines before and after, with and without a final newline) both orders give byte-identical results and both writers are idempotent. Also covers the canonical shape, the verbatim `sdlc` block, the lift-only file and the known limitation below.

#### 3. Documentation
- **`docs/configuration.md`**: New `.sdlc/.gitignore` section with the canonical shape (project lines, lift-sdlc block, `sdlc` block, final newline) and the known limitation.

### Impact
No change for projects that use lift-sdlc alone. In projects that use both plugins, the file settles after the next run of either plugin. Known limitation: lines above the `sdlc` block's `*` (including the lift-sdlc negations and project lines, which both writers move to the top) are shadowed for untracked files; tracked files are unaffected, so such files are added once with `git add -f`.
