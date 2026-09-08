#!/usr/bin/env node
/**
 * ship-state.js (Delegating shim)
 * Backward-compatible wrapper delegating to scripts/state/pipeline.js with --pipeline ship.
 */

'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PIPELINE_CLI = path.join(__dirname, 'pipeline.js');
const forwardedArgs = ['--pipeline', 'ship', ...process.argv.slice(2)];

const result = spawnSync(process.execPath, [PIPELINE_CLI, ...forwardedArgs], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) {
  process.stderr.write(`Failed to invoke pipeline.js: ${result.error.message}\n`);
  process.exit(2);
}

process.exit(result.status !== null ? result.status : 1);
