#!/usr/bin/env node
/**
 * validate-plan-format.js
 * Validates plan files against the canonical plan format reference.
 *
 * Usage:
 *   node validate-plan-format.js [options]
 *
 * Options:
 *   --project-root <path>   Project root (default: cwd)
 *   --file <path>           Plan file to validate (required)
 *   --json                  JSON output to stdout (default)
 *   --markdown              Formatted markdown output to stdout
 *
 * Exit codes: 0 = all pass, 1 = issues found, 2 = script error
 *
 * Checks:
 *   PF1 — Header fields (Goal, Architecture, Source, Verification)
 *   PF2 — Task numbering (contiguous from 0 or 1)
 *   PF3 — Required metadata (Complexity, Risk, Depends on, Verify)
 *   PF4 — Dependency validity (valid refs, no cycles)
 *   PF5 — Task body (Description, Acceptance criteria with at least one open "- [ ]")
 *   PF6 — Skipped boxes: every "- [~]" carries a "*Skipped on YYYY-MM-DD: <reason>*" comment
 *         (reported only when the plan has at least one "- [~]" outside fenced code)
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

const { resolveSdlcRoot } = require(path.join(__dirname, '..', 'lib', 'config'));
const { countCheckboxes } = require(path.join(__dirname, '..', 'lib', 'plan-checkboxes'));

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  // C-projectroot (#360): default to main-worktree .sdlc/ root, not cwd.
  let projectRoot  = resolveSdlcRoot();
  let filePath     = null;
  let fileArg      = null;
  let outputFormat = 'json';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--project-root' && args[i + 1]) {
      projectRoot = path.resolve(args[++i]);
    } else if (a === '--file' && args[i + 1]) {
      fileArg  = args[++i];
      filePath = path.resolve(fileArg);
    } else if (a === '--json') {
      outputFormat = 'json';
    } else if (a === '--markdown') {
      outputFormat = 'markdown';
    }
  }

  return { projectRoot, filePath, fileArg, outputFormat };
}

// ---------------------------------------------------------------------------
// Plan parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract text after a bold field marker like **Goal:** from the content.
 * Returns the trimmed value or null if not found.
 */
function extractField(content, fieldName) {
  const re = new RegExp(`\\*\\*${fieldName}:\\*\\*\\s*(.+?)(?:\\n|$)`);
  const match = content.match(re);
  return match ? match[1].trim() : null;
}

/**
 * Split plan content into task blocks.
 * Returns array of { number, title, body } objects.
 */
function extractTasks(content) {
  const tasks = [];
  const taskRe = /^### Task (\d+):\s*(.+)$/gm;
  let match;

  const matches = [];
  while ((match = taskRe.exec(content)) !== null) {
    matches.push({ number: parseInt(match[1], 10), title: match[2].trim(), index: match.index });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end   = i + 1 < matches.length ? matches[i + 1].index : content.length;
    const body  = content.slice(start, end);
    tasks.push({ number: matches[i].number, title: matches[i].title, body });
  }

  return tasks;
}

// ---------------------------------------------------------------------------
// Validation checks
// ---------------------------------------------------------------------------

function checkPF1(content) {
  const fields = ['Goal', 'Architecture', 'Source', 'Verification'];
  const missing = [];

  for (const field of fields) {
    const value = extractField(content, field);
    if (!value) {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    return { id: 'PF1', status: 'fail', message: `Missing or empty header field(s): ${missing.join(', ')}` };
  }
  return { id: 'PF1', status: 'pass', message: 'All header fields present' };
}

function checkPF2(tasks) {
  if (tasks.length === 0) {
    return { id: 'PF2', status: 'fail', message: 'No tasks found (expected ### Task N: format)' };
  }

  const numbers = tasks.map(t => t.number).sort((a, b) => a - b);
  const start   = numbers[0];

  // Must start at 0 or 1
  if (start !== 0 && start !== 1) {
    return { id: 'PF2', status: 'fail', message: `Task numbering must start at 0 or 1, found: ${start}` };
  }

  // Check contiguous
  const gaps = [];
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] !== numbers[i - 1] + 1) {
      gaps.push(`gap between Task ${numbers[i - 1]} and Task ${numbers[i]}`);
    }
  }

  // Check duplicates
  const dupes = [];
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] === numbers[i - 1]) {
      dupes.push(numbers[i]);
    }
  }

  const issues = [];
  if (gaps.length > 0) issues.push(`non-contiguous numbering: ${gaps.join(', ')}`);
  if (dupes.length > 0) issues.push(`duplicate task number(s): ${dupes.join(', ')}`);

  if (issues.length > 0) {
    return { id: 'PF2', status: 'fail', message: `Task numbering issues: ${issues.join('; ')}` };
  }

  return { id: 'PF2', status: 'pass', message: `${tasks.length} task(s) numbered contiguously from ${start}` };
}

function checkPF3(tasks) {
  const VALID_COMPLEXITY = ['Trivial', 'Standard', 'Complex'];
  const VALID_RISK       = ['Low', 'Medium', 'High'];
  const VALID_VERIFY     = ['tests', 'build', 'lint', 'manual'];

  const issues = [];

  for (const task of tasks) {
    const prefix = `Task ${task.number}`;

    // Complexity
    const complexity = extractField(task.body, 'Complexity');
    if (!complexity) {
      issues.push(`${prefix}: missing **Complexity:**`);
    } else if (!VALID_COMPLEXITY.includes(complexity)) {
      issues.push(`${prefix}: invalid Complexity "${complexity}" (expected: ${VALID_COMPLEXITY.join('|')})`);
    }

    // Risk
    const risk = extractField(task.body, 'Risk');
    if (!risk) {
      issues.push(`${prefix}: missing **Risk:**`);
    } else if (!VALID_RISK.includes(risk)) {
      issues.push(`${prefix}: invalid Risk "${risk}" (expected: ${VALID_RISK.join('|')})`);
    }

    // Depends on
    const dependsOn = extractField(task.body, 'Depends on');
    if (!dependsOn) {
      issues.push(`${prefix}: missing **Depends on:**`);
    }

    // Verify
    const verify = extractField(task.body, 'Verify');
    if (!verify) {
      issues.push(`${prefix}: missing **Verify:**`);
    } else {
      const values = verify.split(/,\s*/).map(v => v.trim());
      const invalid = values.filter(v => !VALID_VERIFY.includes(v));
      if (invalid.length > 0) {
        issues.push(`${prefix}: invalid Verify value(s): ${invalid.join(', ')} (expected: ${VALID_VERIFY.join('|')})`);
      }
    }
  }

  if (issues.length > 0) {
    return { id: 'PF3', status: 'fail', message: issues.join('; ') };
  }
  return { id: 'PF3', status: 'pass', message: 'All tasks have valid metadata' };
}

function checkPF4(tasks) {
  const taskNumbers = new Set(tasks.map(t => t.number));
  const issues      = [];
  const depGraph    = new Map(); // number -> [dependency numbers]

  for (const task of tasks) {
    const dependsOn = extractField(task.body, 'Depends on');
    if (!dependsOn || dependsOn.toLowerCase() === 'none') {
      depGraph.set(task.number, []);
      continue;
    }

    const refs = [];
    const refRe = /Task\s+(\d+)/gi;
    let match;
    while ((match = refRe.exec(dependsOn)) !== null) {
      const refNum = parseInt(match[1], 10);
      refs.push(refNum);
      if (!taskNumbers.has(refNum)) {
        issues.push(`Task ${task.number}: depends on nonexistent Task ${refNum}`);
      }
    }
    depGraph.set(task.number, refs);
  }

  // Cycle detection using DFS
  const visited  = new Set();
  const inStack  = new Set();

  function hasCycle(node, path) {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      const cycle = path.slice(cycleStart).concat(node);
      issues.push(`Circular dependency: ${cycle.map(n => 'Task ' + n).join(' -> ')}`);
      return true;
    }
    if (visited.has(node)) return false;

    visited.add(node);
    inStack.add(node);

    const deps = depGraph.get(node) || [];
    for (const dep of deps) {
      if (hasCycle(dep, [...path, node])) return true;
    }

    inStack.delete(node);
    return false;
  }

  for (const num of taskNumbers) {
    if (!visited.has(num)) {
      hasCycle(num, []);
    }
  }

  if (issues.length > 0) {
    return { id: 'PF4', status: 'fail', message: issues.join('; ') };
  }
  return { id: 'PF4', status: 'pass', message: 'All dependencies valid, no cycles' };
}

function checkPF5(tasks) {
  const issues = [];

  for (const task of tasks) {
    const prefix = `Task ${task.number}`;

    // Check Description
    const descMatch = task.body.match(/\*\*Description:\*\*\s*\n([\s\S]*?)(?=\n\*\*|$)/);
    if (!descMatch || !descMatch[1].trim()) {
      issues.push(`${prefix}: missing or empty **Description:**`);
    }

    // Check Acceptance criteria with at least one checkbox
    const acMatch = task.body.match(/\*\*Acceptance criteria:\*\*\s*\n([\s\S]*?)(?=\n### |\n---|\n## |$)/);
    if (!acMatch) {
      issues.push(`${prefix}: missing **Acceptance criteria:**`);
    } else {
      const checkboxCount = (acMatch[1].match(/- \[ \]/g) || []).length;
      if (checkboxCount === 0) {
        // A skipped "- [~]" box is closed, like "- [x]": PF5 checks a plan before execution.
        const hint = countCheckboxes(acMatch[1]).skipped > 0 ? ', and a skipped "- [~]" is closed' : '';
        issues.push(`${prefix}: **Acceptance criteria:** has no checkbox items (expected at least one "- [ ]"${hint})`);
      }
    }
  }

  if (issues.length > 0) {
    return { id: 'PF5', status: 'fail', message: issues.join('; ') };
  }
  return { id: 'PF5', status: 'pass', message: 'All tasks have Description and Acceptance criteria' };
}

/**
 * PF6 — every skipped "- [~]" box carries its comment. Returns null when the plan has no
 * skipped box outside fenced code, so the report of such a plan is unchanged.
 */
function checkPF6(content, fileLabel = 'plan') {
  const { skipped, problems } = countCheckboxes(content);
  if (skipped === 0) return null;
  if (problems.length > 0) {
    const issues = problems.map(p => `${fileLabel}:${p.line}: ${p.message}`);
    return { id: 'PF6', status: 'fail', message: issues.join('; ') };
  }
  return { id: 'PF6', status: 'pass', message: `${skipped} skipped "- [~]" box(es), each with a valid comment` };
}

// ---------------------------------------------------------------------------
// Output formatters
// ---------------------------------------------------------------------------

function formatJson(report) {
  return JSON.stringify(report, null, 2);
}

function formatMarkdown(report) {
  const lines = [];
  lines.push('# Plan Format Validation Report');
  lines.push('');
  lines.push(`**Overall:** ${report.passed ? 'PASS' : 'FAIL'} | ${report.summary.passed}/${report.summary.total} checks passed`);
  lines.push('');

  lines.push('| Check | Status | Message |');
  lines.push('|-------|--------|---------|');
  for (const check of report.checks) {
    const icon = check.status === 'pass' ? 'PASS' : 'FAIL';
    lines.push(`| ${check.id} | ${icon} | ${check.message} |`);
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Runs every check on a plan text; `fileLabel` names the file in PF6 messages. */
function validatePlan(content, fileLabel = 'plan') {
  const tasks = extractTasks(content);

  const checks = [
    checkPF1(content),
    checkPF2(tasks),
    checkPF3(tasks),
    checkPF4(tasks),
    checkPF5(tasks),
  ];
  const pf6 = checkPF6(content, fileLabel);
  if (pf6) checks.push(pf6);

  const passed = checks.every(c => c.status === 'pass');
  return {
    passed,
    checks,
    summary: {
      total:  checks.length,
      passed: checks.filter(c => c.status === 'pass').length,
      failed: checks.filter(c => c.status === 'fail').length,
    },
  };
}

function main() {
  try {
    const { filePath, fileArg, outputFormat } = parseArgs(process.argv);

    if (!filePath) {
      process.stderr.write('validate-plan-format.js error: --file <path> is required\n');
      process.exit(2);
    }

    if (!fs.existsSync(filePath)) {
      process.stderr.write(`validate-plan-format.js error: file not found: ${filePath}\n`);
      process.exit(2);
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const report  = validatePlan(content, fileArg);

    if (outputFormat === 'markdown') {
      process.stdout.write(formatMarkdown(report) + '\n');
    } else {
      process.stdout.write(formatJson(report) + '\n');
    }

    process.exit(report.passed ? 0 : 1);
  } catch (err) {
    process.stderr.write(`validate-plan-format.js error: ${err.message}\n`);
    process.exit(2);
  }
}

module.exports = {
  parseArgs,
  extractTasks,
  checkPF1,
  checkPF2,
  checkPF3,
  checkPF4,
  checkPF5,
  checkPF6,
  validatePlan,
  formatJson,
  formatMarkdown,
};

if (require.main === module) {
  main();
}
