#!/usr/bin/env node
/**
 * stop-state-save.js
 * Stop hook — saves a compact recovery summary of active pipeline state
 * when Antigravity finishes responding. Safety net for session crashes between
 * compactions.
 *
 * Writes to: <mainWorktree>/.sdlc/execution/.compact-recovery-<branchSlug>.json
 * (per-branch filename — issue #256; see hooks/README.md)
 *
 * Reads stdin.cwd / stdin.workspacePaths[0] via hook-context.js to resolve
 * the user's workspace directory.
 *
 * Exit codes:
 *   0 = always (graceful degradation on errors)
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { readHookContext } = require('./lib/hook-context');

try {
  const { workspaceCwd } = readHookContext({ failClosed: false });
  const { findStateFile, readState, slugifyBranch, resolveStateDir, getRegisteredPrefixes, discoverStatePrefixes } = require('../scripts/lib/state');
  const { exec } = require('../scripts/lib/git');

  const branch = exec('git branch --show-current', { cwd: workspaceCwd });
  if (!branch) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
    process.exit(0);
  }

  const branchSlug = slugifyBranch(branch);

  const discovered = typeof discoverStatePrefixes === 'function' ? discoverStatePrefixes(branchSlug, workspaceCwd) : [];
  const registered = typeof getRegisteredPrefixes === 'function' ? getRegisteredPrefixes() : ['ship', 'execute'];
  const allPrefixes = [...new Set([...discovered, ...registered])];
  const priorityOrder = ['ship', 'execute', ...allPrefixes.filter(p => p !== 'ship' && p !== 'execute')];

  let activePrefix = null;
  for (const p of priorityOrder) {
    if (findStateFile(p, branchSlug, workspaceCwd)) {
      activePrefix = p;
      break;
    }
  }

  // Fast bail — no active pipeline means no work to do
  if (!activePrefix) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
    process.exit(0);
  }

  const shipFound = activePrefix === 'ship' ? findStateFile('ship', branchSlug, workspaceCwd) : null;
  const executeFound = activePrefix === 'execute' ? findStateFile('execute', branchSlug, workspaceCwd) : null;

  let recovery = null;

  // Ship state takes priority
  if (shipFound) {
    const shipState = readState('ship', branchSlug, workspaceCwd);
    if (shipState && shipState.data) {
      const data = shipState.data;
      let currentStep = null;
      let reviewVerdict = null;
      let deferredFindings = 0;

      if (Array.isArray(data.steps)) {
        const inProgress = data.steps.find(s => s.status === 'in_progress');
        const lastCompleted = [...data.steps].reverse().find(s => s.status === 'completed');
        const step = inProgress || lastCompleted;
        if (step) {
          currentStep = step.name || step.id || null;
        }

        for (const s of data.steps) {
          if (s.output && s.output.deferredFindings) {
            deferredFindings = s.output.deferredFindings;
          }
          if (s.output && s.output.verdict) {
            reviewVerdict = s.output.verdict;
          }
        }
      }

      recovery = {
        savedAt: new Date().toISOString(),
        pipeline: 'ship-sdlc',
        branch: data.branch || branch,
        currentStep,
        reviewVerdict,
        deferredFindings,
        flags: {
          preset: (data.flags && data.flags.preset) || null,
          auto: (data.flags && data.flags.auto) || false,
          skip: (data.flags && data.flags.skip) || [],
        },
      };
    }
  }

  // Fall back to execute state
  if (!recovery && executeFound) {
    const executeState = readState('execute', branchSlug, workspaceCwd);
    if (executeState && executeState.data) {
      const data = executeState.data;
      let completedWaves = 0;
      let totalWaves = 0;

      if (Array.isArray(data.waves)) {
        totalWaves = data.waves.length;
        completedWaves = data.waves.filter(w => w.status === 'completed').length;
      }

      recovery = {
        savedAt: new Date().toISOString(),
        pipeline: 'execute-plan-sdlc',
        branch: data.branch || branch,
        completedWaves,
        totalWaves,
        preset: (data.preset) || null,
      };
    }
  }

  // Fall back to generic pipeline state
  if (!recovery && activePrefix) {
    const pipeState = readState(activePrefix, branchSlug, workspaceCwd);
    if (pipeState && pipeState.data) {
      const data = pipeState.data;
      let currentStep = null;
      if (Array.isArray(data.steps)) {
        const inProgress = data.steps.find(s => s.status === 'in_progress');
        const lastCompleted = [...data.steps].reverse().find(s => s.status === 'completed');
        const step = inProgress || lastCompleted;
        if (step) {
          currentStep = step.name || step.id || null;
        }
      }

      recovery = {
        savedAt: new Date().toISOString(),
        pipeline: data.pipeline || activePrefix,
        branch: data.branch || branch,
        currentStep,
        flags: {
          auto: (data.flags && data.flags.auto) || false,
        },
      };
    }
  }

  // No active pipeline — nothing to save
  if (!recovery) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
    process.exit(0);
  }

  // Write recovery file (per-branch — issue #256)
  const recoveryDir = resolveStateDir(workspaceCwd);
  fs.mkdirSync(recoveryDir, { recursive: true });

  const recoveryPath = path.join(recoveryDir, `.compact-recovery-${branchSlug}.json`);
  fs.writeFileSync(recoveryPath, JSON.stringify(recovery, null, 2), 'utf8');
} catch {
  // Graceful degradation
}

process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
process.exit(0);
