#!/usr/bin/env node
/**
 * harden-prepare.js — pre-computes the manifest for the harden-orchestrator
 * agent. Loads all five hardening surfaces deterministically (per-surface
 * loaders live in lib/harden-surfaces.js to honor the ≤200-line cap).
 * Implements docs/specs/harden-sdlc.md R1-R4, R10, R13, R16.
 * Required: --failure-text, --skill. Stdin JSON fallback supported (CLI wins).
 * Exit codes: 0 success, 1 missing-required, 2 crash.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { execSync, spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');
const { writeOutput } = require(path.join(LIB, 'output'));
const surfaces = require(path.join(LIB, 'harden-surfaces'));
const { resolveSkipConfigCheck, ensureConfigVersion } = require(path.join(LIB, 'config-version-prepare'));
const { detectResumeState } = require(path.join(LIB, 'state'));
const { resolveSdlcRoot } = require(path.join(LIB, 'config'));

// Plugin repo URL (issue #288). Hardcoded inline by design — do NOT extract to
// lib/harden-surfaces.js, do NOT share with error-report-prepare.js::TARGET_REPO.
// The two constants live independently in their own scripts so each script has
// a single, locally-visible source of truth.
const PLUGIN_REPO_URL = 'https://github.com/dnichyparuk/antigravity-sdlc';

// ---------------------------------------------------------------------------
// CLI parsing — mirror error-report-prepare.js posture
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (a === '--output-file') continue; // handled by writeOutput
    const eq = a.indexOf('=');
    let key, val;
    if (eq !== -1) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      val = argv[i + 1];
      if (val !== undefined && !val.startsWith('--')) {
        i++;
      } else {
        val = '';
      }
    }
    out[key] = val;
  }
  return out;
}

function camelKey(k) {
  return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function readStdinJson() {
  try {
    if (process.stdin.isTTY) return {};
    const buf = fs.readFileSync(0, 'utf8');
    if (!buf.trim()) return {};
    return JSON.parse(buf);
  } catch (err) {
    process.stderr.write(`harden-prepare: stdin JSON parse failed — ${err.message}\n`);
    return {};
  }
}

function safeExec(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch (err) {
    process.stderr.write(`harden-prepare: git command failed (${cmd.split(' ')[0]}): ${err.stderr ? err.stderr.toString().trim() : err.message}\n`);
    return '';
  }
}

// ---------------------------------------------------------------------------
// Pipeline state probes — optional context (R11)
// ---------------------------------------------------------------------------
// Issue #284, task 19: selection rule (newest mtime) is now canonical via
// `lib/state.js::detectResumeState`. Previously this scanned the local
// `.sdlc/execution/` and picked the first match; that diverged from
// ship.js's slugify+newest-mtime rule when multiple state files existed.
// We pass no `branch` so we accept the most recent file of each prefix
// regardless of which branch produced it — harden is a project-wide probe.

function readPipelineState() {
  let shipState = null;
  let executeState = null;

  const ship = detectResumeState({ prefix: 'ship' });
  if (ship.found) {
    try {
      const data = JSON.parse(fs.readFileSync(ship.fullPath, 'utf8'));
      shipState = {
        paused: !!data.paused,
        currentStep: data.currentStep || null,
        lastFailedStep: data.lastFailedStep || null,
      };
    } catch (err) {
      process.stderr.write(`harden-prepare: skipping ship state file ${path.basename(ship.fullPath)} — ${err.message}\n`);
    }
  }

  const execute = detectResumeState({ prefix: 'execute' });
  if (execute.found) {
    try {
      const data = JSON.parse(fs.readFileSync(execute.fullPath, 'utf8'));
      executeState = {
        failedTask: data.failedTask || null,
        failedWave: data.failedWave || null,
      };
    } catch (err) {
      process.stderr.write(`harden-prepare: skipping execute state file ${path.basename(execute.fullPath)} — ${err.message}\n`);
    }
  }

  return { shipState, executeState };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const cli = parseArgs(process.argv.slice(2));
  const stdin = readStdinJson();

  const input = {};
  for (const [k, v] of Object.entries(stdin)) input[k] = v;
  for (const [k, v] of Object.entries(cli)) input[camelKey(k)] = v;

  const errors = [];

  // Issue #232: verifyAndMigrate gate (CLI > env > default false).
  // R-projectroot: main-worktree-rooted resolution (#360).
  const cwdForVerify = resolveSdlcRoot();
  const skipConfigCheck = resolveSkipConfigCheck(process.argv);
  const cv = ensureConfigVersion(cwdForVerify, { skip: skipConfigCheck, roles: ['project'] });
  if (cv.errors.length > 0) {
    for (const e of cv.errors) errors.push(`config-version: ${e.role}: ${e.message}`);
    writeOutput({ errors, warnings: [], flags: { skipConfigCheck }, migration: cv.migration }, 'sdlc-harden', 1);
    return;
  }

  // R19 — --from-issue mutual exclusion with --failure-text
  const hasFailureText = Boolean(input.failureText && String(input.failureText).trim());
  const hasFromIssue   = Boolean(input.fromIssue   && String(input.fromIssue).trim());

  if (hasFailureText && hasFromIssue) {
    const msg = '--failure-text and --from-issue are mutually exclusive — provide one or the other, not both';
    process.stderr.write(`harden-prepare: ${msg}\n`);
    writeOutput({ errors: [msg], warnings: [] }, 'sdlc-harden', 2);
    return;
  }

  // R19 — fetch issue body when --from-issue is used
  let classificationHint = null;
  if (hasFromIssue) {
    const issueNum = String(input.fromIssue).trim();
    // Validate as pure positive integer (defense-in-depth alongside the
    // spawnSync argv-array invocation below, which already avoids shell
    // metacharacter parsing).
    if (!/^\d+$/.test(issueNum)) {
      const msg = `--from-issue: invalid issue number "${issueNum}" — must be a positive integer`;
      errors.push(msg);
      process.stderr.write(`harden-prepare: ${msg}\n`);
      writeOutput({ errors, warnings: [] }, 'sdlc-harden', 1);
      return;
    }
    // Use spawnSync with argv array (shell: false) for defense-in-depth against
    // shell injection — matches the established pattern in
    // mcp-failure.js::analyzeForDispatch. The integer-regex above is a first
    // line of defense; passing argv directly avoids shell-metacharacter parsing
    // entirely.
    let issueJson = null;
    const result = spawnSync(
      'gh',
      ['issue', 'view', issueNum, '--json', 'body,labels,title'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, shell: false }
    );
    if (result.error || result.status !== 0) {
      const errText = result.stderr ? result.stderr.toString().trim() : (result.error && result.error.message) || `exit ${result.status}`;
      const msg = `--from-issue ${issueNum}: gh issue view failed — ${errText}`;
      errors.push(msg);
      process.stderr.write(`harden-prepare: ${msg}\n`);
      writeOutput({ errors, warnings: [] }, 'sdlc-harden', 1);
      return;
    }
    try {
      issueJson = JSON.parse(result.stdout.toString().trim());
    } catch (err) {
      const msg = `--from-issue ${issueNum}: gh issue view returned invalid JSON — ${err.message}`;
      errors.push(msg);
      process.stderr.write(`harden-prepare: ${msg}\n`);
      writeOutput({ errors, warnings: [] }, 'sdlc-harden', 1);
      return;
    }
    // Populate failureText from issue body
    input.failureText = issueJson.body || '';
    // Pre-set classification hint when issue has mcp-failure label (R19)
    const labels = (issueJson.labels || []).map(l => (typeof l === 'string' ? l : l.name));
    if (labels.includes('mcp-failure')) {
      classificationHint = 'plugin-defect';
    }
  }

  const required = ['failureText', 'skill'];
  for (const key of required) {
    if (!input[key] || String(input[key]).trim() === '') {
      errors.push(`Missing required field: ${key}`);
    }
  }

  if (errors.length > 0) {
    process.stderr.write(`harden-prepare: ${errors.join('; ')}\n`);
    writeOutput({ errors, warnings: [] }, 'sdlc-harden', 1);
    return;
  }

  // R-projectroot: main-worktree-rooted resolution (#360).
  const projectRoot = resolveSdlcRoot();
  const surfaceLoadErrors = [];

  // R16 — Pre-flight validation: validate existing .sdlc/config.json guardrails
  // and .sdlc/review-dimensions/*.md BEFORE assembling the manifest. On any
  // error, exit 1 with structured errors[] — do NOT write the manifest.
  const { validateGuardrailsConfig } = require('../ci/validate-guardrails');
  const { validateDimensionFile, resolveDimensionsDir } = require('../lib/dimensions');
  const preflightErrors = [];

  for (const section of ['plan', 'execute']) {
    const result = validateGuardrailsConfig(projectRoot, section);
    for (const err of result.errors) {
      preflightErrors.push(`existing-${section}-guardrails: ${err}`);
    }
  }

  const dimDir = resolveDimensionsDir(projectRoot);
  if (fs.existsSync(dimDir)) {
    let dimFiles = [];
    try {
      dimFiles = fs.readdirSync(dimDir).filter(x => x.endsWith('.md'));
    } catch (readErr) {
      preflightErrors.push(`review-dimensions: readdir failed: ${readErr.message}`);
    }
    for (const f of dimFiles) {
      const filePath = path.join(dimDir, f);
      const { errors: dimErrors } = validateDimensionFile(filePath);
      for (const err of dimErrors) {
        preflightErrors.push(`existing-review-dimension ${f}: ${err.message || err}`);
      }
    }
  }

  if (preflightErrors.length > 0) {
    for (const e of preflightErrors) errors.push(e);
    process.stderr.write(`harden-prepare: pre-flight validation failed:\n${preflightErrors.join('\n')}\n`);
    writeOutput({ errors, warnings: [], flags: { skipConfigCheck }, migration: cv.migration }, 'sdlc-harden', 1);
    return;
  }

  // Load all five surfaces deterministically (R4).
  const planGuardrails    = surfaces.loadGuardrails(projectRoot, 'plan',    surfaceLoadErrors);
  const executeGuardrails = surfaces.loadGuardrails(projectRoot, 'execute', surfaceLoadErrors);
  const reviewDimensions  = surfaces.loadReviewDimensions(projectRoot, surfaceLoadErrors);
  const copilotInstructions = surfaces.loadCopilotInstructions(projectRoot, surfaceLoadErrors);
  const errorReportSkillPath = surfaces.resolveErrorReportSkill(projectRoot, surfaceLoadErrors);

  const { shipState, executeState } = readPipelineState();

  const manifest = {
    failure: {
      text:       String(input.failureText),
      skill:      String(input.skill).trim(),
      step:       input.step       != null ? String(input.step).trim()       : '',
      operation:  input.operation  != null ? String(input.operation).trim()  : '',
      exitCode:   input.exitCode   != null && input.exitCode !== '' ? String(input.exitCode) : null,
      errorType:  input.errorType  != null ? String(input.errorType).trim()  : '',
      userIntent: input.userIntent != null ? String(input.userIntent)        : '',
      argsString: input.argsString != null ? String(input.argsString)        : '',
    },
    classification_hint: classificationHint,
    surfaces: {
      planGuardrails,
      executeGuardrails,
      reviewDimensions,
      copilotInstructions,
      errorReportSkillPath,
    },
    pipeline: {
      shipState,
      executeState,
    },
    repository: {
      root:   projectRoot,
      branch: safeExec('git rev-parse --abbrev-ref HEAD'),
      recentDiffSummary: safeExec('git diff --shortstat HEAD~1..HEAD 2>/dev/null'),
    },
    pluginRepoUrl: PLUGIN_REPO_URL,
    timestamp: new Date().toISOString(),
    errors: surfaceLoadErrors,
  };

  writeOutput(manifest, 'sdlc-harden', 0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`harden-prepare.js crashed: ${err.stack || err.message}\n`);
  process.exit(2);
}
