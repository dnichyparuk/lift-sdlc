'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parsePlanMarkdown,
  parseTodoMarkdown,
  slugify,
  cleanMarkdownText,
  parseAcceptanceCriteria
} = require('./markdown-parser.js');

describe('markdown-parser', () => {
  test('slugify cleans and formats DOM-safe IDs', () => {
    assert.equal(slugify('Task 0.1'), 'task-0-1');
    assert.equal(slugify('W0-T01'), 'w0-t01');
    assert.equal(slugify('X1 — Test Title'), 'x1-test-title');
    assert.equal(slugify(''), '');
  });

  test('cleanMarkdownText strips markdown syntax and links', () => {
    assert.equal(cleanMarkdownText('`foo` and **bar**'), 'foo and bar');
    assert.equal(cleanMarkdownText('[Link text](https://example.com)'), 'Link text');
  });

  test('code block insulation ignores headers and checkboxes in fences', () => {
    const md = `# Sample Plan

**Goal:** Test code fence insulation

### Task 1: Real Task
- **Complexity:** Standard
- **Risk:** Low
- [x] Real criterion

\`\`\`markdown
### Task 2: Fake Task in code block
- [ ] Fake criterion
\`\`\`

~~~
#### Task 3: Another fake
~~~
`;

    const plan = parsePlanMarkdown(md, {
      filePath: 'docs/plans/sample.md',
      projectId: 'test-project'
    });

    assert.equal(plan.tasks.length, 1);
    assert.equal(plan.tasks[0].id, '1');
    assert.equal(plan.tasks[0].title, 'Real Task');
    assert.equal(plan.tasks[0].status, 'done');
    assert.equal(plan.tasks[0].acceptanceCriteria.length, 1);
    assert.equal(plan.tasks[0].acceptanceCriteria[0].text, 'Real criterion');
  });

  test('parses trade-robot-alpha wave format and task URNs', () => {
    const md = `# P1b.W0 — Parity instruments

### P1b.W0 — parity instruments

#### Task W0-T01: Divergence audit with evidence → parity matrix finalised
- **Complexity:** Standard · **Risk:** Low · **Depends on:** none · **Verify:** review

**Files:** this plan, TODO 021.

**Acceptance criteria:**
- [x] Matrix has no unverified cell.
- [x] Machine readable rows exported.

#### Task W0-T02: Controllable paper-broker clock
- **Complexity:** Standard · **Risk:** Medium (touches P snapshot) · **Depends on:** W0-T01
- [ ] Clock pinned test passes.
`;

    const plan = parsePlanMarkdown(md, {
      filePath: 'docs/plans/part1b-unification/waves/wave-0-parity-instruments.md',
      projectId: 'trade-robot-alpha',
      planId: 'wave-0'
    });

    assert.equal(plan.tasks.length, 2);

    const t1 = plan.tasks[0];
    assert.equal(t1.id, 'W0-T01');
    assert.equal(t1.globalId, 'urn:sdlc:trade-robot-alpha:wave-0:W0-T01');
    assert.equal(t1.slug, 'w0-t01');
    assert.equal(t1.complexity, 'Standard');
    assert.equal(t1.risk, 'Low');
    assert.equal(t1.status, 'done');
    assert.deepEqual(t1.dependsOn, []);

    const t2 = plan.tasks[1];
    assert.equal(t2.id, 'W0-T02');
    assert.equal(t2.globalId, 'urn:sdlc:trade-robot-alpha:wave-0:W0-T02');
    assert.equal(t2.complexity, 'Standard');
    assert.equal(t2.risk, 'Medium');
    assert.equal(t2.status, 'todo');
    assert.deepEqual(t2.dependsOn, ['urn:sdlc:trade-robot-alpha:wave-0:W0-T01']);
  });

  test('parses lift-fixed-price review fix format (X1, W1)', () => {
    const md = `# Consolidated Review Fix Plan

### X1 — apps/api typecheck excludes the test tree, so it passes vacuously
**Severity:** CRITICAL
**Batch:** SOLO

**Files to modify**
- apps/api/tsconfig.json
- apps/api/tsconfig.test.json *(new)*

**Acceptance criteria:**
- [ ] npm run typecheck typechecks tests.
- [ ] build project excludes tests.

### W1 — Unit-test and de-duplicate summary.mjs percentile math
**Complexity:** Standard
**Risk:** Low
**Depends on:** X1

**Acceptance criteria:**
- [x] Unit test percentile math.
`;

    const plan = parsePlanMarkdown(md, {
      filePath: 'docs/plans/consolidated.md',
      projectId: 'lift-fixed-price',
      planId: 'consolidated'
    });

    assert.equal(plan.tasks.length, 2);

    const x1 = plan.tasks[0];
    assert.equal(x1.id, 'X1');
    assert.equal(x1.title, 'apps/api typecheck excludes the test tree, so it passes vacuously');
    assert.equal(x1.status, 'todo');

    const w1 = plan.tasks[1];
    assert.equal(w1.id, 'W1');
    assert.equal(w1.status, 'done');
    assert.deepEqual(w1.dependsOn, ['urn:sdlc:lift-fixed-price:consolidated:X1']);
  });

  test('parses real file from trade-robot-alpha if available', () => {
    const samplePath = '/home/dzmitry/projects/trade-robot-alpha/docs/plans/2026-09-30-paper-live-batch4-part1-safety-hardening.md';
    if (!fs.existsSync(samplePath)) return;

    const content = fs.readFileSync(samplePath, 'utf8');
    const plan = parsePlanMarkdown(content, {
      filePath: 'docs/plans/2026-09-30-paper-live-batch4-part1-safety-hardening.md',
      projectId: 'trade-robot-alpha'
    });

    assert.equal(plan.tasks.length, 8);
    assert.equal(plan.tasks[0].id, '1');
    assert.ok(plan.tasks[0].title.includes('PLR-10a'));
    assert.equal(plan.tasks[0].complexity, 'Trivial');
    assert.equal(plan.tasks[0].risk, 'Low');
    assert.equal(plan.tasks[0].status, 'done'); // all acceptance criteria checked in this real plan
    assert.ok(plan.waves.length >= 3, `Expected at least 3 waves for multi-stage dependency plan, got ${plan.waves.length}`);
  });

  test('parses explicit multi-wave plans with headers', () => {
    const md = `# Multi-Wave Test Plan

### Wave 1: Foundation
### Task 1: Setup
- **Complexity:** Standard
- **Depends on:** none
- [x] Done

### Wave 2: Execution
### Task 2: Implement
- **Complexity:** Standard
- **Depends on:** Task 1
- [ ] Todo
`;
    const plan = parsePlanMarkdown(md, {
      filePath: 'docs/plans/multi-wave.md',
      projectId: 'test'
    });

    assert.equal(plan.waves.length, 2);
    assert.equal(plan.waves[0].id, 'wave-1');
    assert.equal(plan.waves[1].id, 'wave-2');
    assert.equal(plan.tasks[0].waveId, 'wave-1');
    assert.equal(plan.tasks[1].waveId, 'wave-2');
  });

  test('parses real file from lift-fixed-price if available', () => {
    const samplePath = '/home/dzmitry/projects/lift-fixed-price/docs/plans/2026-09-20-mvp-wave-2-web-spa-smart-paste-grid.md';
    if (!fs.existsSync(samplePath)) return;

    const content = fs.readFileSync(samplePath, 'utf8');
    const plan = parsePlanMarkdown(content, {
      filePath: 'docs/plans/2026-09-20-mvp-wave-2-web-spa-smart-paste-grid.md',
      projectId: 'lift-fixed-price'
    });

    assert.equal(plan.tasks.length, 11);
    assert.equal(plan.tasks[0].id, '1');
    assert.ok(plan.tasks[0].title.includes('ESLint Engine-Import Guard'));
    assert.ok(plan.waves.length >= 4, `Expected at least 4 topological waves, got ${plan.waves.length}`);
  });

  test('parses real TODO file from trade-robot-alpha', () => {
    const samplePath = '/home/dzmitry/projects/trade-robot-alpha/docs/TODO/021-execute-part1b-unification-plan.md';
    if (!fs.existsSync(samplePath)) return;

    const content = fs.readFileSync(samplePath, 'utf8');
    const todo = parseTodoMarkdown(content, {
      filePath: 'docs/TODO/021-execute-part1b-unification-plan.md'
    });

    assert.equal(todo.id, '021-execute-part1b-unification-plan');
    assert.equal(todo.status, 'open');
    assert.equal(todo.priority, 'P2');
    assert.ok(todo.blocks.length > 0);
    assert.ok(todo.markdownSource && todo.markdownSource.includes('021 — Execute the Part 1b unification plan'));
  });
});

describe('markdown-parser skipped "- [~]" criteria', () => {
  const REASON = 'the next task GATE covers it and the branch is merged';
  const md = `# Skip Plan

**Goal:** Index skipped criteria

### Task 1: Mixed criteria
**Depends on:** none

**Acceptance criteria:**
- [x] Done criterion
- [~] Skipped criterion
  *Skipped on 2026-10-06: ${REASON}*
- [ ] Open criterion

### Task 2: All closed
**Depends on:** none

**Acceptance criteria:**
- [x] Done criterion
- [~] Skipped criterion
  *Skipped on 2026-10-06: ${REASON}*

### Task 3: Only skipped, one comment missing
**Depends on:** none
- **Acceptance criteria:**
  - [~] Skipped with comment
    *Skipped on 2026-10-06: ${REASON}*
  - [~] Skipped without comment
`;
  const plan = parsePlanMarkdown(md, { filePath: 'docs/plans/skip.md', projectId: 'p' });

  test('a [~] box is a distinct skipped state that counts as closed', () => {
    const acs = plan.tasks[0].acceptanceCriteria;
    assert.deepEqual(acs.map(a => [a.text, a.state, a.checked]), [
      ['Done criterion', 'done', true],
      ['Skipped criterion', 'skipped', true],
      ['Open criterion', 'open', false],
    ]);
    assert.equal(acs[1].skipDate, '2026-10-06');
    assert.equal(acs[1].skipReason, REASON);
    assert.equal(acs[1].skipProblem, undefined);
    assert.equal(acs[0].skipDate, undefined);
    assert.equal(plan.tasks[0].status, 'in_progress');
  });

  test('a task whose boxes are all done or skipped is done', () => {
    assert.equal(plan.tasks[1].status, 'done');
    assert.equal(plan.tasks[2].status, 'done');
  });

  test('nested criteria are read, and a [~] without its comment carries the PF6 problem', () => {
    const acs = plan.tasks[2].acceptanceCriteria;
    assert.equal(acs.length, 2);
    assert.equal(acs[0].skipProblem, undefined);
    assert.match(acs[1].skipProblem, /needs a comment on an indented continuation line/);
    assert.equal(acs[1].skipReason, undefined);
  });

  test('the skip comment line is not read as a criterion and stays in markdownSource', () => {
    assert.equal(plan.tasks[1].acceptanceCriteria.length, 2);
    assert.ok(plan.tasks[1].markdownSource.includes('*Skipped on 2026-10-06:'));
  });

  test('parseAcceptanceCriteria ignores fenced boxes', () => {
    const acs = parseAcceptanceCriteria(['- [ ] real', '```', '- [~] fenced', '```']);
    assert.deepEqual(acs, [{ text: 'real', checked: false, state: 'open' }]);
  });
});
