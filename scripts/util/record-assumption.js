#!/usr/bin/env node
/**
 * record-assumption.js
 * CLI helper to record an autonomous assumption or default decision made
 * during pipeline execution (ADR-001 Tiered Autonomy).
 *
 * Usage:
 *   node record-assumption.js --state-file <path> --step <name> --question-class <Q1-Q6> --decision <text> --rationale <text>
 *
 * Output:
 *   {"recorded": true, "ledgerFile": "<path>"}
 *
 * Exit codes:
 *   0 = success
 *   1 = validation error (missing required args)
 *   2 = unexpected error
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { writeJsonLine } = require('../lib/output');
const { parseStateFilename, writeState } = require('../lib/state');

const VALID_CLASSES = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'];

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = {
    stateFile: null,
    step: null,
    questionClass: null,
    decision: null,
    rationale: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--state-file' && args[i + 1]) result.stateFile = args[++i];
    else if (a === '--step' && args[i + 1]) result.step = args[++i];
    else if (a === '--question-class' && args[i + 1]) result.questionClass = args[++i];
    else if (a === '--decision' && args[i + 1]) result.decision = args[++i];
    else if (a === '--rationale' && args[i + 1]) result.rationale = args[++i];
  }

  return result;
}

function extractRunId(stateFilePath) {
  const parsed = parseStateFilename(path.basename(stateFilePath));
  if (parsed && parsed.timestamp) return parsed.timestamp;
  return 'default';
}

function main() {
  const opts = parseArgs(process.argv);

  if (!opts.stateFile || !opts.step || !opts.questionClass || !opts.decision) {
    process.stderr.write('Error: --state-file, --step, --question-class, and --decision are required\n');
    process.exit(1);
  }

  if (!VALID_CLASSES.includes(opts.questionClass)) {
    process.stderr.write(`Error: --question-class must be one of ${VALID_CLASSES.join(', ')}\n`);
    process.exit(1);
  }

  const dir = path.dirname(path.resolve(opts.stateFile));
  const runId = extractRunId(opts.stateFile);
  const ledgerFile = path.join(dir, `ASSUMPTIONS_${runId}.md`);

  const exists = fs.existsSync(ledgerFile);
  const now = new Date().toISOString();
  const rationale = opts.rationale || 'Documented default chosen';

  // Sanitize text for markdown table
  const cleanDecision = opts.decision.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const cleanRationale = rationale.replace(/\|/g, '\\|').replace(/\n/g, ' ');

  let content = '';
  if (!exists) {
    content += `# Assumptions Ledger — Run ${runId}\n\n`;
    content += '| Timestamp (UTC) | Step | Class | Decision / Default Chosen | Rationale |\n';
    content += '|---|---|---|---|---|\n';
  }

  content += `| ${now} | ${opts.step} | ${opts.questionClass} | ${cleanDecision} | ${cleanRationale} |\n`;

  try {
    fs.appendFileSync(ledgerFile, content, 'utf8');
  } catch (err) {
    process.stderr.write(`Error: could not write to ledger file '${ledgerFile}': ${err.message}\n`);
    process.exit(2);
  }

  // Also record into state file if it exists and is writable
  try {
    if (fs.existsSync(opts.stateFile)) {
      const raw = fs.readFileSync(opts.stateFile, 'utf8');
      const state = JSON.parse(raw);
      if (!Array.isArray(state.assumptions)) state.assumptions = [];
      state.assumptions.push({
        timestamp: now,
        step: opts.step,
        questionClass: opts.questionClass,
        decision: opts.decision,
        rationale,
      });
      writeState(opts.stateFile, state);
    }
  } catch (err) {
    process.stderr.write(`Warning: could not update state file with assumption: ${err.message}\n`);
  }

  writeJsonLine({ recorded: true, ledgerFile });
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, extractRunId };
