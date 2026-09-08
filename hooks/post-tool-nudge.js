#!/usr/bin/env node
/**
 * post-tool-nudge.js
 * PostInvocation hook — injects a context reminder when a pipeline is actively
 * advancing to prevent model drift or mid-run editorializing (ADR-001 drift hole).
 *
 * Output contract:
 *   - When advancing: returns injectSteps with an ephemeralMessage reminder.
 *   - When not advancing: returns empty JSON object `{}`.
 *
 * Exit codes:
 *   0 = always (fail-silent)
 */

'use strict';

try {
  const { pipelineAdvancing } = require('../scripts/lib/state');
  const adv = pipelineAdvancing();

  if (adv && adv.advancing && adv.step) {
    const pipelineName = adv.prefix || 'pipeline';
    process.stdout.write(JSON.stringify({
      injectSteps: [
        {
          type: 'ephemeralMessage',
          content: `Pipeline ${pipelineName} step '${adv.step}' is in_progress. Advance the pipeline now — do not summarize or editorialize.`,
        },
      ],
    }) + '\n');
    process.exit(0);
  }
} catch (e) {
  // Fail-silent — but log so a corrupted state file silently disabling the
  // ADR-001 drift nudge is at least diagnosable.
  process.stderr.write(`post-tool-nudge.js: internal error, suppressing nudge (fail-open): ${e && e.message}\n`);
}

process.stdout.write(JSON.stringify({}) + '\n');
process.exit(0);
