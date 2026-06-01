#!/usr/bin/env node
/**
 * ship-prepare.js
 * Pre-computes the entire ship-sdlc pipeline plan as structured JSON.
 * The LLM calls this once at the start of the pipeline, then follows
 * the output mechanically. Skip decisions are made by deterministic code,
 * not LLM judgment.
 *
 * Usage:
 *   node ship-prepare.js [options]
 *
 * Options:
 *   --has-plan              Plan is present in conversation context
 *   --auto                  Skip interactive approval prompts
 *   --steps <csv>           Comma-separated steps to run (overrides config)
 *   --quick                 Run ship.quick profile from config instead of ship.steps[] (R-quick-2)
 *   --quality full|balanced|minimal  Forwarded to execute-plan-sdlc as --quality (only when explicitly passed)
 *   --bump patch|minor|major  Version bump type
 *   --draft                 Mark PR as draft
 *   --dry-run               Print plan without executing
 *   --resume                Resume from last checkpoint
 *   --workspace branch|worktree|prompt  Workspace isolation mode
 *   --branch                Shortcut for --workspace branch
 *   --tree                  Shortcut for --workspace worktree
 *
 * Removed (legacy CLI sugar — passing these now produces a hard error):
 *   --preset                Use --steps <csv> instead.
 *   --skip                  Use --steps <csv> with the desired steps listed instead.
 *
 * Exit codes:
 *   0 = success, JSON on stdout
 *   1 = fatal error, JSON with non-empty errors[] on stdout
 *   2 = unexpected script crash, message on stderr
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const LIB = path.join(__dirname, '..', 'lib');

const { exec, checkGitState, detectBaseBranch, parseRemoteOwner, probeGhAuth, formatAccountMismatch, probeRepoAccess, formatAccessDenied } = require(path.join(LIB, 'git'));
const { resolveMainWorktree, detectResumeState: detectResumeStateLib, readState, slugifyBranch } = require(path.join(LIB, 'state'));
const { readSection, resolveSdlcRoot } = require(path.join(LIB, 'config'));
const { writeOutput } = require(path.join(LIB, 'output'));
const { resolveSkipConfigCheck, ensureConfigVersion } = require(path.join(LIB, 'config-version-prepare'));
const { VALID_STEPS, BUILT_IN_DEFAULTS, CANONICAL_STEPS, RESERVED_STEPS } = require(path.join(LIB, 'ship-fields'));
const { gcStateFiles, gcTempdirs } = require(path.join(LIB, 'state'));
const { detectActiveChanges, isArchived } = require(path.join(LIB, 'openspec'));
const { getAdvisory } = require(path.join(LIB, 'context-advisory'));
const { PRE_RELEASE_LABEL_RE } = require(path.join(LIB, 'version'));

const VALID_QUALITY = ['full', 'balanced', 'minimal'];

// Bump value space accepted by --bump and ship config `ship.bump`. Mirrors
// the JSON Schema pattern in `schemas/sdlc-local.schema.json` (shipSection.bump).
// The value space is the union of the three semver bump types and any
// pre-release label (forwarded verbatim to version-sdlc, where it is
// interpreted as `--bump patch --pre <label>`).
const BUMP_RE = new RegExp(`^(major|minor|patch|${PRE_RELEASE_LABEL_RE.source.slice(1, -1)})$`);

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let hasPlan = false;
  let auto = false;
  let steps = null;
  let quick = false;
  let quality = null;
  let bump = null;
  let draft = false;
  let dryRun = false;
  let resume = false;
  let workspace = null;
  let workspaceShortcut = null;
  let rebase = null;
  let openspecChange = null;
  let gc = false;
  let ttlDays = null;
  let planModeBlocked = false;
  // R-implicit-resume (#359): set by session-start.js when re-injecting the
  // "Active pipeline" reminder after /compact. ship-prepare uses this to
  // distinguish a hook-driven resume probe from a direct user invocation —
  // when no state file is found, the hook variant surfaces a structured
  // `implicitResumeNoState` error rather than silently starting fresh.
  let hookActivePipeline = false;
  // R-PLANFILE: optional path to the active plan markdown (overrides plansDirectory scan)
  let planFile = null;
  const errors = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--has-plan') {
      hasPlan = true;
    } else if (a === '--auto') {
      auto = true;
    } else if (a === '--steps' && args[i + 1]) {
      steps = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (a === '--quick') {
      quick = true;
    } else if (a === '--quality' && args[i + 1]) {
      quality = args[++i];
    } else if (a === '--preset') {
      // Hard-removed: --preset is no longer accepted (#190). Consume the
      // following value (if any) so it doesn't get parsed as a positional.
      if (args[i + 1] && !args[i + 1].startsWith('--')) i++;
      errors.push('--preset is no longer accepted by ship-sdlc. Use --steps <csv> to control which steps run, or --quality <full|balanced|minimal> to set the model tier forwarded to execute-plan-sdlc.');
    } else if (a === '--skip') {
      if (args[i + 1] && !args[i + 1].startsWith('--')) i++;
      errors.push('--skip is no longer accepted by ship-sdlc. Use --steps <csv> with the desired steps listed instead.');
    } else if (a === '--bump' && args[i + 1]) {
      bump = args[++i];
      if (!BUMP_RE.test(bump)) {
        errors.push(`--bump value '${bump}' is invalid. Expected one of: major|minor|patch, or a pre-release label matching ${PRE_RELEASE_LABEL_RE.toString()}.`);
      }
    } else if (a === '--draft') {
      draft = true;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--resume') {
      resume = true;
    } else if (a === '--workspace' && args[i + 1]) {
      workspace = args[++i];
    } else if (a === '--branch') {
      workspaceShortcut = workspaceShortcut ? 'conflict' : 'branch';
    } else if (a === '--tree') {
      workspaceShortcut = workspaceShortcut ? 'conflict' : 'worktree';
    } else if (a === '--rebase' && args[i + 1]) {
      rebase = args[++i]; // 'auto' | 'skip' | 'prompt'
    } else if (a === '--openspec-change' && args[i + 1]) {
      openspecChange = args[++i];
    } else if (a === '--gc') {
      gc = true;
    } else if (a === '--plan-mode-blocked') {
      planModeBlocked = true;
    } else if (a === '--ttl-days' && args[i + 1]) {
      const v = parseInt(args[++i], 10);
      if (isNaN(v)) {
        errors.push(`--ttl-days requires an integer, got "${args[i]}".`);
      } else {
        ttlDays = v;
      }
    } else if (a === '--plan-file' && args[i + 1]) {
      planFile = args[++i];
    } else if (a === '--hook-active-pipeline') {
      hookActivePipeline = true;
    } else if (a === '--verify-pipeline') {
      // Hard-removed (issue #130): the verify-pipeline phase is now opt-in via
      // step membership in ship.steps[] / --steps. Boolean enabler removed.
      errors.push('--verify-pipeline is no longer accepted by ship-sdlc. Add `verify-pipeline` to --steps <csv> or to ship.steps[] in .sdlc/local.json.');
    } else if (a === '--await-review') {
      // Hard-removed (issue #130): the await-remote-review phase is now opt-in
      // via step membership in ship.steps[] / --steps. Boolean enabler removed.
      errors.push('--await-review is no longer accepted by ship-sdlc. Add `await-remote-review` to --steps <csv> or to ship.steps[] in .sdlc/local.json.');
    }
  }

  if (workspaceShortcut === 'conflict') {
    errors.push('Cannot combine --branch and --tree; use only one shortcut.');
  } else if (workspaceShortcut && workspace) {
    errors.push(`Cannot combine --workspace with --${workspaceShortcut === 'branch' ? 'branch' : 'tree'}; use one or the other.`);
  } else if (workspaceShortcut) {
    workspace = workspaceShortcut;
  }

  return { hasPlan, auto, steps, quick, quality, bump, draft, dryRun, resume, workspace, rebase, openspecChange, gc, ttlDays, hookActivePipeline, planModeBlocked, planFile, errors };
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Read ship config from .sdlc/local.json if it exists, return parsed object or null.
 * @param {string} projectRoot
 * @returns {{ config: object|null, source: string }}
 */
function loadConfig(projectRoot) {
  const result = readSection(projectRoot, 'ship');
  return result
    ? { config: result, source: '.sdlc/local.json' }
    : { config: null, source: 'defaults' };
}

// ---------------------------------------------------------------------------
// Flag merging with source tracking
// ---------------------------------------------------------------------------

/**
 * Merge CLI flags > config > built-in defaults.
 * Returns merged values and a sources map tracking which source each value came from.
 */
function mergeFlags(cli, config) {
  const cfg = config || {};
  const merged = {};
  const sources = {};

  // Boolean flags: CLI true overrides; otherwise config; otherwise default.
  // For booleans, CLI "wins" only if the flag was explicitly passed (true).
  // --auto, --draft are boolean flags that default to false when not passed.
  for (const key of ['auto', 'draft']) {
    if (cli[key] === true) {
      merged[key] = true;
      sources[key] = 'cli';
    } else if (cfg[key] !== undefined) {
      merged[key] = cfg[key];
      sources[key] = 'config';
    } else {
      merged[key] = BUILT_IN_DEFAULTS[key];
      sources[key] = 'default';
    }
  }

  // Value flags
  for (const key of ['bump', 'workspace']) {
    if (cli[key] !== null && cli[key] !== undefined) {
      merged[key] = cli[key];
      sources[key] = 'cli';
    } else if (cfg[key] !== undefined) {
      merged[key] = cfg[key];
      sources[key] = 'config';
    } else {
      merged[key] = BUILT_IN_DEFAULTS[key];
      sources[key] = 'default';
    }
  }

  // -- Step resolution --
  //
  // Precedence (highest → lowest): R-quick-3
  //   1. CLI --steps (one-shot override; fully replaces resolved list)
  //   2. CLI --quick (resolves ship.quick from config; conflict with --steps
  //      is caught later by runValidation — R-quick-5)
  //   3. config.steps from .sdlc/local.json
  //   4. BUILT_IN_DEFAULTS.steps
  //
  // No --preset/--skip override paths exist (#190 — hard-removed).
  let stepsList;
  let stepsSource;
  if (Array.isArray(cli.steps) && cli.steps.length > 0) {
    stepsList = cli.steps.slice();
    stepsSource = 'cli';
  } else if (cli.quick === true) {
    // R-quick-2: resolve from ship.quick when --quick is set and --steps absent.
    // When ship.quick is unset/empty, leave stepsList empty — runValidation
    // surfaces the missing-config error (R-quick-6).
    if (Array.isArray(cfg.quick) && cfg.quick.length > 0) {
      stepsList = cfg.quick.slice();
      stepsSource = 'quick';
    } else {
      // No ship.quick configured — runValidation will error (R-quick-6).
      // stepsSource is still 'quick' here (meaning "--quick flag was used"),
      // not "a quick profile was applied". The empty stepsList + 'quick' source
      // is the sentinel runValidation uses to detect R-quick-6 (flag requested
      // but no profile configured). Consumers MUST check flags.steps.length > 0
      // before treating source 'quick' as a successfully-resolved profile.
      stepsList = [];
      stepsSource = 'quick';
    }
  } else if (Array.isArray(cfg.steps)) {
    stepsList = cfg.steps.slice();
    stepsSource = 'config';
  } else {
    stepsList = BUILT_IN_DEFAULTS.steps.slice();
    stepsSource = 'default';
  }

  merged.steps = stepsList;
  sources.steps = stepsSource;

  // -- Quality (model tier forwarded to execute-plan-sdlc) --
  //
  // Only emitted when CLI explicitly passed --quality. When absent, ship does
  // not forward the flag and execute-plan-sdlc applies its own selection
  // logic (interactive prompt or its own config default).
  if (cli.quality !== null && cli.quality !== undefined) {
    merged.quality = cli.quality;
    sources.quality = 'cli';
  }
  // Otherwise: no merged.quality / no sources.quality — intentionally absent.

  // reviewThreshold: not a CLI flag, comes from config or default.
  if (cfg.reviewThreshold !== undefined) {
    merged.reviewThreshold = cfg.reviewThreshold;
    sources.reviewThreshold = 'config';
  } else {
    merged.reviewThreshold = BUILT_IN_DEFAULTS.reviewThreshold;
    sources.reviewThreshold = 'default';
  }

  // rebase: CLI non-null string wins; otherwise map config boolean/string to
  // 'auto' | 'skip' | 'prompt'; otherwise default (true → 'auto').
  if (cli.rebase !== null && cli.rebase !== undefined) {
    merged.rebase = cli.rebase; // already a string: 'auto' | 'skip' | 'prompt'
    sources.rebase = 'cli';
  } else if (cfg.rebase !== undefined) {
    // Config may store true/false booleans or the string "prompt"
    if (cfg.rebase === true) {
      merged.rebase = 'auto';
    } else if (cfg.rebase === false) {
      merged.rebase = 'skip';
    } else {
      merged.rebase = cfg.rebase; // "prompt" or any future string value
    }
    sources.rebase = 'config';
  } else {
    // Default is true → 'auto'
    merged.rebase = 'auto';
    sources.rebase = 'default';
  }

  // -- verify-pipeline / await-remote-review tunables (R57) --
  //
  // The two phases are gated by step membership in flags.steps, not by
  // boolean flags. These tunables apply when the corresponding step is in
  // flags.steps; values come from config or fall back to the spec default.

  // verifyPipelineTimeout (integer ≥30, default from BUILT_IN_DEFAULTS)
  if (cfg.verifyPipelineTimeout !== undefined) {
    merged.verifyPipelineTimeout = cfg.verifyPipelineTimeout;
    sources.verifyPipelineTimeout = 'config';
  } else {
    merged.verifyPipelineTimeout = BUILT_IN_DEFAULTS.verifyPipelineTimeout;
    sources.verifyPipelineTimeout = 'default';
  }

  // verifyPipelineInterval (integer ≥10, default from BUILT_IN_DEFAULTS)
  if (cfg.verifyPipelineInterval !== undefined) {
    merged.verifyPipelineInterval = cfg.verifyPipelineInterval;
    sources.verifyPipelineInterval = 'config';
  } else {
    merged.verifyPipelineInterval = BUILT_IN_DEFAULTS.verifyPipelineInterval;
    sources.verifyPipelineInterval = 'default';
  }

  // verifyPipelineMaxIterations (integer 1-10, default from BUILT_IN_DEFAULTS)
  if (cfg.verifyPipelineMaxIterations !== undefined) {
    merged.verifyPipelineMaxIterations = cfg.verifyPipelineMaxIterations;
    sources.verifyPipelineMaxIterations = 'config';
  } else {
    merged.verifyPipelineMaxIterations = BUILT_IN_DEFAULTS.verifyPipelineMaxIterations;
    sources.verifyPipelineMaxIterations = 'default';
  }

  // awaitRemoteReviewTimeout (integer ≥30, default from BUILT_IN_DEFAULTS)
  if (cfg.awaitRemoteReviewTimeout !== undefined) {
    merged.awaitRemoteReviewTimeout = cfg.awaitRemoteReviewTimeout;
    sources.awaitRemoteReviewTimeout = 'config';
  } else {
    merged.awaitRemoteReviewTimeout = BUILT_IN_DEFAULTS.awaitRemoteReviewTimeout;
    sources.awaitRemoteReviewTimeout = 'default';
  }

  // awaitRemoteReviewInterval (integer ≥10, default from BUILT_IN_DEFAULTS)
  if (cfg.awaitRemoteReviewInterval !== undefined) {
    merged.awaitRemoteReviewInterval = cfg.awaitRemoteReviewInterval;
    sources.awaitRemoteReviewInterval = 'config';
  } else {
    merged.awaitRemoteReviewInterval = BUILT_IN_DEFAULTS.awaitRemoteReviewInterval;
    sources.awaitRemoteReviewInterval = 'default';
  }

  // awaitRemoteReviewers (array of strings, minItems 1, default from BUILT_IN_DEFAULTS)
  if (Array.isArray(cfg.awaitRemoteReviewers) && cfg.awaitRemoteReviewers.length > 0) {
    merged.awaitRemoteReviewers = cfg.awaitRemoteReviewers.slice();
    sources.awaitRemoteReviewers = 'config';
  } else {
    merged.awaitRemoteReviewers = BUILT_IN_DEFAULTS.awaitRemoteReviewers.slice();
    sources.awaitRemoteReviewers = 'default';
  }

  // execute.commitWaves (boolean, default false) — Fixes #392 / R35.
  // Forwarded to execute-plan-sdlc as `--commit-waves` when true. Resolved
  // here (scripts-over-llm-logic guardrail) so SKILL.md only cites
  // `step.invocation`, never raw `config.execute.commitWaves`.
  const execCfg = (cfg && cfg.execute && typeof cfg.execute === 'object') ? cfg.execute : {};
  if (execCfg.commitWaves === true) {
    merged.executeCommitWaves = true;
    sources.executeCommitWaves = 'config';
  } else if (execCfg.commitWaves === false) {
    merged.executeCommitWaves = false;
    sources.executeCommitWaves = 'config';
  } else {
    merged.executeCommitWaves = false;
    sources.executeCommitWaves = 'default';
    // Track non-boolean values so runValidation can emit a warning.
    if (execCfg.commitWaves !== undefined) {
      merged.commitWavesInvalidType = true;
    }
  }

  // Pass-through flags that don't come from config.
  merged.hasPlan = cli.hasPlan;
  merged.dryRun = cli.dryRun;
  merged.resume = cli.resume;
  merged.openspecChange = cli.openspecChange || null;
  merged.planModeBlocked = cli.planModeBlocked === true;
  // quick is already set above in step resolution; re-affirm as bool for clarity.
  merged.quick = cli.quick === true;

  return { merged, sources };
}

// ---------------------------------------------------------------------------
// Step computation
// ---------------------------------------------------------------------------

function computeSteps(flags, flagSources, { openspecContext, expectedBranch, planFile } = {}) {
  // Steps[] is the canonical source of truth for which top-level steps run.
  // A step IS skipped when it is NOT in flags.steps. The provenance for an
  // exclusion is whatever determined the resolved steps[] (cli --steps /
  // config / built-in default).
  const stepsSet = new Set(Array.isArray(flags.steps) ? flags.steps : []);

  // Derive the skipSource for a given step name. Convention preserved for
  // downstream consumers (state files, hooks, learnings).
  function skipSource(name) {
    if (stepsSet.has(name)) return 'none';
    const src = flagSources && flagSources.steps;
    if (src === 'cli') return 'cli';
    if (src === 'quick') return 'quick';  // R-quick-4: step excluded by --quick profile
    if (src === 'config') return 'config';
    return 'default';
  }

  const isIn = (name) => stepsSet.has(name);

  const steps = [
    {
      name: 'execute',
      skill: 'execute-plan-sdlc',
      model: 'gemini-3.1-pro',
      status: (!flags.hasPlan || !isIn('execute')) ? 'skipped' : 'will_run',
      skipSource: !flags.hasPlan && isIn('execute')
        ? 'none'
        : !flags.hasPlan
          ? 'condition'
          : skipSource('execute'),
      args: [
        // Forward --quality to execute-plan-sdlc only when the user
        // explicitly passed --quality to ship. Otherwise execute-plan-sdlc
        // applies its own selection logic (interactive or its own default).
        flags.quality ? `--quality ${flags.quality}` : '',
        flags.workspace !== 'prompt' ? `--workspace ${flags.workspace}` : '',
        flags.rebase !== 'prompt' ? `--rebase ${flags.rebase}` : '',
        // Forward --commit-waves when ship config sets execute.commitWaves:
        // true. Pairs with commit-sdlc's wip(execute): squash path so the
        // final feature commit subsumes per-wave WIP commits cleanly
        // (Fixes #392 / R35).
        flags.executeCommitWaves ? '--commit-waves' : '',
        // R-PLANFILE: forward resolved plan file so execute-plan-sdlc skips
        // conversation-context discovery (fragile under compaction).
        planFile ? `--plan-file "${planFile}"` : '',
      ].filter(Boolean).join(' '),
      reason: !flags.hasPlan
        ? 'no plan in context'
        : !isIn('execute')
          ? 'not in steps[]'
          : 'plan detected in context',
      pause: false,
      isolation: null,
      dispatchMode: 'agent',
    },
    {
      name: 'commit',
      skill: 'commit-sdlc',
      model: 'gemini-3.5-flash',
      status: isIn('commit') ? 'will_run' : 'skipped',
      skipSource: skipSource('commit'),
      args: [
        flags.auto ? '--auto' : '',
        expectedBranch ? `--expected-branch ${expectedBranch}` : '',
      ].filter(Boolean).join(' '),
      reason: isIn('commit') ? 'pending (will check after execute)' : 'not in steps[]',
      pause: false,
      isolation: null,
      dispatchMode: 'agent',
    },
    {
      name: 'review',
      skill: 'review-sdlc',
      model: 'gemini-3.5-flash',
      status: isIn('review') ? 'will_run' : 'skipped',
      skipSource: skipSource('review'),
      args: '--committed',
      reason: isIn('review') ? 'in steps[]' : 'not in steps[]',
      pause: false,
      isolation: null,
      dispatchMode: 'agent',
    },
    {
      name: 'received-review',
      skill: 'received-review-sdlc',
      model: 'gemini-3.5-flash',
      status: 'conditional',
      skipSource: 'none',
      args: flags.auto ? '--auto' : '',
      reason: 'triggered by review verdict (critical/high findings)',
      pause: true,
      isolation: null,
      dispatchMode: 'agent',
    },
    {
      name: 'commit-fixes',
      skill: 'commit-sdlc',
      model: 'gemini-3.5-flash',
      status: 'conditional',
      skipSource: 'none',
      args: [
        flags.auto ? '--auto' : '',
        expectedBranch ? `--expected-branch ${expectedBranch}` : '',
      ].filter(Boolean).join(' '),
      reason: 'triggered if review fixes applied',
      pause: false,
      isolation: null,
      dispatchMode: 'agent',
    },
    {
      name: 'version',
      skill: 'version-sdlc',
      model: 'gemini-3.5-flash',
      status: (!isIn('version') || flags.workspace === 'worktree') ? 'skipped' : 'will_run',
      skipSource: !isIn('version')
        ? skipSource('version')
        : flags.workspace === 'worktree'
          ? 'auto'
          : 'none',
      // R-bump-forward (#358): forward bump as the named `--bump <value>`
      // flag (NOT a positional). version-sdlc treats --bump as authoritative
      // over the positional, so this wire shape prevents silent promotion
      // when the version skill consults conventional-commit suggestions.
      args: [
        `--bump ${flags.bump || 'patch'}`,
        flags.auto ? '--auto' : '',
        expectedBranch ? `--expected-branch ${expectedBranch}` : '',
      ].filter(Boolean).join(' '),
      reason: !isIn('version')
        ? 'not in steps[]'
        : flags.workspace === 'worktree'
          ? 'auto-skipped — tags are repo-global, not safe from worktrees'
          : 'in steps[]',
      pause: true,
      isolation: null,
      dispatchMode: 'agent',
    },
    // archive-openspec: conditional step between version and pr
    (() => {
      const oc = openspecContext || {};
      const changeName = flags.openspecChange || oc.branchMatch || null;
      const archiveActionable = changeName && !oc.isAlreadyArchived;

      if (!isIn('archive-openspec')) {
        return {
          name: 'archive-openspec',
          skill: null,
          model: 'gemini-3.5-flash',
          status: 'skipped',
          skipSource: skipSource('archive-openspec'),
          args: '',
          reason: 'not in steps[]',
          pause: false,
          isolation: null,
          dispatchMode: null,
        };
      }
      if (!archiveActionable) {
        return {
          name: 'archive-openspec',
          skill: null,
          model: 'gemini-3.5-flash',
          status: 'skipped',
          skipSource: 'condition',
          args: '',
          reason: !changeName
            ? 'no matching openspec change for current branch'
            : 'change already archived',
          pause: false,
          isolation: null,
          dispatchMode: null,
        };
      }
      return {
        name: 'archive-openspec',
        skill: null,
        model: 'gemini-3.5-flash',
        status: 'conditional',
        skipSource: 'none',
        args: `--change ${changeName}${flags.auto ? ' --auto' : ''}`,
        reason: `openspec change "${changeName}" ready for archive`,
        pause: !flags.auto,
        isolation: null,
        dispatchMode: null,
      };
    })(),
    {
      name: 'pr',
      skill: 'pr-sdlc',
      model: 'gemini-3.5-flash',
      status: isIn('pr') ? 'will_run' : 'skipped',
      skipSource: skipSource('pr'),
      args: [
        flags.auto ? '--auto' : '',
        flags.draft ? '--draft' : '',
        flags.workspace === 'worktree' ? '--label skip-version-check' : '',
        expectedBranch ? `--expected-branch ${expectedBranch}` : '',
      ].filter(Boolean).join(' '),
      reason: !isIn('pr')
        ? 'not in steps[]'
        : flags.workspace === 'worktree'
          ? 'in steps[]; --label skip-version-check added (version auto-skipped)'
          : 'in steps[]',
      pause: false,
      isolation: null,
      dispatchMode: 'agent',
    },
    // R41-R49: verify-pipeline — opt-in inline-execution step (skill: null,
    // dispatched by ship-sdlc/SKILL.md which parses the JSON verdict). Gated
    // by step membership in flags.steps; auto-skipped when 'pr' is excluded
    // from flags.steps (cannot poll a PR that does not exist).
    (() => {
      if (!isIn('verify-pipeline')) {
        return {
          name: 'verify-pipeline',
          skill: null,
          model: null,
          status: 'skipped',
          skipSource: skipSource('verify-pipeline'),
          args: '',
          reason: 'not in steps[]',
          pause: false,
          isolation: null,
          dispatchMode: null,
        };
      }
      if (!isIn('pr')) {
        return {
          name: 'verify-pipeline',
          skill: null,
          model: null,
          status: 'skipped',
          skipSource: 'condition',
          args: '',
          reason: 'pr step excluded — cannot verify CI for a non-existent PR',
          pause: false,
          isolation: null,
          dispatchMode: null,
        };
      }
      return {
        name: 'verify-pipeline',
        skill: null,
        model: null,
        status: 'will_run',
        skipSource: 'none',
        args: `--timeout ${flags.verifyPipelineTimeout} --interval ${flags.verifyPipelineInterval}`,
        reason: 'verify CI checks before await-remote-review',
        pause: true,
        isolation: null,
        dispatchMode: null,
      };
    })(),
    // R50-R56: await-remote-review — opt-in inline-execution step. Gated by
    // step membership in flags.steps; auto-skipped when 'pr' is excluded from
    // flags.steps.
    (() => {
      if (!isIn('await-remote-review')) {
        return {
          name: 'await-remote-review',
          skill: null,
          model: null,
          status: 'skipped',
          skipSource: skipSource('await-remote-review'),
          args: '',
          reason: 'not in steps[]',
          pause: false,
          isolation: null,
          dispatchMode: null,
        };
      }
      if (!isIn('pr')) {
        return {
          name: 'await-remote-review',
          skill: null,
          model: null,
          status: 'skipped',
          skipSource: 'condition',
          args: '',
          reason: 'pr step excluded — cannot await review on a non-existent PR',
          pause: false,
          isolation: null,
          dispatchMode: null,
        };
      }
      return {
        name: 'await-remote-review',
        skill: null,
        model: null,
        status: 'will_run',
        skipSource: 'none',
        args: `--timeout ${flags.awaitRemoteReviewTimeout} --interval ${flags.awaitRemoteReviewInterval} --reviewers ${flags.awaitRemoteReviewers.join(',')}`,
        reason: 'await automated reviewer (e.g., Copilot)',
        pause: false,
        isolation: null,
        dispatchMode: null,
      };
    })(),
    {
      name: 'learnings-commit',
      // No dispatched skill — this is a deterministic shell step the
      // orchestrator runs inline (see ship-sdlc SKILL.md). The model field
      // is unused but kept for table-rendering consistency.
      skill: null,
      model: 'gemini-3.5-flash',
      status: isIn('learnings-commit') ? 'will_run' : 'skipped',
      skipSource: skipSource('learnings-commit'),
      args: '',
      reason: isIn('learnings-commit')
        ? 'final step — appends pipeline learnings and commits if changed'
        : 'not in steps[]',
      pause: false,
      isolation: null,
      dispatchMode: null,
    },
  ];

  for (const step of steps) {
    step.invocation = step.args
      ? `skill: "${step.skill}", args: "${step.args}"`
      : `skill: "${step.skill}"`;
  }

  // Append synthetic terminal `cleanup` step (R38, issue #223). NOT user-
  // configurable — appended unconditionally on every pipeline run. The skill
  // field is null (dispatched as a direct Bash call, not as an Agent). Two
  // command variants are emitted; SKILL.md selects `forced` when any prior
  // step has status: "failed", `normal` otherwise.
  //
  // The path resolution is deferred to the skill (find ~/.claude/plugins +
  // fallback to plugins/sdlc-utilities/scripts/state/ship.js) — same pattern
  // as every other state-script invocation in SKILL.md. We pass the script
  // path placeholder `<state-ship>` here for documentation; the skill
  // substitutes `$SCRIPT` at runtime.
  steps.push({
    name: 'cleanup',
    skill: null,
    model: 'gemini-3.5-flash',
    status: 'will_run',
    skipSource: 'none',
    args: '',
    reason: 'terminal cleanup — pipeline contract validation, current-run state delete, GC sweep',
    pause: false,
    invocation: {
      method: 'bash',
      // SKILL.md selects one of these. `normal` runs the contract check and
      // current-run delete; `forced` skips both and only sweeps stale orphans.
      normal: `node "$SCRIPT" cleanup-pipeline`,
      forced: `node "$SCRIPT" cleanup-pipeline --force`,
    },
    reserved: true,
    isolation: null,
    dispatchMode: null,
  });

  return steps;
}

// ---------------------------------------------------------------------------
// Worktree detection
// ---------------------------------------------------------------------------

/**
 * Detect whether the current process is running inside a linked (non-main) git worktree.
 * @param {string} projectRoot  The working directory to inspect (typically process.cwd())
 * @returns {{
 *   inLinkedWorktree: boolean,
 *   currentPath: string|null,
 *   mainWorktreePath: string
 * }}
 */
function detectWorktree(projectRoot) {
  let mainPath;
  try {
    mainPath = resolveMainWorktree();
  } catch (_) {
    // If git worktree list fails (e.g. very old git), assume we are in the main worktree.
    const cwd = fs.realpathSync(projectRoot);
    return { inLinkedWorktree: false, currentPath: null, mainWorktreePath: cwd };
  }

  const cwd = fs.realpathSync(projectRoot);
  const mainResolved = fs.realpathSync(mainPath);

  return {
    inLinkedWorktree: cwd !== mainResolved,
    currentPath: cwd !== mainResolved ? cwd : null,
    mainWorktreePath: mainResolved,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function runValidation(flags, flagSources, steps, context) {
  const errors = [];
  const warnings = [];

  // gh auth must be true (issue #234 — preflight via lib/git.js::probeGhAuth).
  if (!context.ghAuthenticated) {
    errors.push(
      context.ghAuthErrorMessage ||
      'GitHub CLI is not authenticated. Run "gh auth login" before using ship-sdlc.'
    );
  }

  // Active-account preflight — halt on identity mismatch with the canonical 3-line message.
  if (context.accountMismatch && context.accountMismatchMessage) {
    errors.push(context.accountMismatchMessage);
  }

  // Access-mode preflight — halt when the active account is definitively denied (404/403).
  if (context.accessDeniedMessage) {
    errors.push(context.accessDeniedMessage);
  }

  // Current branch should not equal base branch
  const notOnDefault = context.currentBranch !== context.defaultBranch;
  if (!notOnDefault) {
    warnings.push(`You are on the default branch "${context.defaultBranch}". Ship pipelines should run on feature branches.`);
  }

  // All steps[] values must be recognized; CLI --steps unrecognized values
  // are errors (the user passed something invalid). Config-sourced unknowns
  // remain warnings to avoid breaking pre-existing configs that drift.
  let stepValuesRecognized = true;
  if (Array.isArray(flags.steps)) {
    for (const s of flags.steps) {
      // Reserved steps (e.g. `cleanup`) are appended unconditionally by
      // computeSteps. Listing them in --steps or ship.steps[] is a config
      // bug — always an error regardless of source.
      if (RESERVED_STEPS.includes(s)) {
        errors.push(`"${s}" is a reserved terminal step appended automatically by the pipeline. Remove it from --steps and ship.steps[].`);
        stepValuesRecognized = false;
        continue;
      }
      if (!VALID_STEPS.includes(s)) {
        if (flagSources.steps === 'cli') {
          errors.push(`Unrecognized step "${s}" in --steps. Valid values: ${VALID_STEPS.join(', ')}`);
          stepValuesRecognized = false;
        } else {
          warnings.push(`Unrecognized step "${s}" in steps[]. Valid values: ${VALID_STEPS.join(', ')}`);
        }
      }
    }
  }

  // Validate --quality value when forwarded
  if (flags.quality !== undefined && !VALID_QUALITY.includes(flags.quality)) {
    errors.push(`Invalid --quality "${flags.quality}". Valid values: ${VALID_QUALITY.join(', ')}`);
  }

  // At least one non-conditional step must run (conditional steps only
  // fire in response to other steps, so they don't count on their own)
  const atLeastOneStepRuns = steps.some(s => s.status === 'will_run');
  if (!atLeastOneStepRuns) {
    errors.push('All steps are skipped. At least one step must run.');
  }

  // --bump without version step (only error when user explicitly set bump on
  // the CLI — config-level/default bump is just a no-op when version is
  // excluded from steps[]).
  let coherentFlags = true;
  const versionStep = steps.find(s => s.name === 'version');
  if (flags.bump && flagSources.bump === 'cli' && versionStep && versionStep.status === 'skipped') {
    errors.push(`--bump "${flags.bump}" specified but version step is skipped — resolve by removing --bump or adding "version" to ship.steps[].`);
    coherentFlags = false;
  }

  // R-quick-5: --quick combined with --steps is a hard error.
  if (flags.quick && flagSources.steps === 'cli') {
    errors.push('--quick + --steps not allowed: use --quick or --steps, not both');
  }

  // R-quick-6: --quick invoked with no ship.quick configured is a hard error.
  if (flags.quick && flagSources.steps === 'quick' && flags.steps.length === 0) {
    errors.push('No quick profile defined. Run `ship-sdlc --init-config` to set one.');
  }

  // execute.commitWaves must be a boolean; non-boolean values are silently
  // treated as false — warn the user so they can correct the config.
  if (flags.commitWavesInvalidType) {
    warnings.push('execute.commitWaves in ship config is not a boolean — value ignored, defaulting to false. Set it to true or false explicitly.');
  }

  // Always note conditional pause
  warnings.push('If review finds critical/high issues, pipeline will pause for fix approval');

  return {
    ghAuth: context.ghAuthenticated,
    notOnDefault,
    stepValuesRecognized,
    atLeastOneStepRuns,
    coherentFlags,
    warnings,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Resume state detection
// ---------------------------------------------------------------------------

/**
 * Look for the most recent ship state file matching the current branch.
 *
 * Thin wrapper over `lib/state.js::detectResumeState` — see issue #284,
 * task 19. The selection rule (slugify branch, pick newest mtime) is
 * canonical there; this wrapper preserves the historical
 * `(projectRoot, currentBranch)` call signature and the
 * `{stateFile, found}` return shape that ship.js's caller depends on.
 *
 * @param {string} _projectRoot  Unused; kept for call-site compatibility.
 *                                State directory is resolved via
 *                                `resolveStateDir()` (main worktree) inside
 *                                the canonical helper.
 * @param {string} currentBranch
 * @returns {{ stateFile: string|null, found: boolean }}
 */
function detectResumeState(_projectRoot, currentBranch) {
  const { stateFile, found, fresh, nextPendingStep, fullPath } = detectResumeStateLib({
    prefix: 'ship',
    branch: currentBranch,
  });
  // Forward fresh / nextPendingStep / fullPath for R-implicit-resume (#359).
  return { stateFile, found, fresh, nextPendingStep, fullPath };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const projectRoot = resolveSdlcRoot(); // issue #351: route to main worktree .sdlc/
  const cli = parseArgs(process.argv);

  const errors = [];
  const warnings = [];

  // Surface argument-parsing errors first (legacy --preset/--skip rejection).
  if (Array.isArray(cli.errors) && cli.errors.length > 0) {
    errors.push(...cli.errors);
  }

  // Issue #232: verifyAndMigrate at pipeline entry. On success, export
  // SDLC_SKIP_CONFIG_CHECK=1 so every subsequent Bash invocation in the
  // pipeline (including `node scripts/skill/<sub>.js`) inherits the env var
  // and short-circuits its own per-skill check.
  const skipConfigCheck = resolveSkipConfigCheck(process.argv);
  const cv = ensureConfigVersion(projectRoot, { skip: skipConfigCheck, roles: ['project', 'local'] });
  let migrationManifest = { ...(cv.migration || {}), infrastructure: cv.infrastructure };
  if (cv.errors.length > 0) {
    for (const e of cv.errors) errors.push(`config-version: ${e.role}: ${e.message}`);
    writeOutput({
      errors,
      warnings,
      flags: { skipConfigCheck },
      migration: migrationManifest,
    }, 'ship-prepare', 1);
    return;
  }
  // Set the env var so child processes inherit it. Avoid clobbering a
  // pre-existing value (e.g., a parent shipped already set it).
  if (!skipConfigCheck && process.env.SDLC_SKIP_CONFIG_CHECK !== '1') {
    process.env.SDLC_SKIP_CONFIG_CHECK = '1';
  }

  // --gc short-circuit (R39): on-demand pruning. Skip pipeline composition
  // entirely. Emit {action: "gc", report, errors, warnings} and exit.
  if (cli.gc) {
    if (errors.length > 0) {
      writeOutput({ action: 'gc', errors, warnings }, 'ship-prepare', 1);
      return;
    }

    // TTL resolution: CLI --ttl-days > config state.gc.ttlDays > 7.
    let ttlDays = (typeof cli.ttlDays === 'number') ? cli.ttlDays : null;
    if (ttlDays == null) {
      try {
        const stateCfg = readSection(projectRoot, 'state');
        const v = stateCfg && stateCfg.gc && stateCfg.gc.ttlDays;
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
          ttlDays = v;
        }
      } catch (_) { /* fall through */ }
    }
    if (ttlDays == null) ttlDays = 7;

    // Build knownBranches from local git
    let knownBranches = [];
    const out = exec("git branch --list --format='%(refname:short)'", { cwd: process.cwd(), shell: true });
    if (typeof out === 'string') {
      knownBranches = out.split('\n').map(s => s.trim()).filter(Boolean);
    }

    let report;
    try {
      const ship = gcStateFiles({ prefix: 'ship', ttlDays, knownBranches });
      const execute = gcStateFiles({ prefix: 'execute', ttlDays, knownBranches });
      const plan = gcStateFiles({ prefix: 'plan', ttlDays, knownBranches });
      const commit = gcStateFiles({ prefix: 'commit', ttlDays, knownBranches });
      // Sweep per-invocation tempdirs created by plan-explore.js (issue #408)
      // SDLC_EXPLORE_TMPDIR_OVERRIDE allows tests to point at a controlled directory.
      const exploreTmpdir = process.env.SDLC_EXPLORE_TMPDIR_OVERRIDE || undefined;
      const exploreTempdirs = gcTempdirs({ prefix: 'sdlc-explore-', ttlDays, knownBranches, tmpdir: exploreTmpdir });
      report = { ttlDays, ship, execute, plan, commit, exploreTempdirs };
    } catch (err) {
      errors.push(`gc failed: ${err.message}`);
      writeOutput({ action: 'gc', errors, warnings }, 'ship-prepare', 1);
      return;
    }

    writeOutput({ action: 'gc', report, errors, warnings }, 'ship-prepare', 0);
    return;
  }

  // Load config
  const { config: fileConfig, source: configSource } = loadConfig(projectRoot);

  // Merge flags
  const { merged: flags, sources: flagSources } = mergeFlags(cli, fileConfig);

  // #394: When version.preRelease is set in .sdlc/config.json AND the user did
  // NOT explicitly pass --bump on the CLI, forward the pre-release label as
  // --bump <label> (sugar for patch + --pre <label> in version-sdlc) so ship
  // pipelines produce pre-release tags. Explicit CLI --bump graduates out of
  // the train (version-sdlc R16). See ship-sdlc spec R63.
  const versionCfg = readSection(projectRoot, 'version') || {};
  if (
    typeof versionCfg.preRelease === 'string' &&
    versionCfg.preRelease.length > 0 &&
    PRE_RELEASE_LABEL_RE.test(versionCfg.preRelease) &&
    flagSources.bump !== 'cli'
  ) {
    flags.bump = versionCfg.preRelease;
    flagSources.bump = 'config (version.preRelease)';
  }

  // Auto mode: override workspace default/config from 'prompt' to 'branch'
  if (flags.auto && flags.workspace === 'prompt' && flagSources.workspace !== 'cli') {
    flags.workspace = 'branch';
    flagSources.workspace = `${flagSources.workspace} (auto)`;
  }

  // Check git state
  let gitState;
  try {
    gitState = checkGitState(process.cwd());
  } catch (err) {
    errors.push(err.message);
    writeOutput({ errors, warnings }, 'ship-prepare', 1);
    return;
  }

  // plan-mode-blocked short-circuit (R64, fixes #400)
  // When SKILL.md detects plan mode active, it invokes ship.js with --plan-mode-blocked
  // to persist pipeline init state so the next /ship-sdlc invocation can auto-resume.
  if (flags.planModeBlocked) {
    const stateShipPath = path.join(__dirname, '..', 'state', 'ship.js');
    const flagsJson = JSON.stringify(flags);
    const currentBranch = gitState.currentBranch;
    const result = spawnSync('node', [
      stateShipPath, 'init',
      '--branch', currentBranch,
      '--flags', flagsJson,
    ], { encoding: 'utf8', timeout: 10000 });
    if (result.error) {
      process.stderr.write(`state/ship.js init timed out or crashed: ${result.error.message}\n`);
      process.exit(1);
    }
    if (result.status !== 0) {
      process.stderr.write(result.stderr || 'state/ship.js init failed\n');
      process.exit(result.status || 1);
    }
    const { filePath, prunedOrphans } = JSON.parse(result.stdout);
    writeOutput({
      flags: { ...flags, planModeBlocked: true },
      stateFile: filePath,
      prunedOrphans,
      planModeBlocked: true,
    }, 'ship-prepare', 0);
    return;
  }

  // Detect base branch
  let defaultBranch;
  try {
    defaultBranch = detectBaseBranch(projectRoot);
  } catch (err) {
    errors.push(err.message);
    writeOutput({ errors, warnings }, 'ship-prepare', 1);
    return;
  }

  // Check gh auth + active-account preflight (issue #234, fixes #380, shared with pr.js).
  // Two-mode cascade:
  //   Identity mode  (prConfig.expectedAccount set): strict login comparison.
  //   Access mode    (prConfig.expectedAccount unset): probe repo accessibility via gh api.
  // Halt on no-auth, expired-token, identity mismatch, or definitive probe denial (404/403).
  // Network failure in probe warns and proceeds (non-blocking).
  const ghAuthState = probeGhAuth();
  const ghAuthenticated = ghAuthState.authenticated;
  const ghUser = ghAuthState.activeAccount;
  const ghAuthExpired = ghAuthState.expired;
  const ghAuthErrorMessage = ghAuthState.errorMessage;

  // Resolve expectedAccount: prConfig.expectedAccount only (no origin-owner fallback).
  const prConfigForAuth = readSection(projectRoot, 'pr') || {};
  const remoteForAuth = parseRemoteOwner(projectRoot);
  const expectedAccount =
    (typeof prConfigForAuth.expectedAccount === 'string' && prConfigForAuth.expectedAccount.trim()) ||
    null;

  // Default values for the new probe-output fields — overwritten below when the probe runs.
  let repoAccessProbed = false;
  let repoAccessible = null;
  let repoAccessStatus = null;

  // Mismatch detection — only when authenticated + we resolved an expected account.
  const accountMismatch = Boolean(
    ghAuthenticated && expectedAccount && ghUser && ghUser.toLowerCase() !== expectedAccount.toLowerCase()
  );
  const accountMismatchMessage = accountMismatch
    ? formatAccountMismatch(expectedAccount, ghUser)
    : null;

  // Access-mode: no explicit expectedAccount — probe repo accessibility instead.
  let accessDeniedMessage = null;
  if (ghAuthenticated && !expectedAccount && remoteForAuth) {
    const probeResult = probeRepoAccess({
      owner: remoteForAuth.owner,
      repo: remoteForAuth.repo,
      host: remoteForAuth.host,
    });
    repoAccessProbed = true;
    repoAccessible = probeResult.accessible;
    repoAccessStatus = probeResult.statusCode;

    if (probeResult.accessible === false) {
      accessDeniedMessage = formatAccessDenied({
        activeAccount: ghUser,
        owner: remoteForAuth.owner,
        repo: remoteForAuth.repo,
        suggestedAccounts: probeResult.suggestedAccounts,
      });
    } else if (probeResult.accessible === null) {
      warnings.push(
        `Repo access probe failed (${probeResult.errorMessage || 'network error'}) — proceeding without access verification.`
      );
    }
  }

  // Check OpenSpec (use shared lib for consistent detection)
  const openspecResult = detectActiveChanges(projectRoot);
  const openspecDetected = openspecResult.present;
  const openspecAuthoritative = openspecResult.present
    ? { path: 'openspec/config.yaml', specsCount: openspecResult.specsCount }
    : null;

  // Check .sdlc/ gitignore status
  // git check-ignore returns non-null (empty string) if ignored, null if not ignored.
  // Also detect .sdlc/.gitignore (self-ignoring pattern created by setup-sdlc).
  const sdlcGitignored =
    exec('git check-ignore -q .sdlc/', { cwd: projectRoot }) !== null ||
    fs.existsSync(path.join(projectRoot, '.sdlc', '.gitignore'));

  // Detect worktree context
  const worktreeInfo = detectWorktree(projectRoot);

  // Compute openspec archive actionability
  const openspecBranchMatch = openspecResult.branchMatch || null;
  const openspecChangeName = flags.openspecChange || openspecBranchMatch;
  const openspecIsArchived = openspecChangeName
    ? isArchived(projectRoot, openspecChangeName)
    : false;

  // R-expected-branch-injection (issues #347, #348, #349): resolve the feature branch
  // that commit/version/pr sub-skills should operate on.
  // Preferred source: state.data.branch from the current ship state file (set by cmdInit).
  // Fallback: gitState.currentBranch (e.g., first-run before init or --workspace continue).
  let expectedBranch = gitState.currentBranch;
  try {
    const slug = slugifyBranch(gitState.currentBranch);
    const shipState = readState('ship', slug);
    if (shipState && shipState.data && typeof shipState.data.branch === 'string' && shipState.data.branch) {
      expectedBranch = shipState.data.branch;
    }
  } catch (_) {
    // Non-fatal: fall back to currentBranch already set above
  }

  // Build context
  // R-PLANFILE: resolve the active plan file path for execute-step task mirroring.
  // Priority: (1) CLI --plan-file flag, (2) project .claude/settings.json plansDirectory,
  // (3) global ~/.claude/settings.json plansDirectory, (4) default ~/.gemini/plans/ (most recent *.md).
  // Returns absolute path string or null if no plan file can be found.
  function resolvePlanFile(cliPlanFile) {
    if (cliPlanFile) {
      return path.resolve(cliPlanFile);
    }

    const candidateDirs = [];

    // Project settings (takes precedence)
    const projectSettings = path.join(projectRoot, '.claude', 'settings.json');
    if (fs.existsSync(projectSettings)) {
      try {
        const s = JSON.parse(fs.readFileSync(projectSettings, 'utf8'));
        if (s.plansDirectory) candidateDirs.push(s.plansDirectory);
      } catch (_) { /* ignore */ }
    }

    // Global settings
    const globalSettings = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(globalSettings)) {
      try {
        const s = JSON.parse(fs.readFileSync(globalSettings, 'utf8'));
        if (s.plansDirectory) candidateDirs.push(s.plansDirectory);
      } catch (_) { /* ignore */ }
    }

    // Default fallback
    candidateDirs.push(path.join(os.homedir(), '.claude', 'plans'));

    for (const dir of candidateDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const entries = fs.readdirSync(dir)
          .filter(f => f.endsWith('.md'))
          .map(f => {
            try {
              const stat = fs.statSync(path.join(dir, f));
              return { name: f, mtime: stat.mtimeMs };
            } catch (_) { return null; }
          })
          .filter(Boolean)
          .sort((a, b) => b.mtime - a.mtime);
        if (entries.length > 0) {
          return path.join(dir, entries[0].name);
        }
      } catch (_) { continue; }
    }

    return null;
  }

  const planFile = resolvePlanFile(cli.planFile || null);

  const context = {
    currentBranch: gitState.currentBranch,
    defaultBranch,
    uncommittedChanges: gitState.dirtyFiles.length,
    dirtyFiles: gitState.dirtyFiles,
    ghAuthenticated,
    ghUser,
    ghAuthExpired,
    ghAuthErrorMessage,
    expectedAccount,
    accountMismatch,
    accountMismatchMessage,
    repoAccessProbed,
    repoAccessible,
    repoAccessStatus,
    accessDeniedMessage,
    openspecDetected,
    openspecAuthoritative,
    openspecBranchMatch,
    openspecArchiveActionable: !!(openspecChangeName && !openspecIsArchived),
    sdlcGitignored,
    worktree: worktreeInfo,
    expectedBranch,
    planFile,
  };

  // Compute steps (pass openspec context for archive-openspec step)
  const openspecContext = {
    branchMatch: openspecBranchMatch,
    isAlreadyArchived: openspecIsArchived,
  };
  const steps = computeSteps(flags, flagSources, { openspecContext, expectedBranch, planFile });

  // Run validation
  const validation = runValidation(flags, flagSources, steps, context);

  // Collect validation errors/warnings into top-level arrays
  errors.push(...validation.errors);
  warnings.push(...validation.warnings);

  // Detect resume state
  const resume = detectResumeState(projectRoot, gitState.currentBranch);

  // R-implicit-resume (#359): when a fresh state file exists for the current
  // branch AND the user did NOT explicitly pass --resume, flip the resume
  // flag implicitly so a post-/compact session continues the same pipeline.
  // The implicitResume marker lets SKILL.md / state lifecycle distinguish
  // this from an explicit --resume request.
  let implicitResume = false;
  if (resume && resume.found && resume.fresh && !cli.resume) {
    implicitResume = true;
    flags.resume = true;
    flagSources.resume = 'implicit';
  }
  flags.implicitResume = implicitResume;

  // R-implicit-resume (#359): when session-start.js dispatches ship with
  // --hook-active-pipeline (it rendered an "Active pipeline" reminder) but
  // no state file is present for the current branch, surface a structured
  // error so the orchestrator can prompt rather than silently start fresh.
  if (cli.hookActivePipeline && (!resume || !resume.found)) {
    errors.push({
      id: 'implicitResumeNoState',
      message:
        'Active pipeline reminder found but no state file for current branch. ' +
        'Run with --resume <path> or start fresh.',
    });
  }

  // Context-heaviness advisory (implements R35) — sourced from the sidecar
  // written by hooks/context-stats.js on UserPromptSubmit. Returns null when
  // the sidecar is missing, malformed, or transcript is below the heavy
  // threshold. Surfaced verbatim by SKILL.md Step 1c when non-null.
  const contextAdvisory = getAdvisory({ skill: 'ship-sdlc' });

  // R65 (#405): cwd-assertion diagnostic. When workspace mode is `branch` AND
  // the pipeline is NOT resuming, surface the expected main worktree root so
  // SKILL.md can compare against `git rev-parse --show-toplevel` BEFORE
  // dispatching execute. The check is diagnostic — it aborts the pipeline
  // when ship-sdlc was launched from inside a linked worktree under a
  // `workspace: branch` configuration (real failure mode observed in #405).
  // For `worktree` or `continue`, the field is `false` (a stale linked
  // worktree is irrelevant under those modes).
  let assertions = { requireMainWorktreeCwd: false, expectedMainWorktreeRoot: null };
  const notResuming = !(flags.resume === true || flags.implicitResume === true);
  if (flags.workspace === 'branch' && notResuming) {
    let mainWorktreeRoot = null;
    try {
      const wtList = exec('git worktree list --porcelain', { cwd: process.cwd() }) || '';
      const firstLine = wtList.split('\n').find(l => l.startsWith('worktree '));
      if (firstLine) mainWorktreeRoot = firstLine.slice('worktree '.length).trim();
    } catch (err) {
      // SKILL.md treats null mainWorktreeRoot as "no assertion". Emit a hint
      // to stderr so the silent degradation is at least observable.
      process.stderr.write(`ship-prepare: worktree-list probe failed (${err.message}) — cwd assertion degraded to no-op.\n`);
    }
    if (mainWorktreeRoot) {
      assertions = { requireMainWorktreeCwd: true, expectedMainWorktreeRoot: mainWorktreeRoot };
    }
  }

  // Build config values for output
  const configValues = {};
  for (const key of Object.keys(BUILT_IN_DEFAULTS)) {
    configValues[key] = flags[key] !== undefined ? flags[key] : BUILT_IN_DEFAULTS[key];
  }

  const result = {
    errors,
    warnings,
    config: {
      source: configSource,
      values: configValues,
    },
    flags: {
      auto: flags.auto,
      steps: flags.steps,
      // quality is included only when explicitly passed via CLI (forwarded to
      // execute-plan-sdlc as --quality); absent otherwise so downstream
      // consumers can rely on `flags.quality === undefined` to detect "user
      // did not specify".
      ...(flags.quality !== undefined ? { quality: flags.quality } : {}),
      bump: flags.bump,
      draft: flags.draft,
      dryRun: flags.dryRun,
      resume: flags.resume,
      // R-implicit-resume (#359): true when the resume flag was flipped on
      // by ship-prepare because a fresh state file existed for the current
      // branch and the user did not pass --resume explicitly.
      implicitResume: flags.implicitResume === true,
      hasPlan: flags.hasPlan,
      workspace: flags.workspace,
      rebase: flags.rebase,
      openspecChange: flags.openspecChange,
      // R57: post-PR CI verification + await-remote-review tunables
      // (gating is via step membership in flags.steps, not boolean flags)
      verifyPipelineTimeout: flags.verifyPipelineTimeout,
      verifyPipelineInterval: flags.verifyPipelineInterval,
      verifyPipelineMaxIterations: flags.verifyPipelineMaxIterations,
      awaitRemoteReviewTimeout: flags.awaitRemoteReviewTimeout,
      awaitRemoteReviewInterval: flags.awaitRemoteReviewInterval,
      awaitRemoteReviewers: flags.awaitRemoteReviewers,
      // Fixes #392 / R35: execute.commitWaves resolved at config-merge time;
      // forwarded as --commit-waves to the execute step's invocation (see
      // computeSteps). Surfaced here so downstream consumers can introspect
      // the resolution without parsing step args.
      executeCommitWaves: flags.executeCommitWaves === true,
      planModeBlocked: flags.planModeBlocked || false,
      skipConfigCheck,
      sources: flagSources,
    },
    migration: migrationManifest,
    context,
    steps,
    validation: {
      ghAuth: validation.ghAuth,
      notOnDefault: validation.notOnDefault,
      stepValuesRecognized: validation.stepValuesRecognized,
      atLeastOneStepRuns: validation.atLeastOneStepRuns,
      coherentFlags: validation.coherentFlags,
      warnings: validation.warnings,
    },
    resume,
    contextAdvisory,
    // R65 (#405): cwd-assertion diagnostic emitted to SKILL.md.
    assertions,
  };

  // Exit with 1 if there are fatal errors, 0 otherwise
  const exitCode = errors.length > 0 ? 1 : 0;
  writeOutput(result, 'ship-prepare', exitCode);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`ship-prepare.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, computeSteps, mergeFlags, loadConfig, detectWorktree };
