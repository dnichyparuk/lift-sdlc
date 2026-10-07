'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  reconcileProject,
  matchExecutionToPlan,
  applyExecutionToPlan,
  bindTodosAndBlockers,
  normalizePath
} = require('./reconciler.js');

describe('reconciler', () => {
  test('normalizePath cleans slashes and strips repo path prefix', () => {
    assert.equal(normalizePath('docs/plans/p1.md'), 'docs/plans/p1.md');
    assert.equal(normalizePath('/workspace/proj/docs/p1.md', '/workspace/proj'), 'docs/p1.md');
    assert.equal(normalizePath('\\docs\\plans\\p1.md'), 'docs/plans/p1.md');
  });

  test('3-tier matcher resolves by exact path, hash, and basename', () => {
    const plans = [
      { id: 'p1', filePath: 'docs/plans/plan-alpha.md' },
      { id: 'p2', filePath: 'docs/plans/plan-beta.md' },
      { id: 'p3', filePath: 'docs/archived/plans/plan-archived.md' }
    ];

    const planHashMap = new Map([
      ['docs/plans/plan-alpha.md', 'hash-alpha'],
      ['docs/plans/plan-beta.md', 'hash-beta'],
      ['docs/archived/plans/plan-archived.md', 'hash-archived-123']
    ]);

    // Tier 1: exact path
    const m1 = matchExecutionToPlan(
      { planPath: 'docs/plans/plan-alpha.md', planHash: 'different-hash' },
      plans,
      '/repo',
      planHashMap
    );
    assert.equal(m1.id, 'p1');

    // Tier 2: hash match when path was renamed
    const m2 = matchExecutionToPlan(
      { planPath: 'docs/old-path/plan-moved.md', planHash: 'hash-archived-123' },
      plans,
      '/repo',
      planHashMap
    );
    assert.equal(m2.id, 'p3');

    // Tier 3: basename match
    const m3 = matchExecutionToPlan(
      { planPath: '/other/path/plan-beta.md', planHash: 'nomatch' },
      plans,
      '/repo',
      planHashMap
    );
    assert.equal(m3.id, 'p2');
  });

  test('applies execution run, updates task statuses, and computes driftStatus', () => {
    const plan = {
      id: 'p1',
      filePath: 'docs/plans/p1.md',
      status: 'proposed',
      executionRuns: [],
      waves: [
        { id: 'wave-1', title: 'Wave 1', order: 1, status: 'planned', dependsOn: [] }
      ],
      tasks: [
        {
          id: '1',
          globalId: 'urn:sdlc:proj:p1:1',
          title: 'Task 1',
          waveId: 'wave-1',
          status: 'todo',
          dependsOn: [],
          files: { create: [], modify: [], delete: [], test: [] },
          acceptanceCriteria: []
        },
        {
          id: '2',
          globalId: 'urn:sdlc:proj:p1:2',
          title: 'Task 2',
          waveId: 'wave-1',
          status: 'todo',
          dependsOn: ['urn:sdlc:proj:p1:1'],
          files: { create: [], modify: [], delete: [], test: [] },
          acceptanceCriteria: []
        }
      ]
    };

    const execData = {
      planPath: 'docs/plans/p1.md',
      planHash: 'hash-111',
      branch: 'feat/test',
      startedAt: '2026-10-01T10:00:00Z',
      waves: [
        {
          number: 1,
          completedAt: '2026-10-01T10:30:00Z',
          tasks: [
            {
              id: '1',
              name: 'Task 1',
              status: 'completed',
              filesChanged: ['src/index.js']
            }
          ]
        }
      ]
    };

    // Plan hash differs -> drifted
    applyExecutionToPlan(plan, execData, '.sdlc/execution/execute-1.json', 'current-hash-222');

    assert.equal(plan.executionRuns.length, 1);
    assert.equal(plan.executionRuns[0].driftStatus, 'drifted');
    assert.equal(plan.executionRuns[0].completedAt, '2026-10-01T10:30:00Z');

    assert.equal(plan.tasks[0].status, 'done');
    assert.deepEqual(plan.tasks[0].files.modify, ['src/index.js']);
    assert.equal(plan.tasks[0].statusEvidence.executionLog, 'execute-1.json');

    assert.equal(plan.tasks[1].status, 'todo');
  });

  test('bindTodosAndBlockers links blockers and calculates isReadyToDispatch', () => {
    const plans = [
      {
        id: 'plan-1',
        filePath: 'docs/plans/plan-1.md',
        tasks: [
          {
            id: 'T1',
            globalId: 'urn:sdlc:proj:plan-1:T1',
            title: 'Task 1',
            status: 'done',
            dependsOn: []
          },
          {
            id: 'T2',
            globalId: 'urn:sdlc:proj:plan-1:T2',
            title: 'Task 2',
            status: 'todo',
            dependsOn: ['urn:sdlc:proj:plan-1:T1']
          },
          {
            id: 'T3',
            globalId: 'urn:sdlc:proj:plan-1:T3',
            title: 'Task 3',
            status: 'todo',
            dependsOn: ['urn:sdlc:proj:plan-1:T2']
          },
          {
            id: 'T4',
            globalId: 'urn:sdlc:proj:plan-1:T4',
            title: 'Task 4',
            status: 'todo',
            dependsOn: []
          }
        ]
      }
    ];

    const todos = [
      {
        id: '001-fix-bug',
        title: 'Fix critical bug',
        status: 'open',
        priority: 'P0',
        relatedPlan: 'plan-1',
        blocks: 'Blocks Task 4 completion'
      }
    ];

    bindTodosAndBlockers(plans, todos);

    const t1 = plans[0].tasks.find(t => t.id === 'T1');
    const t2 = plans[0].tasks.find(t => t.id === 'T2');
    const t3 = plans[0].tasks.find(t => t.id === 'T3');
    const t4 = plans[0].tasks.find(t => t.id === 'T4');

    // T1 is done -> not ready to dispatch
    assert.equal(t1.isReadyToDispatch, false);

    // T2 is todo, upstream T1 is done, no blockers -> ready to dispatch!
    assert.equal(t2.isReadyToDispatch, true);

    // T3 is todo, upstream T2 is todo (not done) -> not ready
    assert.equal(t3.isReadyToDispatch, false);

    // T4 is blocked by P0 todo -> marked blocked and not ready to dispatch
    assert.equal(t4.status, 'blocked');
    assert.equal(t4.isReadyToDispatch, false);
    assert.deepEqual(t4.blockedByTodoIds, ['001-fix-bug']);
    assert.deepEqual(todos[0].blockedTaskGlobalIds, ['urn:sdlc:proj:plan-1:T4']);
  });

  test('reconciles actual real projects if present', () => {
    const robotDir = '/home/dzmitry/projects/trade-robot-alpha';
    if (!fs.existsSync(robotDir)) return;

    const project = {
      id: 'trade-robot-alpha',
      name: 'Trade Robot Alpha',
      repoPath: robotDir,
      plans: [
        {
          id: 'safety-hardening',
          filePath: 'docs/plans/2026-09-30-paper-live-batch4-part1-safety-hardening.md',
          status: 'proposed',
          executionRuns: [],
          waves: [{ id: 'wave-1', title: 'Wave 1', order: 1, status: 'planned', dependsOn: [] }],
          tasks: [
            {
              id: '1',
              globalId: 'urn:sdlc:trade-robot-alpha:safety-hardening:1',
              title: 'PLR-10a',
              waveId: 'wave-1',
              status: 'todo',
              dependsOn: [],
              files: { create: [], modify: [], delete: [], test: [] },
              acceptanceCriteria: []
            }
          ]
        }
      ],
      todos: []
    };

    reconcileProject(project);

    // Should have matched execute-feat-paper-live-batch4-part1-20261001T190318Z.json
    assert.ok(project.plans[0].executionRuns.length > 0);
    assert.equal(project.plans[0].tasks[0].status, 'done');
  });
});
