# SDLC Plugin Changes Log

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
