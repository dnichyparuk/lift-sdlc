'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  STATIC_GATE_IDS,
  extractTaskFiles,
  runStaticCritique,
} = require('./plan-static-critique');

const PLAN_SCRIPT = path.join(__dirname, '..', 'skill', 'plan.js');

function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-static-critique-'));
}

function writeFiles(root, fileMap) {
  for (const [rel, content] of Object.entries(fileMap)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

function makePlan(tasks) {
  const header = [
    '# Demo Implementation Plan',
    '',
    '**Goal:** Test static critique.',
    '**Architecture:** Modular scripts.',
    '**Source:** conversation context',
    '**Verification:** npm test',
    '',
    '---',
    '',
  ];
  const body = tasks.map(t => {
    const filesLines = [];
    for (const f of t.create || []) filesLines.push(`- Create: \`${f}\``);
    for (const f of t.modify || []) filesLines.push(`- Modify: \`${f}\` — update`);
    for (const f of t.testFiles || []) filesLines.push(`- Test: \`${f}\``);

    return [
      `### Task ${t.number}: ${t.title || `Step ${t.number}`}`,
      '',
      `**Complexity:** ${t.complexity || 'Standard'}`,
      `**Risk:** ${t.risk || 'Low'}`,
      `**Depends on:** ${t.dependsOn || 'none'}`,
      '**Verify:** tests',
      '',
      ...(filesLines.length > 0 ? ['**Files:**', ...filesLines, ''] : []),
      '**Description:**',
      t.description || 'Implement the step.',
      '',
      '**Acceptance criteria:**',
      '- [ ] Works as expected',
      '',
    ].join('\n');
  });
  return [...header, ...body].join('\n');
}

test('clean plan passes all four deterministic gates (G3, G4, G10, G12)', () => {
  const root = makeTempProject();
  try {
    writeFiles(root, {
      'src/existing.js': 'module.exports = 1;\n',
      'src/shared.js': 'module.exports = 2;\n',
    });
    const planText = makePlan([
      {
        number: 1,
        dependsOn: 'none',
        create: ['src/generated.js'],
        modify: ['src/existing.js', 'src/shared.js'],
        testFiles: ['src/existing.test.js'], // Test: exempt even if missing on disk
      },
      {
        number: 2,
        dependsOn: 'Task 1',
        modify: ['src/shared.js', 'src/generated.js'],
      },
    ]);
    const planPath = path.join(root, 'plan.md');
    fs.writeFileSync(planPath, planText, 'utf8');

    const res = runStaticCritique(planPath, root);
    assert.deepStrictEqual(res.gateIds, ['G3', 'G4', 'G10', 'G12']);
    assert.deepStrictEqual(res.issues, []);
    assert.deepStrictEqual(res.passes, ['G3', 'G4', 'G10', 'G12']);
    assert.strictEqual(res.laneStatus, 'ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('G3: detects circular dependencies across tasks and self-cycles', () => {
  const root = makeTempProject();
  try {
    writeFiles(root, { 'src/a.js': '1\n', 'src/b.js': '2\n' });
    const cyclePlan = makePlan([
      { number: 1, dependsOn: 'Task 2', modify: ['src/a.js'] },
      { number: 2, dependsOn: 'Task 1', modify: ['src/b.js'] },
    ]);
    const planPath = path.join(root, 'cycle-plan.md');
    fs.writeFileSync(planPath, cyclePlan, 'utf8');

    const res = runStaticCritique(planPath, root);
    assert.strictEqual(res.laneStatus, 'ok');
    const g3Issues = res.issues.filter(i => i.gateId === 'G3');
    assert.strictEqual(g3Issues.length, 1);
    assert.strictEqual(g3Issues[0].severity, 'error');
    assert.strictEqual(g3Issues[0].blocking, true);
    assert.match(g3Issues[0].message, /Circular dependency:/);
    assert.ok(!res.passes.includes('G3'));
    assert.deepStrictEqual(res.passes, ['G4', 'G10', 'G12']);

    // Self-cycle
    const selfPlan = makePlan([
      { number: 1, dependsOn: 'Task 1', modify: ['src/a.js'] },
    ]);
    const selfPath = path.join(root, 'self-cycle.md');
    fs.writeFileSync(selfPath, selfPlan, 'utf8');
    const selfRes = runStaticCritique(selfPath, root);
    assert.ok(selfRes.issues.some(i => i.gateId === 'G3' && /Task 1 -> Task 1/.test(i.message)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('G12: detects missing dependency target', () => {
  const root = makeTempProject();
  try {
    writeFiles(root, { 'src/a.js': '1\n' });
    const planText = makePlan([
      { number: 1, dependsOn: 'none', create: ['src/new.js'] },
      { number: 2, dependsOn: 'Task 99', modify: ['src/a.js'] },
    ]);
    const planPath = path.join(root, 'missing-dep.md');
    fs.writeFileSync(planPath, planText, 'utf8');

    const res = runStaticCritique(planPath, root);
    const g12Issues = res.issues.filter(i => i.gateId === 'G12');
    assert.strictEqual(g12Issues.length, 1);
    assert.strictEqual(g12Issues[0].taskRef, 'Task 2');
    assert.strictEqual(g12Issues[0].severity, 'error');
    assert.strictEqual(g12Issues[0].blocking, true);
    assert.match(g12Issues[0].message, /nonexistent Task 99/);
    assert.deepStrictEqual(res.passes, ['G3', 'G4', 'G10']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('G4: flags unsequenced shared Modify: conflicts and passes direct or transitive Depends on: ordering', () => {
  const root = makeTempProject();
  try {
    writeFiles(root, { 'src/shared.js': 'export default 0;\n', 'src/other.js': 'export default 1;\n' });

    // Conflict: Task 1 and Task 2 both modify src/shared.js (and test ./ normalization too)
    const conflictPlan = makePlan([
      { number: 1, dependsOn: 'none', modify: ['./src/shared.js'] },
      { number: 2, dependsOn: 'none', modify: ['src/shared.js'] },
    ]);
    const conflictPath = path.join(root, 'conflict.md');
    fs.writeFileSync(conflictPath, conflictPlan, 'utf8');

    const conflictRes = runStaticCritique(conflictPath, root);
    const g4Issues = conflictRes.issues.filter(i => i.gateId === 'G4');
    assert.strictEqual(g4Issues.length, 1);
    assert.strictEqual(g4Issues[0].taskRef, 'Task 2');
    assert.strictEqual(g4Issues[0].blocking, true);
    assert.match(g4Issues[0].message, /src\/shared\.js/);
    assert.match(g4Issues[0].message, /Task 1/);
    assert.match(g4Issues[0].message, /Task 2/);
    assert.ok(!conflictRes.passes.includes('G4'));

    // Transitive ordering: Task 1 -> Task 2 -> Task 3, where Task 1 and Task 3 both modify src/shared.js
    const transitivePlan = makePlan([
      { number: 1, dependsOn: 'none', modify: ['src/shared.js'] },
      { number: 2, dependsOn: 'Task 1', modify: ['src/other.js'] },
      { number: 3, dependsOn: 'Task 2', modify: ['src/shared.js'] },
    ]);
    const transitivePath = path.join(root, 'transitive.md');
    fs.writeFileSync(transitivePath, transitivePlan, 'utf8');

    const transitiveRes = runStaticCritique(transitivePath, root);
    assert.deepStrictEqual(transitiveRes.issues, []);
    assert.deepStrictEqual(transitiveRes.passes, STATIC_GATE_IDS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('G10: flags missing Modify: files and unsequenced Create: -> Modify: files, passes disk or explicit Depends on: Create:', () => {
  const root = makeTempProject();
  try {
    writeFiles(root, { 'src/real.js': 'ok\n' });

    // Missing completely on disk + not in Create:
    const missingPlan = makePlan([
      { number: 1, dependsOn: 'none', modify: ['src/real.js', 'src/does-not-exist.js'] },
    ]);
    const missingPath = path.join(root, 'missing-file.md');
    fs.writeFileSync(missingPath, missingPlan, 'utf8');

    const missingRes = runStaticCritique(missingPath, root);
    const g10Missing = missingRes.issues.filter(i => i.gateId === 'G10');
    assert.strictEqual(g10Missing.length, 1);
    assert.strictEqual(g10Missing[0].taskRef, 'Task 1');
    assert.match(g10Missing[0].message, /src\/does-not-exist\.js/);
    assert.ok(!missingRes.passes.includes('G10'));

    // Created in Task 2 (higher number, no dependency) while Task 1 tries to Modify it -> fails G10
    // Also same-task Create + Modify -> fails G10
    const badOrderPlan = makePlan([
      { number: 1, dependsOn: 'none', create: ['src/self.js'], modify: ['src/later.js', 'src/self.js'] },
      { number: 2, dependsOn: 'none', create: ['src/later.js'] },
    ]);
    const badOrderPath = path.join(root, 'bad-order.md');
    fs.writeFileSync(badOrderPath, badOrderPlan, 'utf8');

    const badOrderRes = runStaticCritique(badOrderPath, root);
    const g10Order = badOrderRes.issues.filter(i => i.gateId === 'G10');
    assert.strictEqual(g10Order.length, 2);
    assert.ok(g10Order.some(i => i.message.includes('src/later.js') && i.message.includes('Depends on: Task 2')));
    assert.ok(g10Order.some(i => i.message.includes('src/self.js') && i.message.includes('does not precede Task 1')));

    // Create: X in Task 1 -> Modify: X in Task 2 WITHOUT Depends on: Task 1 -> flags G10 ordering issue
    const missingDepPlan = makePlan([
      { number: 1, dependsOn: 'none', create: ['src/from-t1.js'] },
      { number: 2, dependsOn: 'none', modify: ['src/from-t1.js'] },
    ]);
    const missingDepPath = path.join(root, 'missing-dep-order.md');
    fs.writeFileSync(missingDepPath, missingDepPlan, 'utf8');

    const missingDepRes = runStaticCritique(missingDepPath, root);
    const g10MissingDep = missingDepRes.issues.filter(i => i.gateId === 'G10');
    assert.strictEqual(g10MissingDep.length, 1);
    assert.strictEqual(g10MissingDep[0].taskRef, 'Task 2');
    assert.match(g10MissingDep[0].message, /src\/from-t1\.js/);
    assert.match(g10MissingDep[0].message, /Depends on: Task 1/);
    assert.ok(!missingDepRes.passes.includes('G10'));

    // Create: X in Task 1 -> Modify: X in Task 2 WITH Depends on: Task 1 (and transitive Task 3 -> Task 2 -> Task 1) -> passes G10
    const goodOrderPlan = makePlan([
      { number: 1, dependsOn: 'none', create: ['src/from-t1.js'] },
      { number: 2, dependsOn: 'Task 1', modify: ['src/from-t1.js'] },
      { number: 3, dependsOn: 'Task 2', modify: ['src/from-t1.js'] },
    ]);
    const goodOrderPath = path.join(root, 'good-order.md');
    fs.writeFileSync(goodOrderPath, goodOrderPlan, 'utf8');

    const goodOrderRes = runStaticCritique(goodOrderPath, root);
    assert.deepStrictEqual(goodOrderRes.issues, []);
    assert.deepStrictEqual(goodOrderRes.passes, STATIC_GATE_IDS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extractTaskFiles ignores fenced code blocks inside Description', () => {
  const body = [
    '### Task 1: Demo',
    '',
    '**Files:**',
    '- Modify: `src/real.js` — update',
    '',
    '**Description:**',
    '```markdown',
    '- Modify: `src/fake-in-fence.js`',
    '- Create: `src/fake-created.js`',
    '```',
  ].join('\n');

  const files = extractTaskFiles(body);
  assert.deepStrictEqual(files.modify, ['src/real.js']);
  assert.deepStrictEqual(files.create, []);
});

test('CLI smoke: node scripts/skill/plan.js --critique-static --plan <tempPlan>', async () => {
  const root = makeTempProject();
  try {
    writeFiles(root, { 'src/app.js': 'console.log(1);\n' });

    const cleanPlanPath = path.join(root, 'clean.md');
    fs.writeFileSync(
      cleanPlanPath,
      makePlan([
        { number: 1, dependsOn: 'none', modify: ['src/app.js'], create: ['src/util.js'] },
        { number: 2, dependsOn: 'Task 1', modify: ['src/app.js', 'src/util.js'] },
      ]),
      'utf8'
    );

    const okRun = spawnSync(
      process.execPath,
      [PLAN_SCRIPT, '--critique-static', '--plan', cleanPlanPath],
      { cwd: root, encoding: 'utf8' }
    );
    assert.strictEqual(okRun.status, 0, okRun.stderr);
    const okJson = JSON.parse(okRun.stdout.trim());
    assert.deepStrictEqual(okJson, {
      gateIds: ['G3', 'G4', 'G10', 'G12'],
      issues: [],
      passes: ['G3', 'G4', 'G10', 'G12'],
      laneStatus: 'ok',
    });

    // Plan with issues still exits 0 (valid critique run) and reports issues in JSON
    const badPlanPath = path.join(root, 'issues.md');
    fs.writeFileSync(
      badPlanPath,
      makePlan([
        { number: 1, dependsOn: 'none', modify: ['src/app.js', 'src/ghost.js'] },
        { number: 2, dependsOn: 'none', modify: ['src/app.js'] },
      ]),
      'utf8'
    );

    const issueRun = spawnSync(
      process.execPath,
      [PLAN_SCRIPT, '--critique-static', '--plan', badPlanPath],
      { cwd: root, encoding: 'utf8' }
    );
    assert.strictEqual(issueRun.status, 0, issueRun.stderr);
    const issueJson = JSON.parse(issueRun.stdout.trim());
    assert.strictEqual(issueJson.laneStatus, 'ok');
    assert.ok(issueJson.issues.some(i => i.gateId === 'G4'));
    assert.ok(issueJson.issues.some(i => i.gateId === 'G10'));
    assert.deepStrictEqual(issueJson.passes, ['G3', 'G12']);

    // Missing/unreadable plan exits 1
    const missingFileRun = spawnSync(
      process.execPath,
      [PLAN_SCRIPT, '--critique-static', '--plan', path.join(root, 'nope.md')],
      { cwd: root, encoding: 'utf8' }
    );
    assert.strictEqual(missingFileRun.status, 1);

    const missingFlagRun = spawnSync(
      process.execPath,
      [PLAN_SCRIPT, '--critique-static'],
      { cwd: root, encoding: 'utf8' }
    );
    assert.strictEqual(missingFlagRun.status, 1);

    // Open stdin pipe does not hang --critique-static
    const openStdinResult = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [PLAN_SCRIPT, '--critique-static', '--plan', cleanPlanPath],
        { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ timedOut: true, code: null, stdout });
      }, 5000);
      child.on('close', code => {
        clearTimeout(timer);
        resolve({ timedOut: false, code, stdout });
      });
    });
    assert.strictEqual(openStdinResult.timedOut, false);
    assert.strictEqual(openStdinResult.code, 0);
    assert.strictEqual(JSON.parse(openStdinResult.stdout.trim()).laneStatus, 'ok');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
