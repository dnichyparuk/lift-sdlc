#!/usr/bin/env node
/**
 * ship-init.js
 * Deterministically creates the .sdlc/ directory structure and config file.
 * The LLM runs the interactive walkthrough, then calls this script with
 * the collected answers as flags.
 *
 * Usage:
 *   node ship-init.js [options]
 *
 * Options:
 *   --steps <csv>               Comma-separated pipeline steps to run (default: all six canonical steps).
 *                               Valid values: execute, commit, review, version, archive-openspec, pr.
 *   --bump patch|minor|major    Version bump type (default: patch)
 *   --draft                     Mark PR as draft (default: false)
 *   --auto                      Skip interactive approval prompts (default: false)
 *   --threshold critical|high|medium  Review threshold (default: high)
 *   --workspace branch|worktree|prompt  Workspace isolation mode (default: prompt)
 *   --rebase auto|skip|prompt   Rebase strategy (default: auto)
 *
 * Exit codes:
 *   0 = success, JSON on stdout
 *   1 = validation error, JSON with non-empty errors[] on stdout
 *   2 = unexpected script crash, message on stderr
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const LIB = path.join(__dirname, '..', 'lib');

const { readSection, writeSection, ensureSdlcGitignore, resolveSdlcRoot } = require(path.join(LIB, 'config'));
const { writeOutput } = require(path.join(LIB, 'output'));
const { VALID_STEPS, CANONICAL_STEPS } = require(path.join(LIB, 'ship-fields'));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let steps     = CANONICAL_STEPS.slice();
  let quick     = null; // undefined means "not provided"; null persists as "no quick profile"
  let bump      = 'patch';
  let draft     = false;
  let auto      = false;
  let threshold = 'high';
  let workspace = 'prompt';
  let rebase    = 'auto';
  const warnings = [];
  const errors   = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--steps' && args[i + 1]) {
      steps = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (a === '--quick' && args[i + 1]) {
      // R-quick-7: internal ingest of --quick <csv> from LLM walkthrough.
      // The LLM layer (driven by SHIP_FIELDS.quick) invokes ship-init with
      // --quick <csv> when the user makes a selection; when skipped, the flag
      // is omitted and quick stays null (field is not written to config).
      quick = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (a === '--preset') {
      // Hard-removed in v2: --preset is no longer accepted by ship-init.
      // ship-sdlc still parses --preset as legacy CLI sugar, but ship-init
      // is internal (called from setup-sdlc Step 3b after questionnaire) and
      // the unified config now writes ship.steps[] directly.
      errors.push('--preset is no longer accepted by ship-init. Use --steps <csv> instead. Schema migrated to v2 in issue #180.');
    } else if (a === '--skip') {
      // Same: --skip is legacy CLI sugar for ship-sdlc, not a ship-init input.
      errors.push('--skip is no longer accepted by ship-init. Use --steps <csv> instead.');
    } else if (a === '--bump' && args[i + 1]) {
      bump = args[++i];
    } else if (a === '--draft') {
      draft = true;
    } else if (a === '--auto') {
      auto = true;
    } else if (a === '--threshold' && args[i + 1]) {
      threshold = args[++i];
    } else if (a === '--workspace' && args[i + 1]) {
      workspace = args[++i];
    } else if (a === '--rebase' && args[i + 1]) {
      rebase = args[++i];
    }
  }

  return { steps, quick, bump, draft, auto, threshold, workspace, rebase, warnings, parseErrors: errors };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_BUMPS     = ['patch', 'minor', 'major'];
const VALID_THRESHOLD = ['critical', 'high', 'medium'];
const VALID_WORKSPACE = ['branch', 'worktree', 'prompt'];
const VALID_REBASE    = ['auto', 'skip', 'prompt'];

function validate(parsed) {
  const errors = [];

  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    errors.push(`--steps must be a non-empty comma-separated list. Valid values: ${VALID_STEPS.join(', ')}`);
  } else {
    for (const step of parsed.steps) {
      if (!VALID_STEPS.includes(step)) {
        errors.push(`--steps contains invalid value "${step}". Valid values: ${VALID_STEPS.join(', ')}`);
      }
    }
  }

  // R-quick-7: validate --quick values when provided (reuse VALID_STEPS).
  if (Array.isArray(parsed.quick)) {
    for (const step of parsed.quick) {
      if (!VALID_STEPS.includes(step)) {
        errors.push(`--quick contains invalid value "${step}". Valid values: ${VALID_STEPS.join(', ')}`);
      }
    }
  }

  if (!VALID_BUMPS.includes(parsed.bump)) {
    errors.push(`--bump must be one of: ${VALID_BUMPS.join(', ')}. Got: "${parsed.bump}"`);
  }

  if (!VALID_THRESHOLD.includes(parsed.threshold)) {
    errors.push(`--threshold must be one of: ${VALID_THRESHOLD.join(', ')}. Got: "${parsed.threshold}"`);
  }

  if (!VALID_WORKSPACE.includes(parsed.workspace)) {
    errors.push(`--workspace must be one of: ${VALID_WORKSPACE.join(', ')}. Got: "${parsed.workspace}"`);
  }

  if (!VALID_REBASE.includes(parsed.rebase)) {
    errors.push(`--rebase must be one of: ${VALID_REBASE.join(', ')}. Got: "${parsed.rebase}"`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const projectRoot = resolveSdlcRoot(); // issue #351: route to main worktree .sdlc/
  const parsed = parseArgs(process.argv);
  const { steps, quick, bump, draft, auto, threshold, workspace, rebase, warnings: parseWarnings, parseErrors } = parsed;

  const errors   = [...parseErrors];
  const warnings = [...parseWarnings];

  if (errors.length > 0) {
    writeOutput({ errors, warnings }, 'ship-init', 1);
    return;
  }

  // Validate inputs
  const validationErrors = validate({ steps, quick, bump, draft, auto, threshold, workspace, rebase });
  if (validationErrors.length > 0) {
    errors.push(...validationErrors);
    writeOutput({ errors, warnings }, 'ship-init', 1);
    return;
  }

  const sdlcDir = path.join(projectRoot, '.sdlc');

  // Create .sdlc/ directory
  fs.mkdirSync(sdlcDir, { recursive: true });

  // Write .sdlc/.gitignore via shared helper
  const gitignoreAction = ensureSdlcGitignore(projectRoot);
  if (gitignoreAction === 'existed') {
    warnings.push('.sdlc/.gitignore already exists — skipped');
  }

  // Build ship-section payload. Note: rebase is stored as the string token
  // (auto/skip/prompt) — ship.js mergeFlags() handles backward-compat with
  // legacy boolean true/false values for older configs.
  const config = {
    steps,
    // R-quick-7: write ship.quick only when --quick was provided and non-empty.
    // Omitting the field entirely (not writing an empty array) is the correct
    // "no quick profile" state per R-quick-1.
    ...(Array.isArray(quick) && quick.length > 0 ? { quick } : {}),
    bump,
    draft,
    auto,
    reviewThreshold: threshold,
    workspace,
    rebase,
  };

  // Write ship section via unified config — warn if overwriting existing ship section.
  // writeLocalConfig (called by writeSection) stamps top-level version: 2 automatically.
  const existingShip = readSection(projectRoot, 'ship');
  let configAction;
  if (existingShip) {
    warnings.push('Overwriting existing ship config');
    configAction = 'overwritten';
  } else {
    configAction = 'created';
  }

  writeSection(projectRoot, 'ship', config);

  const result = {
    errors,
    warnings,
    created: {
      directory: '.sdlc/',
      gitignore: { path: '.sdlc/.gitignore', action: gitignoreAction },
      config:    { path: '.sdlc/local.json', action: configAction },
    },
    config,
  };

  writeOutput(result, 'ship-init', 0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`ship-init.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, validate };
