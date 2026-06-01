#!/usr/bin/env node
/**
 * plan-prepare.js
 * Pre-compute OpenSpec context and plan guardrails for plan-sdlc.
 * Uses lib/openspec.js for detection and lib/config.js for guardrail loading.
 *
 * Usage:
 *   node plan-prepare.js [--from-openspec <change-name>] [--output-file]
 *   node plan-prepare.js --mark <name> [--path <abs>]
 *
 * Options:
 *   --from-openspec <name>  Validate a specific OpenSpec change for direct bridging
 *   --output-file           Write JSON to temp file, print path (default: stdout)
 *   --mark <name>           Update the latest plan state file with a checkpoint marker.
 *                           Valid names: plan-file, guardrailsEvaluated, critiqueRan
 *   --path <abs>            Absolute path to the plan file (required when --mark plan-file)
 *
 * Exit codes: 0 = success, 1 = validation error, 2 = unexpected crash
 * Stdout: JSON (or file path with --output-file)
 * Stderr: warnings/progress
 *
 * Uses only Node.js built-in modules + lib/*.js. No npm install required.
 */

'use strict';

const path = require('node:path');
const fs   = require('node:fs');
const { spawnSync } = require('node:child_process');
const LIB = path.join(__dirname, '..', 'lib');

const { detectActiveChanges, validateChange, parseTasks } = require(path.join(LIB, 'openspec'));
const { readSection, resolveSdlcRoot } = require(path.join(LIB, 'config'));
const { writeOutput } = require(path.join(LIB, 'output'));
const { resolveSkipConfigCheck, ensureConfigVersion } = require(path.join(LIB, 'config-version-prepare'));
const { initState, findStateFile, readState, writeState, slugifyBranch, pruneStateFiles } = require(path.join(LIB, 'state'));
const { exec, parseRemoteOwner } = require(path.join(LIB, 'git'));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_MARK_NAMES = ['plan-file', 'guardrailsEvaluated', 'critiqueRan'];

/**
 * Map CLI --mark name to the JSON key in planIntegrity.
 * 'plan-file' → 'planFile'; others map identity.
 */
function markerKey(name) {
  return name === 'plan-file' ? 'planFile' : name;
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let fromOpenspec = null;
  let markName = null;
  let markPath = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from-openspec' && args[i + 1]) {
      fromOpenspec = args[++i];
    } else if (args[i] === '--mark' && args[i + 1]) {
      markName = args[++i];
    } else if (args[i] === '--path' && args[i + 1]) {
      markPath = args[++i];
    }
    // --output-file is handled by writeOutput
  }

  return { fromOpenspec, markName, markPath };
}

// ---------------------------------------------------------------------------
// --mark mode: update the latest plan state file with a checkpoint marker
// ---------------------------------------------------------------------------

function runMarkMode(markName, markPath) {
  if (!VALID_MARK_NAMES.includes(markName)) {
    process.stderr.write(
      `[plan-prepare] --mark: unknown marker name "${markName}". ` +
      `Valid names: ${VALID_MARK_NAMES.join(', ')}\n`
    );
    process.exit(1);
  }

  if (markName === 'plan-file' && !markPath) {
    process.stderr.write('[plan-prepare] --mark plan-file requires --path <abs>\n');
    process.exit(1);
  }

  const branch = exec('git branch --show-current');
  if (!branch) {
    process.stderr.write('[plan-prepare] --mark: could not determine current branch\n');
    process.exit(1);
  }

  const branchSlug = slugifyBranch(branch);
  const found = findStateFile('plan', branchSlug);
  if (!found) {
    process.stderr.write(
      `[plan-prepare] --mark: no plan state file found for branch "${branch}". ` +
      `Run plan-prepare.js --output-file first.\n`
    );
    process.exit(1);
  }

  const existing = readState('plan', branchSlug);
  const data = (existing && existing.data) ? existing.data : {};

  if (!data.planIntegrity || typeof data.planIntegrity !== 'object') {
    data.planIntegrity = {};
  }

  const key = markerKey(markName);
  data.planIntegrity[key] = new Date().toISOString();

  if (markName === 'plan-file') {
    data.planFilePath = markPath;
  }

  writeState(found.fullPath, data);
  process.stderr.write(`[plan-prepare] marker "${key}" written to ${found.fullPath}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// P14/P15 helpers — G17 Dimension Coverage gate (R32, R33) — Fixes #417
// ---------------------------------------------------------------------------

/**
 * Build P14 githubHosting signal (R32).
 * Uses parseRemoteOwner from lib/git.js — no re-derivation in SKILL.md or G17 prompt.
 * @param {string} projectRoot
 * @returns {{ detected: boolean, host: string|null }}
 */
function buildGithubHosting(projectRoot) {
  try {
    const parsed = parseRemoteOwner(projectRoot);
    if (!parsed) return { detected: false, host: null };
    return { detected: parsed.host === 'github.com', host: parsed.host };
  } catch {
    return { detected: false, host: null };
  }
}

/**
 * Build P15 g17Dispatch metadata (R33).
 * Resolves the G17 prompt template path via find cascade:
 *   1. ~/.claude/plugins (installed plugin path)
 *   2. workspace-relative (development / CI path)
 * Returns null promptTemplatePath and adds an error when the file cannot be found.
 * @returns {{ subagentType: string, model: string, promptTemplatePath: string|null, error?: string }}
 */
function buildG17Dispatch() {
  const templateName = 'g17-dimension-coverage-prompt.md';
  const subagentType = 'general-purpose';
  const model = 'gemini-3.5-flash';

  // 1. Try installed plugin path via find
  const findResult = spawnSync(
    'find',
    [
      `${process.env.HOME}/.claude/plugins`,
      '-name', templateName,
      '-path', '*/plan-sdlc/*',
    ],
    { encoding: 'utf8' },
  );
  if (!findResult.error && findResult.status === 0) {
    const lines = (findResult.stdout || '').trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      // sort -V semantics: pick the last (highest version) entry
      const ver = p => { const m = p.match(/\/(\d+)\.(\d+)\.(\d+)\/skills/); return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0]; };
      const sorted = lines.slice().sort((a, b) => { const [a1, a2, a3] = ver(a); const [b1, b2, b3] = ver(b); return a1 - b1 || a2 - b2 || a3 - b3; });
      return { subagentType, model, promptTemplatePath: sorted[sorted.length - 1] };
    }
  }

  // 2. Workspace-relative fallback (development / CI)
  const workspacePath = path.join(
    __dirname,
    '..', '..', 'skills', 'plan-sdlc', templateName,
  );
  if (fs.existsSync(workspacePath)) {
    return { subagentType, model, promptTemplatePath: workspacePath };
  }

  // 3. Not found — surface as error; G17 cannot dispatch without a prompt template
  return {
    subagentType,
    model,
    promptTemplatePath: null,
    error: `G17 prompt template not found: ${templateName}`,
  };
}

/**
 * Resolve a skill/plan-sdlc template path via the same find cascade as buildG17Dispatch.
 * Returns the resolved absolute path, or null when not found.
 * @param {string} templateName
 * @returns {string|null}
 */
function resolveSkillTemplate(templateName) {
  // 1. Try installed plugin path via find
  const findResult = spawnSync(
    'find',
    [
      `${process.env.HOME}/.claude/plugins`,
      '-name', templateName,
      '-path', '*/plan-sdlc/*',
    ],
    { encoding: 'utf8' },
  );
  if (!findResult.error && findResult.status === 0) {
    const lines = (findResult.stdout || '').trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      const ver = p => { const m = p.match(/\/(\d+)\.(\d+)\.(\d+)\/skills/); return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0]; };
      const sorted = lines.slice().sort((a, b) => { const [a1, a2, a3] = ver(a); const [b1, b2, b3] = ver(b); return a1 - b1 || a2 - b2 || a3 - b3; });
      return sorted[sorted.length - 1];
    }
  }

  // 2. Workspace-relative fallback (development / CI)
  const workspacePath = path.join(__dirname, '..', '..', 'skills', 'plan-sdlc', templateName);
  if (fs.existsSync(workspacePath)) {
    return workspacePath;
  }

  return null;
}

/**
 * Build P16 lanes[] metadata (R35).
 * Five entries per KD1 lane partitioning. Entry [4] mirrors g17Dispatch verbatim.
 * @param {{ subagentType: string, model: string, promptTemplatePath: string|null }} g17Dispatch
 * @returns {Array<{ name: string, subagentType: string, model: string, promptTemplatePath: string|null, gateIds: string[] }>}
 */
function buildLanes(g17Dispatch) {
  const laneDefs = [
    {
      name: 'static-structural',
      model: 'gemini-3.5-flash',
      templateName: 'lane-static-structural-prompt.md',
      gateIds: ['G1', 'G2', 'G3', 'G7', 'G12'],
    },
    {
      name: 'content-coverage',
      model: 'gemini-3.5-flash',
      templateName: 'lane-content-coverage-prompt.md',
      gateIds: ['G5', 'G6', 'G8', 'G9', 'G11', 'G13', 'G15', 'G16'],
    },
    {
      name: 'file-existence',
      model: 'gemini-3.5-flash',
      templateName: 'lane-file-existence-prompt.md',
      gateIds: ['G4', 'G10'],
    },
    {
      name: 'guardrail-compliance',
      model: 'gemini-3.5-flash',
      templateName: 'lane-guardrail-compliance-prompt.md',
      gateIds: ['G14'],
    },
  ];

  const lanes = laneDefs.map(def => ({
    name: def.name,
    subagentType: 'general-purpose',
    model: def.model,
    promptTemplatePath: resolveSkillTemplate(def.templateName),
    gateIds: def.gateIds,
  }));

  // Entry [4]: dimension-coverage — mirrors g17Dispatch verbatim (backwards compatibility)
  lanes.push({
    name: 'dimension-coverage',
    subagentType: g17Dispatch.subagentType,
    model: g17Dispatch.model,
    promptTemplatePath: g17Dispatch.promptTemplatePath,
    gateIds: ['G17'],
  });

  return lanes;
}

/**
 * Build P17 lensReviewers[] metadata (R36).
 * Three entries per KD3 lens partitioning.
 * @returns {Array<{ lens: string, subagentType: string, model: string, promptTemplatePath: string|null, focusCategories: string[] }>}
 */
function buildLensReviewers() {
  const lensDefs = [
    {
      lens: 'architecture',
      templateName: 'lens-architecture-prompt.md',
      focusCategories: ['Buildability', 'Task descriptions', 'Decision documentation', 'Dependency accuracy'],
    },
    {
      lens: 'requirements',
      templateName: 'lens-requirements-prompt.md',
      focusCategories: ['Requirements coverage', 'Metadata completeness', 'Plan completeness', 'OpenSpec G16', 'Exploration provenance', 'Best-practice traceability'],
    },
    {
      lens: 'risk',
      templateName: 'lens-risk-prompt.md',
      focusCategories: ['File paths', 'Verification strategy', 'Scope discipline', 'Guardrail compliance'],
    },
  ];

  return lensDefs.map(def => ({
    lens: def.lens,
    subagentType: 'general-purpose',
    model: 'gemini-3.5-flash',
    promptTemplatePath: resolveSkillTemplate(def.templateName),
    focusCategories: def.focusCategories,
  }));
}

// plan-explore.js invocation — builds explorePack (R24 / P8–P12)
// ---------------------------------------------------------------------------

/**
 * Invoke plan-explore.js via spawnSync, passing the user prompt via stdin.
 * User prompt comes in on plan.js stdin (piped by SKILL.md; may be empty).
 * Passing via stdin avoids a new CLI surface and sidesteps argv length limits.
 *
 * Returns an explorePack object with five P8–P12 keys:
 *   { manifestPath, outDir, scopeHintCount, webResearchSignal, error }
 *
 * Never throws — on any spawn error the error field is populated and plan.js
 * continues (R28 fallback is the SKILL.md Step 1 consumer's responsibility).
 */
function runExplorePack(fromOpenspec, userPrompt) {
  const EMPTY_PACK = {
    manifestPath: null,
    outDir: null,
    scopeHintCount: 0,
    webResearchSignal: false,
    error: null,
  };

  // Allow test override via env var (avoids filesystem stubbing for unit tests)
  const exploreScript = process.env.SDLC_PLAN_EXPLORE_SCRIPT || path.join(__dirname, 'plan-explore.js');
  if (!fs.existsSync(exploreScript)) {
    return { ...EMPTY_PACK, error: 'plan-explore.js not found' };
  }

  const args = ['--output-file'];
  if (fromOpenspec) {
    args.push('--from-openspec', fromOpenspec);
  }

  const result = spawnSync(process.execPath, [exploreScript, ...args], {
    input: userPrompt || '',
    encoding: 'utf8',
    timeout: 30000,
  });

  if (result.error) {
    return { ...EMPTY_PACK, error: `plan-explore spawn error: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const errMsg = (result.stderr || '').trim();
    return { ...EMPTY_PACK, error: `plan-explore exited ${result.status}${errMsg ? ': ' + errMsg : ''}` };
  }

  const outputFilePath = (result.stdout || '').trim();
  if (!outputFilePath) {
    return { ...EMPTY_PACK, error: 'plan-explore produced no output path' };
  }

  let packData;
  try {
    packData = JSON.parse(fs.readFileSync(outputFilePath, 'utf8'));
    // Clean up the explore output file — we've inlined it into our own output
    try { fs.unlinkSync(outputFilePath); } catch (_) { /* non-fatal */ }
  } catch (readErr) {
    return { ...EMPTY_PACK, error: `plan-explore output read error: ${readErr.message}` };
  }

  // Validate the five required P8–P12 keys are present
  const required = ['manifestPath', 'outDir', 'scopeHintCount', 'webResearchSignal', 'error'];
  for (const key of required) {
    if (!(key in packData)) {
      return { ...EMPTY_PACK, error: `plan-explore output missing key: ${key}` };
    }
  }

  return {
    manifestPath: packData.manifestPath,
    outDir: packData.outDir,
    scopeHintCount: packData.scopeHintCount,
    webResearchSignal: packData.webResearchSignal,
    error: packData.error,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { fromOpenspec, markName, markPath } = parseArgs(process.argv);

  // Read user prompt from stdin (piped by SKILL.md). May be empty when
  // invoked without stdin — e.g. from --mark mode or unit tests.
  // Passing via stdin avoids a new CLI surface (see Task 5 Key Decision).
  let userPrompt = '';
  try {
    if (!process.stdin.isTTY) {
      userPrompt = fs.readFileSync('/dev/stdin', 'utf8');
    }
  } catch (_) {
    // Non-fatal — plan-explore will run with empty prompt
  }

  // --mark mode: short-circuit before normal prepare flow
  if (markName !== null) {
    runMarkMode(markName, markPath);
    return; // runMarkMode calls process.exit(); this is a safeguard
  }

  const projectRoot = resolveSdlcRoot(); // issue #351: route to main worktree .sdlc/
  const errors = [];

  // Issue #232: verifyAndMigrate gate (CLI > env > default false).
  const skipConfigCheck = resolveSkipConfigCheck(process.argv);
  const cv = ensureConfigVersion(projectRoot, { skip: skipConfigCheck, roles: ['project'] });
  if (cv.errors.length > 0) {
    for (const e of cv.errors) errors.push(`config-version: ${e.role}: ${e.message}`);
    writeOutput({ errors, flags: { skipConfigCheck }, migration: cv.migration }, 'plan-prepare', 1);
    return;
  }

  // Write skillInvoked marker (R20) — plan-sdlc was invoked (issue #285).
  // Done early so the marker is present even if later steps fail.
  // Prune prior plan markers for this branch before writing a new one (issue #334):
  // ensures at most one plan-<branchSlug>-*.json exists per branch.
  try {
    const branch = exec('git branch --show-current');
    if (branch) {
      pruneStateFiles('plan', slugifyBranch(branch));
      initState('plan', branch, {
        planIntegrity: { skillInvoked: new Date().toISOString() },
      });
    }
  } catch (_) {
    // Non-fatal: marker write failures must not block prepare output.
  }

  // 1. OpenSpec detection
  const openspec = detectActiveChanges(projectRoot);

  // Add authoritative evidence when OpenSpec is present
  if (openspec.present) {
    openspec.authoritative = {
      path: 'openspec/config.yaml',
      specsCount: openspec.specsCount,
    };
  }

  // 2. --from-openspec validation
  let fromOpenspecResult = null;
  let openspecContext = { tasks: null, tasksUpdated: 0 };
  if (fromOpenspec) {
    const validation = validateChange(projectRoot, fromOpenspec);
    fromOpenspecResult = {
      valid: validation.valid,
      changeName: fromOpenspec,
      hasProposal: validation.hasProposal,
      deltaSpecCount: validation.deltaSpecCount,
      hasDesign: validation.hasDesign,
      hasTasks: validation.hasTasks,
      tasksDone: validation.tasksDone,
      tasksTotal: validation.tasksTotal,
      stage: validation.stage,
    };

    if (!validation.valid) {
      for (const err of validation.errors) {
        if (!err.startsWith('Warning:')) {
          errors.push(err);
        }
      }
    }

    // 2a. Parse tasks.md, populate openspecContext.tasks (P13), inject ref comments (I7).
    // Idempotent + additive: existing <!-- ref: --> comments are left untouched.
    // Path-traversal guard: fromOpenspec is caller-supplied (CLI/argv) and is interpolated
    // into a filesystem path. Reject empty, separator, or parent-ref components so the
    // resulting path cannot escape openspec/changes/<fromOpenspec>/.
    if (
      validation.valid &&
      validation.hasTasks &&
      typeof fromOpenspec === 'string' &&
      fromOpenspec.length > 0 &&
      !fromOpenspec.includes('/') &&
      !fromOpenspec.includes('\\') &&
      !fromOpenspec.includes('..') &&
      !fromOpenspec.includes('\0')
    ) {
      const tasksPath = path.join(projectRoot, 'openspec', 'changes', fromOpenspec, 'tasks.md');
      try {
        const original = fs.readFileSync(tasksPath, 'utf8');
        const parsed = parseTasks(original);
        openspecContext.tasks = parsed;

        // Inject <!-- ref:<ref> --> on `- [ ]` or `- [x]` lines without an existing ref comment.
        const lines = original.split('\n');
        let updated = 0;
        for (const entry of parsed) {
          const idx = entry.line - 1;
          if (idx < 0 || idx >= lines.length) continue;
          if (/<!--\s*ref:/.test(lines[idx])) continue; // write-once
          lines[idx] = lines[idx].replace(/\s*$/, '') + ` <!-- ref:${entry.ref} -->`;
          updated++;
        }
        if (updated > 0) {
          fs.writeFileSync(tasksPath, lines.join('\n'), 'utf8');
        }
        openspecContext.tasksUpdated = updated;
      } catch (err) {
        // Surface as warning but do not block prepare.
        process.stderr.write(`[plan-prepare] tasks.md ref injection warning: ${err.message}\n`);
      }
    }
  }

  // 3. Guardrail loading from plan config section
  let guardrails = [];
  try {
    const planConfig = readSection(projectRoot, 'plan');
    if (planConfig && Array.isArray(planConfig.guardrails)) {
      guardrails = planConfig.guardrails;
    }
  } catch (err) {
    errors.push(`Failed to read plan config: ${err.message}`);
  }

  // 4. plan-explore invocation — gather dynamic-dimension materials (R24 / P8–P12)
  // Errors absorbed into explorePack.error; never propagated to plan.js errors[] (R28).
  const explorePack = runExplorePack(fromOpenspec, userPrompt);
  if (explorePack.error) {
    process.stderr.write(`[plan-prepare] plan-explore warning: ${explorePack.error}\n`);
  }

  // 5. P14/P15 — G17 dispatch signals (R32, R33 — Fixes #417)
  // --mark mode short-circuits before this point, so these only run in --output-file mode.
  const githubHosting = buildGithubHosting(projectRoot);
  const g17Dispatch = buildG17Dispatch();
  if (g17Dispatch.error) {
    process.stderr.write(`[plan-prepare] G17 skipped — ${g17Dispatch.error}\n`);
  }

  // 6. P16/P17 — lane fan-out and lens reviewer signals (R35, R36 — Fixes #418)
  const lanes = buildLanes(g17Dispatch);
  const lensReviewers = buildLensReviewers();
  // Warn for any lane with null promptTemplatePath (non-G17 lanes only; G17 already warned above)
  lanes.slice(0, 4).forEach(lane => {
    if (lane.promptTemplatePath === null) {
      process.stderr.write(`[plan-prepare] lane "${lane.name}" skipped — prompt template not found\n`);
    }
  });
  lensReviewers.forEach(lens => {
    if (lens.promptTemplatePath === null) {
      process.stderr.write(`[plan-prepare] lens "${lens.lens}" skipped — prompt template not found\n`);
    }
  });

  // 7. Output
  const output = {
    openspec,
    fromOpenspec: fromOpenspecResult,
    openspecContext,
    guardrails,
    explorePack,
    githubHosting,
    g17Dispatch: { subagentType: g17Dispatch.subagentType, model: g17Dispatch.model, promptTemplatePath: g17Dispatch.promptTemplatePath },
    lanes,
    lensReviewers,
    errors,
  };

  writeOutput(output, 'plan-prepare', errors.length > 0 ? 1 : 0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`plan-prepare.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { main };
