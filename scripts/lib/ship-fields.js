'use strict';

// Single source of truth for ship-config fields.
// Consumed by:
//   - scripts/skill/setup.js  → emits as P7 `shipFields` (Step 3b questions)
//   - scripts/skill/ship.js   → imports VALID_SKIP and BUILT_IN_DEFAULTS
//   - scripts/util/ship-init.js → imports VALID_SKIP for --steps validation
//
// Keep schemas/sdlc-local.schema.json (repo root) in sync when adding,
// removing, or renaming fields.

const { PRESET_TO_STEPS } = require('./config');

// Canonical pipeline steps that may appear in ship.steps[]. Order matters
// — used as default ordering for the multi-select question and as the
// iteration order for resolving steps[] -> pipeline steps in ship.js.
//
// Note: `cleanup` is a synthetic terminal step added unconditionally by
// `skill/ship.js::computeSteps` (issue #223 / R38) and is NOT user-configurable.
// It does not appear here. See RESERVED_STEPS below — listing `cleanup` in
// CLI `--steps` or `ship.steps[]` is a validation error.
const CANONICAL_STEPS = ['execute', 'commit', 'review', 'version', 'archive-openspec', 'pr', 'verify-pipeline', 'await-remote-review', 'learnings-commit'];

// Steps that the prepare script appends unconditionally and that users MUST
// NOT pass via CLI `--steps` or set in `ship.steps[]`. The validator in
// `skill/ship.js` rejects any of these names with a clear error.
const RESERVED_STEPS = ['cleanup'];

const SHIP_FIELDS = [
  {
    name: 'steps',
    label: 'Pipeline steps to run',
    type: 'multi-select',
    options: CANONICAL_STEPS.slice(),
    default: CANONICAL_STEPS.slice(),
    description: 'Pipeline steps to run by default. received-review and commit-fixes run conditionally based on review verdict and are not configurable here. verify-pipeline and await-remote-review are opt-in entries — add them explicitly to enable post-PR CI verification and remote-reviewer awaiting.',
  },
  {
    name: 'quick',
    label: 'Optional --quick profile steps',
    type: 'multi-select',
    options: CANONICAL_STEPS.slice(),
    default: undefined,
    description: 'Optional shortened step list used when ship-sdlc is invoked with --quick. Same enum as steps. Leave unset to disable the --quick flag for this project.',
  },
  {
    name: 'quality',
    label: 'Default execution quality tier',
    type: 'enum',
    options: ['full', 'balanced', 'minimal'],
    default: 'balanced',
    description: 'The model execution quality tier applied to the plan execution step. minimal (Speed: 100% Flash), balanced (Balanced: hybrid Flash execution with Pro escalation and review, default), full (Quality: maximum Pro reasoning). Forwarded to execute-plan-sdlc automatically.',
  },
  {
    name: 'bump',
    label: 'Default version bump level',
    type: 'enum',
    options: ['patch', 'minor', 'major'],
    default: 'patch',
    description: 'Applied by /version-sdlc when no explicit bump argument is passed. The runtime value space is wider than this questionnaire presents: ship.bump in .sdlc/local.json may also be a pre-release label matching `^[a-z][a-z0-9]*$` (e.g., `rc`, `beta`); enter such values via `ship-init.js --bump <label>` or by editing the config file. Schema (schemas/sdlc-local.schema.json) validates the union pattern.',
  },
  {
    name: 'draft',
    label: 'Open PRs as drafts?',
    type: 'boolean',
    options: ['yes', 'no'],
    default: false,
    description: 'Default value for the --draft flag on /pr-sdlc',
  },
  {
    name: 'auto',
    label: 'Run pipeline non-interactively?',
    type: 'boolean',
    options: ['yes', 'no'],
    default: false,
    description: 'Skip interactive approval prompts throughout the ship pipeline',
  },
  {
    name: 'workspace',
    label: 'Working environment',
    type: 'enum',
    options: ['branch', 'worktree', 'prompt'],
    default: 'branch',
    description: 'branch (current branch), worktree (isolated git worktree), prompt (ask each time)',
  },
  {
    name: 'rebase',
    label: 'Rebase before shipping?',
    type: 'enum',
    options: ['auto', 'skip', 'prompt'],
    default: 'auto',
    description: 'auto (rebase automatically), skip (never rebase), prompt (ask each time). Runtime values ship.js expects; do NOT write yes/no.',
  },
  {
    name: 'reviewThreshold',
    label: 'Minimum severity that blocks the pipeline',
    type: 'enum',
    options: ['critical', 'high', 'medium', 'low'],
    default: 'high',
    description: 'Findings at or above this severity halt the pipeline',
  },
  {
    name: 'verifyPipelineTimeout',
    label: 'verify-pipeline poll timeout (seconds)',
    type: 'number',
    default: 1200,
    min: 30,
    description: 'Maximum seconds verify-pipeline polls before giving up. (R57)',
    when: { stepInActiveSteps: 'verify-pipeline' },
  },
  {
    name: 'verifyPipelineInterval',
    label: 'verify-pipeline poll interval (seconds)',
    type: 'number',
    default: 60,
    min: 10,
    description: 'Seconds between verify-pipeline poll attempts. (R57)',
    when: { stepInActiveSteps: 'verify-pipeline' },
  },
  {
    name: 'verifyPipelineMaxIterations',
    label: 'verify-pipeline max analyze-fix iterations',
    type: 'number',
    default: 3,
    min: 1,
    max: 10,
    description: 'Maximum analyze-fix-recheck iterations. (R47, R57)',
    when: { stepInActiveSteps: 'verify-pipeline' },
  },
  {
    name: 'awaitRemoteReviewTimeout',
    label: 'await-remote-review poll timeout (seconds)',
    type: 'number',
    default: 600,
    min: 30,
    description: 'Maximum seconds await-remote-review polls. (R57)',
    when: { stepInActiveSteps: 'await-remote-review' },
  },
  {
    name: 'awaitRemoteReviewInterval',
    label: 'await-remote-review poll interval (seconds)',
    type: 'number',
    default: 60,
    min: 10,
    description: 'Seconds between await-remote-review poll attempts. (R57)',
    when: { stepInActiveSteps: 'await-remote-review' },
  },
  {
    name: 'awaitRemoteReviewers',
    label: 'Reviewer logins satisfying await-remote-review',
    type: 'list',
    default: ['copilot'],
    description: 'Logins (case-insensitive) whose reviews satisfy the gate. (R56, R57)',
    when: { stepInActiveSteps: 'await-remote-review' },
  },
];

// Derived: values legally allowed in ship.steps[] (and as members of the
// legacy --skip CLI flag, which subtracts from the resolved steps[]).
// Re-exported as both VALID_SKIP (legacy alias) and VALID_STEPS (preferred,
// self-documenting name). Same array reference — keeping VALID_SKIP avoids
// breaking imports while a follow-up cleanup retires it.
const VALID_STEPS = SHIP_FIELDS.find(f => f.name === 'steps').options.slice();
const VALID_SKIP = VALID_STEPS;

// Runtime resolver defaults consumed by ship.js mergeDefaults().
//
// Three fields intentionally diverge from SHIP_FIELDS[i].default:
//   - rebase: `true` here (legacy boolean, mapped to 'auto' by ship.js
//     line 191-192) vs 'auto' in SHIP_FIELDS (user-facing question default).
//     Same effective value, different storage form.
//   - workspace: 'prompt' here (runtime fallback — ask each time if no
//     config) vs 'branch' in SHIP_FIELDS (user-facing question default).
//     Different intents — don't collapse these without migration analysis.
//   - steps: PRESET_TO_STEPS.balanced here (runtime fallback when no config
//     exists — spec A3 says default is 'balanced') vs CANONICAL_STEPS in
//     SHIP_FIELDS (questionnaire default shows all six so users can pick).
//     The questionnaire default is intentionally broader than the runtime
//     fallback; do not collapse these.
const BUILT_IN_DEFAULTS = {
  steps: PRESET_TO_STEPS.balanced.slice(),
  bump: 'patch',
  draft: false,
  auto: false,
  reviewThreshold: 'high',
  workspace: 'prompt',
  rebase: true,
  verifyPipelineTimeout: 1200,
  verifyPipelineInterval: 60,
  verifyPipelineMaxIterations: 3,
  awaitRemoteReviewTimeout: 600,
  awaitRemoteReviewInterval: 60,
  awaitRemoteReviewers: ['copilot'],
};

module.exports = { SHIP_FIELDS, VALID_SKIP, VALID_STEPS, BUILT_IN_DEFAULTS, CANONICAL_STEPS, RESERVED_STEPS };
