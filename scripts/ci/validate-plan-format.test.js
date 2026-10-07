'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { checkPF1, checkPF5, checkPF6, extractTasks, isExecutablePlan, validatePlan } = require('./validate-plan-format');

const SCRIPT = path.join(__dirname, 'validate-plan-format.js');
const COMMENT = '  *Skipped on 2026-10-06: the next task covers it and the branch is merged.*';

function run(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd });
}

/** A plan in the canonical format whose tasks have the given acceptance-criteria lines. */
function plan(...criteria) {
  const lines = [
    '# Demo Implementation Plan',
    '',
    '**Goal:** Demo.',
    '**Architecture:** Demo.',
    '**Source:** conversation context',
    '**Verification:** npm test',
    '',
    '---',
    '',
  ];
  criteria.forEach((ac, i) => {
    lines.push(
      `### Task ${i + 1}: Step ${i + 1}`,
      '',
      '**Complexity:** Trivial',
      '**Risk:** Low',
      `**Depends on:** ${i === 0 ? 'none' : `Task ${i}`}`,
      '**Verify:** tests',
      '',
      '**Description:**',
      'Do the step.',
      '',
      '**Acceptance criteria:**',
      ...ac,
      '',
    );
  });
  return lines.join('\n');
}

function writeTmp(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-plan-format-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return { dir, file };
}

test('a fresh plan with open boxes passes the five checks and has no PF6 entry', () => {
  const report = validatePlan(plan(['- [ ] a', '- [ ] b'], ['- [ ] c']));
  assert.strictEqual(report.passed, true);
  assert.deepStrictEqual(report.checks.map(c => c.id), ['PF1', 'PF2', 'PF3', 'PF4', 'PF5']);
  assert.deepStrictEqual(report.summary, { total: 5, passed: 5, failed: 0 });
});

test('PF5 still fails a task whose boxes are all done, with the unchanged message', () => {
  const r = checkPF5(extractTasks(plan(['- [x] a', '- [x] b'])));
  assert.strictEqual(r.status, 'fail');
  assert.strictEqual(
    r.message,
    'Task 1: **Acceptance criteria:** has no checkbox items (expected at least one "- [ ]")',
  );
});

test('PF5 treats a skipped box as closed and says so', () => {
  const r = checkPF5(extractTasks(plan(['- [x] a', '- [~] b', COMMENT])));
  assert.strictEqual(r.status, 'fail');
  assert.match(r.message, /expected at least one "- \[ \]", and a skipped "- \[~\]" is closed\)$/);
});

test('PF5 passes a task that keeps one open box next to skipped ones', () => {
  const r = checkPF5(extractTasks(plan(['- [ ] a', '- [~] b', COMMENT])));
  assert.strictEqual(r.status, 'pass');
});

test('PF6 passes skipped boxes with valid comments', () => {
  const report = validatePlan(plan(['- [ ] a', '- [~] b', COMMENT], ['- [ ] c', '  - [~] nested', `  ${COMMENT}`]));
  assert.strictEqual(report.passed, true);
  const pf6 = report.checks.find(c => c.id === 'PF6');
  assert.deepStrictEqual(pf6, { id: 'PF6', status: 'pass', message: '2 skipped "- [~]" box(es), each with a valid comment' });
  assert.strictEqual(report.summary.total, 6);
});

test('PF6 fails each skipped box without a valid comment and names file and line', () => {
  const content = plan(['- [ ] a', '- [~] no comment'], ['- [ ] c', '- [~] bad date', '  *Skipped on 2026-02-30: a reason that is long enough*']);
  const lines = content.split('\n');
  const first = lines.indexOf('- [~] no comment') + 1;
  const second = lines.indexOf('- [~] bad date') + 1;
  const r = checkPF6(content, 'docs/plans/demo.md');
  assert.strictEqual(r.status, 'fail');
  const issues = r.message.split('; ');
  assert.strictEqual(issues.length, 2);
  assert.match(issues[0], new RegExp(`^docs/plans/demo\\.md:${first}: "\\[~\\]" needs a comment`));
  assert.match(issues[1], new RegExp(`^docs/plans/demo\\.md:${second}: skip date "2026-02-30"`));
});

test('PF6 ignores skipped boxes inside fenced code', () => {
  const content = plan(['- [ ] a', '```markdown', '- [~] example', '```']);
  assert.strictEqual(checkPF6(content), null);
  assert.strictEqual(validatePlan(content).summary.total, 5);
});

test('PF6 checks skipped boxes outside task sections too', () => {
  const content = `${plan(['- [ ] a'])}\n## Final checks\n\n- [~] release notes\n`;
  const r = checkPF6(content);
  assert.strictEqual(r.status, 'fail');
  assert.match(r.message, /^plan:\d+: "\[~\]" needs a comment/);
});

test('CLI: exit 0 and PF6 in the report for a valid skipped box', () => {
  const { dir, file } = writeTmp('demo.md', plan(['- [ ] a', '- [~] b', COMMENT]));
  const res = run(['--file', 'demo.md', '--json'], dir);
  assert.strictEqual(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.strictEqual(report.checks.at(-1).id, 'PF6');
  assert.ok(fs.existsSync(file));
});

test('CLI: exit 1 and a file:line message for a skipped box without a comment', () => {
  const { dir } = writeTmp('demo.md', plan(['- [ ] a', '- [~] b']).replace(/\n/g, '\r\n'));
  const res = run(['--file', 'demo.md', '--markdown'], dir);
  assert.strictEqual(res.status, 1, res.stderr);
  assert.match(res.stdout, /\| PF6 \| FAIL \| demo\.md:\d+: "\[~\]" needs a comment/);
});

test('CLI: exit 2 without --file', () => {
  const res = run([]);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /--file <path> is required/);
});

// ---------------------------------------------------------------------------
// #17: hook scope, PF5 with closed criteria, PF1 empty field
// ---------------------------------------------------------------------------

test('isExecutablePlan: needs a **Goal:** line and a ### Task N: heading outside fenced code', () => {
  assert.strictEqual(isExecutablePlan(plan(['- [ ] a'])), true);
  assert.strictEqual(isExecutablePlan('# Plans\n\nREADME text\n'), false);
  assert.strictEqual(isExecutablePlan('**Goal:** [TBD]\n**Source:** [TBD]\n'), false, 'skeleton without tasks');
  assert.strictEqual(isExecutablePlan('# Brief\n\n### Task 1: x\n'), false, 'tasks without a Goal header');
  assert.strictEqual(isExecutablePlan('Example:\n\n```\n**Goal:** x\n### Task 1: y\n```\n'), false, 'fenced example');
  assert.strictEqual(isExecutablePlan('**Goal:** x\r\n\r\n### Task 1: y\r\n'), true, 'CRLF');
});

test('PF5 with allowClosedCriteria accepts done and skipped boxes, still requires at least one box', () => {
  const closed = extractTasks(plan(['- [x] a'], ['- [~] b', COMMENT]));
  assert.strictEqual(checkPF5(closed).status, 'fail', 'default stays strict');
  assert.strictEqual(checkPF5(closed, { allowClosedCriteria: true }).status, 'pass');

  const none = checkPF5(extractTasks(plan(['plain text, no box'])), { allowClosedCriteria: true });
  assert.strictEqual(none.status, 'fail');
  assert.match(none.message, /expected at least one "- \[ \]", "- \[x\]" or "- \[~\]"/);
});

test('CLI --allow-closed-criteria passes a fully ticked plan that fails without it', () => {
  const { dir, file } = writeTmp('done.md', plan(['- [x] a'], ['- [x] b']));
  try {
    assert.strictEqual(run(['--file', file]).status, 1);
    const relaxed = run(['--file', file, '--allow-closed-criteria']);
    assert.strictEqual(relaxed.status, 0, relaxed.stdout + relaxed.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PF1: an empty header field does not take the next line as its value', () => {
  const content = plan(['- [ ] a']).replace('**Source:** conversation context', '**Source:**');
  const r = checkPF1(content);
  assert.strictEqual(r.status, 'fail');
  assert.match(r.message, /Source/);
  const trailingSpace = plan(['- [ ] a']).replace('**Source:** conversation context', '**Source:**   ');
  assert.match(checkPF1(trailingSpace).message, /Source/);
});
