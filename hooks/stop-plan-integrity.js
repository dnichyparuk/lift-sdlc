#!/usr/bin/env node
/**
 * stop-plan-integrity.js
 * Stop hook — enforces plan-sdlc integrity checkpoints before allowing turn end.
 *
 * Checks `<stateDir>/plan-<branchSlug>-*.json` via `scripts/lib/state.js` using
 * `workspaceCwd` from `hooks/lib/hook-context.js`. If a plan state exists with
 * incomplete `planIntegrity` checkpoints, returns `{ decision: 'continue', reason }`.
 * Otherwise returns `{ decision: 'allow' }`.
 *
 * Exit codes:
 *   0 = always (fail-open)
 */

'use strict';

const { readHookContext } = require('./lib/hook-context');

const REQUIRED_CHECKPOINTS = [
  'skillInvoked',
  'planFile',
  'guardrailsEvaluated',
  'critiqueRan',
];

try {
  const { input, workspaceCwd } = readHookContext({ failClosed: false });

  if (input.terminationReason && input.terminationReason !== 'NO_TOOL_CALL') {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
    process.exit(0);
  }

  if (input.continuationActive === true) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
    process.exit(0);
  }

  const { resolveBranch, slugifyBranch, findStateFile, readState } = require('../scripts/lib/state');

  let branch = null;
  try {
    branch = resolveBranch(undefined, workspaceCwd);
  } catch (_) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
    process.exit(0);
  }

  const branchSlug = slugifyBranch(branch);
  const found = findStateFile('plan', branchSlug, workspaceCwd);
  if (!found) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
    process.exit(0);
  }

  const state = readState('plan', branchSlug, workspaceCwd);
  if (!state || !state.data || !state.data.planIntegrity || typeof state.data.planIntegrity !== 'object') {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
    process.exit(0);
  }

  const integrity = state.data.planIntegrity;
  const missing = REQUIRED_CHECKPOINTS.filter((key) => !integrity[key]);

  if (missing.length > 0) {
    process.stdout.write(JSON.stringify({
      decision: 'continue',
      reason: `Plan integrity checkpoints incomplete (missing: ${missing.join(', ')}). Complete plan guardrail evaluation and critique gates, then record markers via scripts/skill/plan.js --mark before stopping.`,
    }) + '\n');
    process.exit(0);
  }
} catch (err) {
  process.stderr.write(`stop-plan-integrity.js: state check threw, allowing stop (fail-open): ${err && err.message}\n`);
}

process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
process.exit(0);
