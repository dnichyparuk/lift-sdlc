#!/usr/bin/env node
/**
 * post-tool-nudge.js
 * PostInvocation hook — injects a context reminder when a pipeline is actively
 * advancing to prevent model drift or mid-run editorializing (ADR-001 drift hole).
 *
 * Output contract:
 *   - When advancing: returns `{ systemMessage: { systemMessage: reminderMsg } }`.
 *   - When not advancing: returns empty JSON object `{}`.
 *
 * Exit codes:
 *   0 = always (fail-silent)
 */

'use strict';

const { readHookContext, formatSystemMessage } = require('./lib/hook-context');

try {
  const { workspaceCwd } = readHookContext({ failClosed: false });
  const { pipelineAdvancing } = require('../scripts/lib/state');
  const adv = pipelineAdvancing({ cwd: workspaceCwd });

  if (adv && adv.advancing && adv.step) {
    const pipelineName = adv.prefix || 'pipeline';
    const reminderMsg = `Pipeline ${pipelineName} step '${adv.step}' is in_progress. Advance the pipeline now — do not summarize or editorialize.`;
    process.stdout.write(JSON.stringify(formatSystemMessage(reminderMsg)) + '\n');
    process.exit(0);
  }
} catch (e) {
  // Fail-silent — but log so a corrupted state file silently disabling the
  // ADR-001 drift nudge is at least diagnosable.
  process.stderr.write(`post-tool-nudge.js: internal error, suppressing nudge (fail-open): ${e && e.message}\n`);
}

process.stdout.write(JSON.stringify({}) + '\n');
process.exit(0);
