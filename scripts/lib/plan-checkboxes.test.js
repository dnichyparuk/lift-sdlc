'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  MIN_SKIP_REASON,
  countCheckboxes,
  isCalendarDate,
  plainReason,
} = require('./plan-checkboxes.js');

const REASON = 'the next task covers it and the branch is merged';

/** The single problem message of `markdown`, asserting there is exactly one. */
function onlyProblem(markdown) {
  const { problems } = countCheckboxes(markdown);
  assert.strictEqual(problems.length, 1, JSON.stringify(problems));
  return problems[0];
}

test('counts open, done and skipped boxes; skipped is closed', () => {
  const md = [
    '- [ ] open',
    '- [x] done',
    '- [X] done too',
    '- [~] skipped',
    `  *Skipped on 2026-10-06: ${REASON}*`,
  ].join('\n');
  assert.deepStrictEqual(countCheckboxes(md), {
    total: 4, open: 1, done: 2, skipped: 1, closed: 3, problems: [],
  });
});

test('recognises every list marker and nesting level', () => {
  const md = [
    '* [ ] star',
    '+ [x] plus',
    '1. [ ] ordered',
    '2) [x] ordered paren',
    '  - [ ] nested',
    '- [ ]',
  ].join('\n');
  const c = countCheckboxes(md);
  assert.strictEqual(c.total, 6);
  assert.strictEqual(c.open, 4);
  assert.strictEqual(c.done, 2);
});

test('lookalikes are not boxes', () => {
  const md = [
    '- [ ~ ] spaced',
    '- [~]text without space',
    '> - [~] in a blockquote',
    '| - [~] | in a table |',
    'text - [ ] mid-line',
  ].join('\n');
  assert.deepStrictEqual(countCheckboxes(md), {
    total: 0, open: 0, done: 0, skipped: 0, closed: 0, problems: [],
  });
});

test('boxes inside fenced code blocks are ignored, including tilde fences', () => {
  const md = [
    '```markdown',
    '- [~] example without a comment',
    '- [ ] example',
    '```',
    '~~~~',
    '- [x] example',
    '```',
    '- [ ] still fenced: a backtick line does not close a tilde fence',
    '~~~~',
    '- [ ] real',
  ].join('\n');
  const c = countCheckboxes(md);
  assert.strictEqual(c.total, 1);
  assert.strictEqual(c.open, 1);
  assert.deepStrictEqual(c.problems, []);
});

test('a skip comment may wrap over several continuation lines', () => {
  const md = [
    '- [~] The GATE passes.',
    '  *Skipped on 2026-10-06: the per-task GATE was not recorded; the',
    '  next task covers it.*',
  ].join('\n');
  assert.deepStrictEqual(countCheckboxes(md).problems, []);
});

test('a skipped box without a comment is a problem with its 1-based line', () => {
  const p = onlyProblem('# Plan\n\n- [~] no comment\n- [ ] next');
  assert.strictEqual(p.line, 3);
  assert.match(p.message, /needs a comment on an indented continuation line/);
});

test('a comment on the box line does not count', () => {
  const p = onlyProblem(`- [~] gate *Skipped on 2026-10-06: ${REASON}*`);
  assert.match(p.message, /on the box line/);
});

test('a comment after a blank line does not count', () => {
  const p = onlyProblem(`- [~] gate\n\n  *Skipped on 2026-10-06: ${REASON}*`);
  assert.match(p.message, /separated from the box by a blank line/);
});

test('an unindented comment line does not count', () => {
  const p = onlyProblem(`- [~] gate\n*Skipped on 2026-10-06: ${REASON}*`);
  assert.match(p.message, /needs a comment/);
});

test('a comment under the next list item does not count', () => {
  const p = onlyProblem(`- [~] gate\n- [x] other\n  *Skipped on 2026-10-06: ${REASON}*`);
  assert.strictEqual(p.line, 1);
});

test('rejects a date that is not a real calendar date', () => {
  for (const date of ['2026-02-30', '2026-13-01', '06.10.2026', '2026-10-6', '']) {
    const p = onlyProblem(`- [~] gate\n  *Skipped on ${date}: ${REASON}*`);
    assert.match(p.message, /not a valid YYYY-MM-DD calendar date/, date);
  }
});

test('rejects a reason shorter than the minimum after stripping markup', () => {
  const p = onlyProblem('- [~] gate\n  *Skipped on 2026-10-06: `see` [PR](https://x/1)*');
  assert.match(p.message, new RegExp(`has 6 characters; at least ${MIN_SKIP_REASON}`));
});

test('accepts a reason of exactly the minimum length', () => {
  const reason = 'x'.repeat(MIN_SKIP_REASON);
  assert.deepStrictEqual(countCheckboxes(`- [~] gate\n  *Skipped on 2026-10-06: ${reason}*`).problems, []);
});

test('tab indentation counts as deeper than the list marker', () => {
  assert.deepStrictEqual(countCheckboxes(`- [~] gate\n\t*Skipped on 2026-10-06: ${REASON}*`).problems, []);
  assert.deepStrictEqual(
    countCheckboxes(`\t- [~] nested gate\n\t\t*Skipped on 2026-10-06: ${REASON}*`).problems,
    [],
  );
});

test('CRLF input is read like LF', () => {
  const md = `- [ ] a\r\n- [~] b\r\n  *Skipped on 2026-10-06: ${REASON}*\r\n- [~] c\r\n`;
  const c = countCheckboxes(md);
  assert.strictEqual(c.total, 3);
  assert.strictEqual(c.skipped, 2);
  assert.strictEqual(c.problems.length, 1);
  assert.strictEqual(c.problems[0].line, 4);
});

test('a comment inside a fence after the box does not count', () => {
  const p = onlyProblem(`- [~] gate\n  \`\`\`\n  *Skipped on 2026-10-06: ${REASON}*\n  \`\`\``);
  assert.strictEqual(p.line, 1);
});

test('tolerates null and empty input', () => {
  assert.strictEqual(countCheckboxes('').total, 0);
  assert.strictEqual(countCheckboxes(null).total, 0);
});

test('isCalendarDate', () => {
  assert.strictEqual(isCalendarDate('2024-02-29'), true);
  assert.strictEqual(isCalendarDate('2026-02-29'), false);
  assert.strictEqual(isCalendarDate('0000-01-01'), true);
  assert.strictEqual(isCalendarDate('2026-1-01'), false);
});

test('plainReason strips links, code and emphasis', () => {
  assert.strictEqual(plainReason(' see [PR #9](https://x/9) and `npm test`  _now_ '), 'see PR #9 and npm test now');
});

test('readCheckboxes lists boxes with state, text and the skip comment', () => {
  const { readCheckboxes } = require('./plan-checkboxes.js');
  const md = [
    '- [ ] open one',
    '  - [x] nested done',
    '```',
    '- [~] fenced, ignored',
    '```',
    '* [~] skipped one',
    `  *Skipped on 2026-10-06: ${REASON}*`,
    '1. [~] skipped without comment',
  ].join('\n');
  const boxes = readCheckboxes(md);
  assert.deepStrictEqual(boxes.map((b) => [b.line, b.state, b.text]), [
    [1, 'open', 'open one'],
    [2, 'done', 'nested done'],
    [6, 'skipped', 'skipped one'],
    [8, 'skipped', 'skipped without comment'],
  ]);
  assert.deepStrictEqual(boxes[2].skip, { date: '2026-10-06', reason: REASON, problem: null });
  assert.strictEqual(boxes[3].skip.date, null);
  assert.match(boxes[3].skip.problem, /needs a comment/);
  assert.strictEqual(boxes[0].skip, undefined);
});

test('countCheckboxes agrees with readCheckboxes', () => {
  const { readCheckboxes } = require('./plan-checkboxes.js');
  const md = ['- [ ] a', '- [x] b', '- [~] c', '  *Skipped on 2026-02-30: too short*'].join('\n');
  const counts = countCheckboxes(md);
  const boxes = readCheckboxes(md);
  assert.strictEqual(counts.total, boxes.length);
  assert.strictEqual(counts.skipped, boxes.filter((b) => b.state === 'skipped').length);
  assert.deepStrictEqual(counts.problems, [{ line: 3, message: boxes[2].skip.problem }]);
});
