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

const fs = require('node:fs');

try {
  // Read optional stdin
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (raw && raw.trim()) JSON.parse(raw);
  } catch (_) {
    // Non-fatal
  }

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
} catch (_) {
  // Fail-silent
}

process.stdout.write(JSON.stringify({}) + '\n');
process.exit(0);
