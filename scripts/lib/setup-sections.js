'use strict';

/**
 * @file lib/setup-sections.js
 * @description Single source of truth for setup-sdlc section descriptors.
 *
 * Consumed by:
 *   - scripts/skill/setup.js   → joins SETUP_SECTIONS with detect() state to
 *                                 emit prepare.sections[] (the menu rows).
 *   - skills/setup-sdlc/SKILL.md → Step 1 renders rows; Step 3 dispatch loop
 *                                 reads section.fields, section.purpose,
 *                                 section.filesModified, section.consumedBy
 *                                 to build verbose headers and per-field
 *                                 prompts.
 *
 * Schema:
 *   {
 *     id,                  // canonical section id (used by --only flag)
 *     label,               // short human-readable name (menu row)
 *     purpose,             // one-paragraph runtime explanation
 *     configFile,          // '.sdlc/config.json' | '.sdlc/local.json' | <delegated>
 *     configPath,          // dot-path within configFile, or null for delegated/content sections
 *     consumedBy: [],      // skill ids that read this section at runtime
 *     filesModified: [],   // workspace artifacts created or touched
 *     optional: bool,      // true → safe to leave unset
 *     delegatedTo: null,   // sub-skill id (for content sections) or null
 *     confirmDetected: bool, // optional gate prompt before iterating fields
 *                            //   (true → ask "use detected? / customize / skip")
 *     fields: [            // each entry uses ship-fields.js shape:
 *       { name, label, type, options, default, description, validate? }
 *     ],
 *     summarize(cfg, detected) -> string,  // one-liner for menu row
 *   }
 *
 * Rules:
 *   - SHIP_FIELDS is re-exported (===) for id: 'ship'. Do NOT duplicate.
 *   - field.description must be one or two full sentences naming the
 *     consuming skill, what runtime behavior changes, and what the default
 *     produces. No bare labels.
 *   - Content sections (review-dimensions, pr-template, plan-guardrails,
 *     execution-guardrails, pr-labels, openspec-block) carry fields: [] and
 *     delegatedTo: '<sub-skill-id>'. The menu still surfaces purpose,
 *     filesModified, consumedBy, and state.
 *   - Sections with conditional sub-prompts that don't fit a flat field
 *     schema (commit, pr) carry fields: [] and delegatedTo:
 *     'inline-<id>-builder'. The Step 3 dispatch loop runs the existing
 *     inline logic for these; the manifest still owns purpose, filesModified,
 *     consumedBy, and the verbose header copy.
 *
 * Keep the schemas (schemas/sdlc-config.schema.json, schemas/sdlc-local.schema.json)
 * in sync with any field options added here.
 */

const { SHIP_FIELDS } = require('./ship-fields');
const { parseRemoteOwner, detectBaseBranchSafe } = require('./git');
const { WORKSPACE_FIELDS } = require('./workspace-fields');
const { resolveSdlcRoot } = require('./config');

// ---------------------------------------------------------------------------
// Section descriptors
// ---------------------------------------------------------------------------

const VERSION_FIELDS = [
  {
    name: 'mode',
    label: 'Version source mode',
    type: 'enum',
    options: ['file', 'tag'],
    default: 'file',
    description: 'Tells /version-sdlc and /ship-sdlc whether the canonical version lives in a file (`file`) or only in git tags (`tag`). The default `file` mode requires a versionFile path; pick `tag` for projects that derive every release from `git describe`.',
  },
  {
    name: 'versionFile',
    label: 'Version file path',
    type: 'string',
    options: null,
    default: 'package.json',
    description: 'Path to the file that holds the canonical version string. /version-sdlc reads and rewrites this file on each bump; setup auto-detects common paths (package.json, Cargo.toml, pyproject.toml, plugin.json) but you can override here. Ignored when mode is `tag`.',
  },
  {
    name: 'fileType',
    label: 'Version file format',
    type: 'enum',
    options: ['package.json', 'cargo.toml', 'pyproject.toml', 'pubspec.yaml', 'plugin.json', 'version-file'],
    default: 'package.json',
    description: 'Format used by /version-sdlc to parse and rewrite the version file. The default `package.json` reads the top-level `version` key; `version-file` is a plain-text file containing only the version string. Ignored when mode is `tag`.',
  },
  {
    name: 'tagPrefix',
    label: 'Git tag prefix',
    type: 'string',
    options: null,
    default: 'v',
    description: 'Prefix prepended to the version when /version-sdlc creates a release tag (e.g., prefix `v` produces `v1.2.3`). Empty string is allowed for projects that tag with bare semver. Detected from existing tags when possible.',
  },
  {
    name: 'changelog',
    label: 'Generate CHANGELOG on release?',
    type: 'boolean',
    options: ['yes', 'no'],
    default: false,
    description: 'When true, /version-sdlc and /ship-sdlc append a release entry to changelogFile (default `CHANGELOG.md`) on every bump. Default `no` keeps the workflow lean — enable if your project publishes release notes.',
  },
  {
    name: 'changelogFile',
    label: 'CHANGELOG file path',
    type: 'string',
    options: null,
    default: 'CHANGELOG.md',
    description: 'Path to the changelog file appended by /version-sdlc when changelog is enabled. Default `CHANGELOG.md` matches the conventional location at repo root. Ignored when changelog is disabled.',
  },
  {
    name: 'preRelease',
    label: 'Default pre-release label',
    type: 'string',
    options: null,
    default: '',
    description: 'When set (e.g., `rc`, `beta`, `alpha`), /version-sdlc and /ship-sdlc default to a pre-release bump (e.g., `1.2.4-rc.1`) on every default invocation until an explicit `major|minor|patch` graduates the release. Must match `^[a-z][a-z0-9]*$`; empty string omits the field and preserves stable-release behavior.',
    validate: (v) => v === '' || /^[a-z][a-z0-9]*$/.test(v),
  },
];

const JIRA_FIELDS = [
  {
    name: 'defaultProject',
    label: 'Default Jira project key',
    type: 'string',
    options: null,
    default: '',
    description: 'Project key (2–10 uppercase letters, e.g., `PROJ`) used by /jira-sdlc when no explicit project is supplied. /commit-sdlc and /pr-sdlc also use it when extracting ticket IDs from branch names. Empty string disables Jira integration for the project.',
    validate: (v) => v === '' || /^[A-Z][A-Z0-9]{1,9}$/.test(v),
  },
];

const REVIEW_FIELDS = [
  {
    name: 'scope',
    label: 'Default review scope',
    type: 'enum',
    options: ['all', 'committed', 'staged', 'working', 'worktree'],
    default: 'committed',
    description: 'Default scope for /review-sdlc when no `--committed`/`--staged`/`--working`/`--worktree` flag is passed. `committed` (default) reviews commits on the current branch vs the default branch; `working` reviews staged + unstaged; `all` includes untracked.',
  },
];

const RECEIVED_REVIEW_FIELDS = [
  {
    name: 'alwaysFixSeverities',
    label: 'Severities to auto-apply without consent',
    type: 'multi-enum',
    options: ['low', 'medium', 'high', 'critical'],
    default: [],
    description: 'Severities whose "agree, will fix" findings bypass the per-finding consent gate in /received-review-sdlc (Step 10 / Step 12). Stored in .sdlc/local.json under receivedReview.alwaysFixSeverities — per-developer, never project-wide. Default `[]` preserves the original consent-on-every-finding behavior; e.g. `["critical","high"]` auto-applies high-impact fixes without prompting.',
  },
];

// ---------------------------------------------------------------------------
// Helpers used by summarize() functions
// ---------------------------------------------------------------------------

function summarizeVersion(cfg, detected) {
  if (!cfg) {
    if (detected && detected.versionFile) {
      return `detected: ${detected.versionFile} (${detected.fileType}), tag: ${detected.tagPrefix || 'v'}`;
    }
    return '';
  }
  const parts = [];
  if (cfg.mode === 'file' && cfg.versionFile) parts.push(`file: ${cfg.versionFile}`);
  if (cfg.mode === 'tag') parts.push('mode: tag');
  if (cfg.tagPrefix != null) parts.push(`tag: ${cfg.tagPrefix}`);
  if (cfg.preRelease) parts.push(`pre: ${cfg.preRelease}`);
  return parts.join(', ');
}

function summarizeShip(cfg) {
  if (!cfg) return '';
  const parts = [];
  if (Array.isArray(cfg.steps)) parts.push(`steps: ${cfg.steps.join(',')}`);
  if (cfg.bump) parts.push(`bump: ${cfg.bump}`);
  if (cfg.workspace) parts.push(`workspace: ${cfg.workspace}`);
  // R57 tunables — render only when configured (silent when absent)
  if (cfg.verifyPipelineTimeout != null) parts.push(`verifyPipelineTimeout: ${cfg.verifyPipelineTimeout}`);
  if (cfg.verifyPipelineInterval != null) parts.push(`verifyPipelineInterval: ${cfg.verifyPipelineInterval}`);
  if (cfg.verifyPipelineMaxIterations != null) parts.push(`verifyPipelineMaxIterations: ${cfg.verifyPipelineMaxIterations}`);
  if (cfg.awaitRemoteReviewTimeout != null) parts.push(`awaitRemoteReviewTimeout: ${cfg.awaitRemoteReviewTimeout}`);
  if (cfg.awaitRemoteReviewInterval != null) parts.push(`awaitRemoteReviewInterval: ${cfg.awaitRemoteReviewInterval}`);
  if (Array.isArray(cfg.awaitRemoteReviewers) && cfg.awaitRemoteReviewers.length > 0) parts.push(`awaitRemoteReviewers: ${cfg.awaitRemoteReviewers.join(',')}`);
  return parts.join('  ');
}

function summarizeJira(cfg) {
  if (!cfg || !cfg.defaultProject) return '';
  return `project: ${cfg.defaultProject}`;
}

function summarizeReview(cfg) {
  if (!cfg || !cfg.scope) return '';
  return `scope: ${cfg.scope}`;
}

function summarizeReceivedReview(cfg) {
  if (!cfg || !Array.isArray(cfg.alwaysFixSeverities) || cfg.alwaysFixSeverities.length === 0) return '';
  return `auto-apply: ${cfg.alwaysFixSeverities.join(',')}`;
}

function summarizeCommit(cfg) {
  if (!cfg) return '';
  const parts = [];
  if (cfg.subjectPattern) {
    const trimmed = cfg.subjectPattern.length > 40
      ? cfg.subjectPattern.slice(0, 37) + '...'
      : cfg.subjectPattern;
    parts.push(`pattern: ${trimmed}`);
  }
  if (Array.isArray(cfg.allowedTypes) && cfg.allowedTypes.length > 0) {
    parts.push(`types: ${cfg.allowedTypes.length}`);
  }
  return parts.join('  ');
}

function summarizePr(cfg) {
  if (!cfg) return '';
  const parts = [];
  if (cfg.defaultBranch) {
    parts.push(`defaultBranch: ${cfg.defaultBranch}`);
  }
  if (cfg.titlePattern) {
    const trimmed = cfg.titlePattern.length > 40
      ? cfg.titlePattern.slice(0, 37) + '...'
      : cfg.titlePattern;
    parts.push(`pattern: ${trimmed}`);
  }
  return parts.join('  ');
}

function summarizePrLabels(cfg) {
  // cfg is the `pr.labels` leaf (currentCfgFor walks the configPath dot-path).
  if (!cfg || typeof cfg !== 'object') return '';
  const mode = cfg.mode;
  if (mode === 'off') return 'off — no automatic labels';
  if (mode === 'rules') {
    const n = Array.isArray(cfg.rules) ? cfg.rules.length : 0;
    return `rules: ${n} rule${n === 1 ? '' : 's'}`;
  }
  if (mode === 'llm') return 'llm — model picks labels';
  return '';
}

function summarizeReviewDimensions(_cfg, detected) {
  if (!detected) return '';
  const count = detected?.content?.reviewDimensions?.count || 0;
  return count > 0 ? `${count} installed` : '';
}

function summarizePrTemplate(_cfg, detected) {
  if (!detected) return '';
  return detected?.content?.prTemplate?.exists ? 'installed' : '';
}

function summarizePlanGuardrails(_cfg, detected) {
  if (!detected) return '';
  const count = detected?.content?.planGuardrails?.count || 0;
  return count > 0 ? `${count} configured` : '';
}

function summarizeExecutionGuardrails(_cfg, detected) {
  // execute.guardrails count — read from parsed project config when available
  if (!detected || !detected._parsedProjectConfig) return '';
  const guardrails = detected._parsedProjectConfig?.execute?.guardrails;
  if (Array.isArray(guardrails) && guardrails.length > 0) {
    return `${guardrails.length} configured`;
  }
  return '';
}

function summarizeOpenspecBlock(_cfg, detected) {
  if (!detected || !detected.openspecConfig?.exists) return '';
  const v = detected.openspecConfig.managedBlockVersion;
  if (v == null) return 'config present, no managed block';
  return `managed-block v${v}`;
}

function summarizeHooks(cfg) {
  if (!cfg || cfg.agentIsolationGuard == null) return '';
  const enabled = cfg.agentIsolationGuard?.enabled ?? true;
  return `agentIsolationGuard: ${enabled ? 'enabled' : 'disabled'}`;
}

function summarizeWorkspace(cfg) {
  if (!cfg || !cfg.worktree) return '';
  const wt = cfg.worktree;
  const parts = [];
  if (wt.layout) parts.push(`layout: ${wt.layout}`);
  if (wt.nameTemplate && wt.nameTemplate !== '{slug}') parts.push(`name: ${wt.nameTemplate}`);
  if (wt.base) parts.push(`base: ${wt.base}`);
  if (wt.template) {
    const t = wt.template.length > 30 ? wt.template.slice(0, 27) + '...' : wt.template;
    parts.push(`template: ${t}`);
  }
  return parts.join('  ');
}

// ---------------------------------------------------------------------------
// SETUP_SECTIONS — 13 entries, ordered by typical setup flow
// ---------------------------------------------------------------------------

const SETUP_SECTIONS = [
  {
    id: 'version',
    label: 'version',
    purpose: 'Tells /version-sdlc and /ship-sdlc where the canonical version string lives (a file, or only git tags) and how releases are tagged. Without this section, version bumps and release tagging fall back to defaults that may not match your project layout.',
    configFile: '.sdlc/config.json',
    configPath: 'version',
    consumedBy: ['version-sdlc', 'ship-sdlc'],
    filesModified: ['.sdlc/config.json'],
    optional: false,
    delegatedTo: null,
    confirmDetected: true,
    fields: VERSION_FIELDS,
    summarize: summarizeVersion,
  },
  {
    id: 'ship',
    label: 'ship',
    purpose: 'Developer-local pipeline preferences for /ship-sdlc: which steps run by default, default version bump, draft-PR mode, auto-approve, workspace isolation, rebase policy, and review-failure threshold. Stored in .sdlc/local.json (gitignored) so each developer can tune the pipeline without affecting teammates.',
    configFile: '.sdlc/local.json',
    configPath: 'ship',
    consumedBy: ['ship-sdlc'],
    filesModified: ['.sdlc/local.json'],
    optional: false,
    delegatedTo: null,
    confirmDetected: false,
    fields: SHIP_FIELDS,
    summarize: summarizeShip,
  },
  {
    id: 'jira',
    label: 'jira',
    purpose: 'Default Jira project key used by /jira-sdlc, /commit-sdlc, and /pr-sdlc when extracting or assigning ticket IDs. Without it, Jira-aware skills require an explicit project on every invocation; with it, branch names like `feat/PROJ-123-foo` resolve automatically.',
    configFile: '.sdlc/config.json',
    configPath: 'jira',
    consumedBy: ['jira-sdlc', 'commit-sdlc', 'pr-sdlc'],
    filesModified: ['.sdlc/config.json'],
    optional: true,
    delegatedTo: null,
    confirmDetected: false,
    fields: JIRA_FIELDS,
    summarize: summarizeJira,
  },
  {
    id: 'review',
    label: 'review',
    purpose: 'Default scope for /review-sdlc (committed/staged/working/worktree/all). Each developer typically prefers a different default — committed for PR-style review, working for in-progress feedback. Stored in .sdlc/local.json.',
    configFile: '.sdlc/local.json',
    configPath: 'review',
    consumedBy: ['review-sdlc'],
    filesModified: ['.sdlc/local.json'],
    optional: true,
    delegatedTo: null,
    confirmDetected: false,
    fields: REVIEW_FIELDS,
    summarize: summarizeReview,
  },
  {
    id: 'received-review',
    label: 'received-review',
    purpose: 'Per-user severity allowlist for /received-review-sdlc auto-apply (issue #233). When set, "agree, will fix" findings whose severity is in the list bypass the per-finding consent gate in Step 10/12 and are auto-applied with a one-line `fixed: ...` log. Stored in .sdlc/local.json under receivedReview.alwaysFixSeverities — never in project config. Default `[]` preserves the original consent-on-every-finding behavior.',
    configFile: '.sdlc/local.json',
    configPath: 'receivedReview',
    consumedBy: ['received-review-sdlc'],
    filesModified: ['.sdlc/local.json'],
    optional: true,
    delegatedTo: null,
    confirmDetected: false,
    fields: RECEIVED_REVIEW_FIELDS,
    summarize: summarizeReceivedReview,
  },
  {
    id: 'workspace',
    label: 'workspace',
    purpose: 'Developer-local worktree placement preferences for /worktree-create, /execute-plan-sdlc, and /ship-sdlc. Configures where git worktrees are placed (inside repo, sibling to repo, central store, or custom template), the name pattern, and whether .sdlc/worktrees/ is auto-added to .gitignore. Stored in .sdlc/local.json (gitignored) so each developer can choose their own worktree layout without affecting teammates.',
    configFile: '.sdlc/local.json',
    configPath: 'workspace',
    consumedBy: ['worktree-create', 'execute-plan-sdlc', 'ship-sdlc'],
    filesModified: ['.sdlc/local.json'],
    optional: true,
    delegatedTo: null,
    confirmDetected: false,
    fields: WORKSPACE_FIELDS,
    summarize: summarizeWorkspace,
  },
  {
    id: 'commit',
    label: 'commit',
    purpose: 'Commit message validation rules used by /commit-sdlc: subject regex, allowed Conventional-Commits types/scopes, types that require a body, required trailer headers. The skill enforces these patterns when generating and validating commit messages.',
    configFile: '.sdlc/config.json',
    configPath: 'commit',
    consumedBy: ['commit-sdlc'],
    filesModified: ['.sdlc/config.json'],
    optional: true,
    // Conditional sub-prompts (conventional/ticket-prefix/custom/skip with
    // per-strategy refinement) don't fit a flat field schema. The Step 3
    // dispatch loop runs the existing inline 3e logic for this section.
    delegatedTo: 'inline-commit-builder',
    confirmDetected: false,
    fields: [],
    summarize: summarizeCommit,
  },
  {
    id: 'pr',
    label: 'pr',
    purpose: 'PR title validation rules used by /pr-sdlc: title regex, allowed Conventional-Commits types/scopes, required trailers, plus expected GitHub account for active-account preflight. Mirrors commit patterns; can copy the commit config or use a different style.',
    configFile: '.sdlc/config.json',
    configPath: 'pr',
    consumedBy: ['pr-sdlc'],
    filesModified: ['.sdlc/config.json'],
    optional: true,
    // Title/labels still use the conditional inline-builder (see id: 'commit' note).
    // expectedAccount is a flat string field surfaced in the standard menu walk
    // (issue #234) — the inline-pr-builder consumes it first when present.
    delegatedTo: 'inline-pr-builder',
    confirmDetected: false,
    fields: [
      {
        name: 'defaultBranch',
        label: 'Target branch for PRs',
        type: 'string',
        options: null,
        default: detectBaseBranchSafe(resolveSdlcRoot()),
        description: 'Branch PRs are merged into. Auto-detected from the remote default branch; override for repos using develop, release/*, etc. When set, /pr-sdlc uses this value before falling back to runtime git detection (issue #339).',
      },
      {
        name: 'expectedAccount',
        label: 'Expected gh account',
        type: 'string',
        options: null,
        default: (parseRemoteOwner(resolveSdlcRoot()) || {}).owner || '',
        description: 'GitHub login expected to be active when /pr-sdlc creates a PR. /pr-sdlc halts hard if the active gh account differs from this value, preventing wrong-account PRs in multi-account setups. Default is the origin remote owner; leave blank to skip the active-account check (fall through to email-mapping or origin-owner cascade).',
      },
    ],
    summarize: summarizePr,
  },
  {
    id: 'pr-labels',
    label: 'pr-labels',
    purpose: 'PR label assignment policy used by /pr-sdlc. Mode "off" (default) adds no labels except those forced via --label. Mode "rules" evaluates user-defined rules — each rule maps one signal (branch prefix, commit type, changed-path glob, JIRA issue type, or diff size) to one repo label. Mode "llm" lets the LLM suggest labels using fuzzy matching against repo labels (legacy behavior, opt-in only).',
    configFile: '.sdlc/config.json',
    configPath: 'pr.labels',
    consumedBy: ['pr-sdlc'],
    filesModified: ['.sdlc/config.json'],
    optional: true,
    delegatedTo: 'setup-pr-labels',
    confirmDetected: false,
    fields: [],
    summarize: summarizePrLabels,
  },
  {
    id: 'review-dimensions',
    label: 'review-dimensions',
    purpose: 'Review dimensions installed under .sdlc/review-dimensions/*.yaml. Each dimension is a focused check set (security, performance, type safety, etc.) that /review-sdlc applies as a pass over the diff. Without dimensions installed, /review-sdlc has nothing to evaluate.',
    configFile: '<delegated>',
    configPath: null,
    consumedBy: ['review-sdlc'],
    filesModified: ['.sdlc/review-dimensions/*.yaml'],
    optional: true,
    delegatedTo: 'setup-dimensions',
    confirmDetected: false,
    fields: [],
    summarize: summarizeReviewDimensions,
  },
  {
    id: 'pr-template',
    label: 'pr-template',
    purpose: 'PR description template at .sdlc/pr-template.md, used by /pr-sdlc when drafting PRs. The sub-flow scans existing GitHub PR templates, recent PRs, and Jira evidence to propose a tailored template; without it, /pr-sdlc uses a built-in fallback.',
    configFile: '<delegated>',
    configPath: null,
    consumedBy: ['pr-sdlc'],
    filesModified: ['.sdlc/pr-template.md'],
    optional: true,
    delegatedTo: 'setup-pr-template',
    confirmDetected: false,
    fields: [],
    summarize: summarizePrTemplate,
  },
  {
    id: 'plan-guardrails',
    label: 'plan-guardrails',
    purpose: 'Custom rules at .sdlc/config.json#plan.guardrails evaluated by /plan-sdlc during its critique phases. Each guardrail is a natural-language constraint (e.g., "no direct DB access from controllers") that flags drift in plans before execution.',
    configFile: '.sdlc/config.json',
    configPath: 'plan.guardrails',
    consumedBy: ['plan-sdlc'],
    filesModified: ['.sdlc/config.json'],
    optional: true,
    delegatedTo: 'setup-guardrails',
    confirmDetected: false,
    fields: [],
    summarize: summarizePlanGuardrails,
  },
  {
    id: 'execution-guardrails',
    label: 'execution-guardrails',
    purpose: 'Runtime guardrails at .sdlc/config.json#execute.guardrails evaluated by /execute-plan-sdlc and /ship-sdlc before and after each wave. Error-severity violations halt execution; warning-severity violations are reported but non-blocking.',
    configFile: '.sdlc/config.json',
    configPath: 'execute.guardrails',
    consumedBy: ['execute-plan-sdlc', 'ship-sdlc'],
    filesModified: ['.sdlc/config.json'],
    optional: true,
    delegatedTo: 'setup-execution-guardrails',
    confirmDetected: false,
    fields: [],
    summarize: summarizeExecutionGuardrails,
  },
  {
    id: 'openspec-block',
    label: 'openspec-block',
    purpose: 'Managed block injected into openspec/config.yaml that supplies Lift-SDLC workflow guidance to OpenSpec-aware skills (/plan-sdlc, /execute-plan-sdlc, /ship-sdlc). Idempotent: re-running at the same plugin version is a no-op; version bumps update the block in place.',
    configFile: 'openspec/config.yaml',
    configPath: '<managed-block>',
    consumedBy: ['plan-sdlc', 'execute-plan-sdlc', 'ship-sdlc'],
    filesModified: ['openspec/config.yaml'],
    optional: true,
    delegatedTo: 'setup-openspec',
    confirmDetected: false,
    fields: [],
    summarize: summarizeOpenspecBlock,
  },
  {
    id: 'hooks',
    label: 'hooks',
    purpose: 'Developer-local plugin hook configuration. Controls whether the pre-tool-agent-isolation-guard.js PreToolUse hook blocks Agent SDK isolation: "worktree" dispatches (issues #370 #372). Stored in .sdlc/local.json (gitignored) so each developer can opt out independently without affecting teammates.',
    configFile: '.sdlc/local.json',
    configPath: 'hooks',
    consumedBy: ['execute-plan-sdlc', 'ship-sdlc'],
    filesModified: ['.sdlc/local.json'],
    optional: true,
    delegatedTo: null,
    confirmDetected: false,
    fields: [
      {
        name: 'agentIsolationGuard.enabled',
        label: 'Block Agent SDK isolation: "worktree"?',
        type: 'boolean',
        options: [true, false],
        default: true,
        description: 'When true (default, recommended), the plugin\'s pre-tool-agent-isolation-guard.js hook blocks Agent dispatches with isolation: "worktree" — prevents commits from landing in ephemeral .sdlc/worktrees/agent-<id> paths instead of the intended SDLC worktree. Set to false to opt out per-developer. See issues #370 #372.',
      },
    ],
    summarize: summarizeHooks,
  },
];

// Identity sanity check: id: 'ship' MUST re-export SHIP_FIELDS by reference,
// not by copy. Fail loudly if a future edit breaks this invariant.
const _shipEntry = SETUP_SECTIONS.find(s => s.id === 'ship');
if (_shipEntry.fields !== SHIP_FIELDS) {
  throw new Error('setup-sections.js: id=ship must re-export SHIP_FIELDS by reference (===).');
}

module.exports = { SETUP_SECTIONS };
