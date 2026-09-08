#!/usr/bin/env node
/**
 * generate-run-audit.js
 * CLI helper to generate a human-readable RUN_AUDIT_<runId>.md execution
 * audit ledger from a completed or failed pipeline state file.
 *
 * Usage:
 *   node generate-run-audit.js --state-file <path>
 *
 * Output:
 *   {"generated": true, "auditFile": "<path>"}
 *
 * Exit codes:
 *   0 = success
 *   1 = validation error (missing state file)
 *   2 = unexpected error
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { writeJsonLine } = require('../lib/output');
const { parseStateFilename } = require('../lib/state');

function parseArgs(argv) {
  const args = argv.slice(2);
  let stateFile = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--state-file' && args[i + 1]) {
      stateFile = args[++i];
    }
  }
  return { stateFile };
}

function extractRunId(stateFilePath) {
  const parsed = parseStateFilename(path.basename(stateFilePath));
  if (parsed && parsed.timestamp) return parsed.timestamp;
  return 'default';
}

function main() {
  const { stateFile } = parseArgs(process.argv);
  if (!stateFile) {
    process.stderr.write('Error: --state-file is required\n');
    process.exit(1);
  }

  const resolved = path.resolve(stateFile);
  if (!fs.existsSync(resolved)) {
    process.stderr.write(`Error: state file not found: ${stateFile}\n`);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    process.stderr.write(`Error: unreadable state JSON: ${err.message}\n`);
    process.exit(2);
  }

  const dir = path.dirname(resolved);
  const runId = extractRunId(resolved);
  const auditFile = path.join(dir, `RUN_AUDIT_${runId}.md`);
  const pipeline = data.pipeline || 'pipeline';
  const branch = data.branch || 'unknown';
  const auto = Boolean(data.flags && data.flags.auto);

  let md = `# Run Audit — ${pipeline} (${runId})\n\n`;
  md += `- **Pipeline:** \`${pipeline}\`\n`;
  md += `- **Branch:** \`${branch}\`\n`;
  md += `- **Started At:** ${data.startedAt || 'unknown'}\n`;
  md += `- **Auto Mode:** ${auto ? 'Yes (`--auto`)' : 'No (interactive)'}\n\n`;

  md += `## Step Execution Summary\n\n`;
  md += `| # | Step | Status | Details |\n`;
  md += `|---|---|---|---|\n`;

  const steps = Array.isArray(data.steps) ? data.steps : [];
  steps.forEach((step, idx) => {
    const name = step.name || step.id || `step-${idx + 1}`;
    const status = step.status || 'pending';
    let detail = '';
    if (step.result) detail = step.result;
    else if (step.skipReason) detail = `Skipped: ${step.skipReason}`;
    else if (step.error) detail = `Failed: ${step.error}`;
    else if (step.condition) detail = `Condition: ${step.condition}`;

    const cleanDetail = detail.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    md += `| ${idx + 1} | \`${name}\` | **${status}** | ${cleanDetail} |\n`;
  });

  if (Array.isArray(data.decisions) && data.decisions.length > 0) {
    md += `\n## Decisions Recorded\n\n`;
    md += `| Step | Decision | Timestamp |\n`;
    md += `|---|---|---|\n`;
    data.decisions.forEach(d => {
      md += `| \`${d.step}\` | ${d.text || d.decision || ''} | ${d.timestamp || ''} |\n`;
    });
  }

  if (Array.isArray(data.deferredFindings) && data.deferredFindings.length > 0) {
    md += `\n## Deferred Findings\n\n`;
    md += `| Severity | File | Title |\n`;
    md += `|---|---|---|\n`;
    data.deferredFindings.forEach(f => {
      md += `| ${f.severity} | \`${f.file}\` | ${f.title} |\n`;
    });
  }

  const assumptionsFile = path.join(dir, `ASSUMPTIONS_${runId}.md`);
  if (fs.existsSync(assumptionsFile)) {
    md += `\n## Assumptions & Autonomous Choices\n\n`;
    md += `See detailed assumptions in [ASSUMPTIONS_${runId}.md](./ASSUMPTIONS_${runId}.md).\n`;
  }

  try {
    fs.writeFileSync(auditFile, md, 'utf8');
  } catch (err) {
    process.stderr.write(`Error: could not write audit file '${auditFile}': ${err.message}\n`);
    process.exit(2);
  }
  writeJsonLine({ generated: true, auditFile });
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, extractRunId };
