#!/usr/bin/env node
/**
 * stop-block.js
 * Stop hook — prevents orchestrator turn from ending prematurely while an
 * automated pipeline is actively advancing (ADR-001 turn-end enforcement).
 *
 * Gating logic:
 *   - Mid-step (any step is `in_progress`): Block stop in all modes with `continue`.
 *   - Between-steps (all prior steps terminal, auto mode active): Block stop with `continue`.
 *   - Otherwise: `allow`.
 *
 * Exit codes:
 *   0 = always (fail-silent)
 */

'use strict';

try {
  const { pipelineAdvancing } = require('../scripts/lib/state');
  const adv = pipelineAdvancing();

  if (adv && adv.advancing) {
    if (adv.step) {
      process.stdout.write(JSON.stringify({
        decision: 'continue',
        reason: `Pipeline step '${adv.step}' is in_progress — do not stop. Continue executing the pipeline.`,
      }) + '\n');
      process.exit(0);
    }

    if (adv.auto) {
      process.stdout.write(JSON.stringify({
        decision: 'continue',
        reason: 'Pipeline is in auto mode — advance to the next step.',
      }) + '\n');
      process.exit(0);
    }
  }
} catch (e) {
  // Graceful degradation / fail-silent — but log so a corrupted state file
  // silently disabling ADR-001 enforcement is at least diagnosable.
  process.stderr.write(`stop-block.js: pipelineAdvancing() threw, allowing stop (fail-open): ${e && e.message}\n`);
}

process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
process.exit(0);
