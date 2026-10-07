'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { DeliveryGraphModel } = require('./model.js');

describe('model DeliveryGraphModel', () => {
  const sampleGraph = {
    version: '1.0.0',
    generatedAt: '2026-10-05T08:00:00Z',
    projects: [
      {
        id: 'proj-1',
        name: 'Project 1',
        repoPath: '/workspace/proj-1',
        plans: [
          {
            id: 'plan-1',
            title: 'Plan 1 Title',
            filePath: 'docs/plans/plan-1.md',
            status: 'in_progress',
            waves: [
              { id: 'wave-1', title: 'Wave 1', order: 1, status: 'completed', dependsOn: [] },
              { id: 'wave-2', title: 'Wave 2', order: 2, status: 'in_progress', dependsOn: ['wave-1'] }
            ],
            tasks: [
              {
                id: 'T1',
                slug: 't1',
                globalId: 'urn:sdlc:proj-1:plan-1:T1',
                title: 'Task 1: Foundation',
                waveId: 'wave-1',
                status: 'done',
                dependsOn: [],
                files: { create: ['src/core.js'], modify: [], delete: [], test: ['test/core.test.js'] },
                acceptanceCriteria: [{ text: 'Works', checked: true }],
                isReadyToDispatch: false
              },
              {
                id: 'T2',
                slug: 't2',
                globalId: 'urn:sdlc:proj-1:plan-1:T2',
                title: 'Task 2: Extension',
                waveId: 'wave-2',
                status: 'todo',
                dependsOn: ['urn:sdlc:proj-1:plan-1:T1'],
                files: { create: [], modify: ['src/core.js'], delete: [], test: [] },
                acceptanceCriteria: [{ text: 'Extended', checked: false }],
                isReadyToDispatch: true
              },
              {
                id: 'T3',
                slug: 't3',
                globalId: 'urn:sdlc:proj-1:plan-1:T3',
                title: 'Task 3: Integration',
                waveId: 'wave-2',
                status: 'todo',
                dependsOn: ['urn:sdlc:proj-1:plan-1:T2'],
                files: { create: [], modify: ['src/app.js'], delete: [], test: [] },
                acceptanceCriteria: [{ text: 'Integrated', checked: false }],
                isReadyToDispatch: false
              }
            ]
          }
        ],
        todos: []
      }
    ]
  };

  test('indexes and retrieves projects, plans, and tasks', () => {
    const model = new DeliveryGraphModel(sampleGraph);
    assert.equal(model.getProjects().length, 1);
    assert.equal(model.getProject('proj-1').name, 'Project 1');
    assert.equal(model.getPlans('proj-1').length, 1);

    const plan = model.getPlan('proj-1', 'plan-1');
    assert.ok(plan);
    assert.equal(plan.title, 'Plan 1 Title');

    const taskById = model.getTask('proj-1', 'plan-1', 'T2');
    assert.equal(taskById.title, 'Task 2: Extension');

    const taskBySlug = model.getTask('proj-1', 'plan-1', 't2');
    assert.equal(taskBySlug.id, 'T2');

    const taskByGlobal = model.getTask('proj-1', 'plan-1', 'urn:sdlc:proj-1:plan-1:T2');
    assert.equal(taskByGlobal.id, 'T2');
  });

  test('resolves upstream and downstream dependencies', () => {
    const model = new DeliveryGraphModel(sampleGraph);
    const depsT2 = model.getDependencies('urn:sdlc:proj-1:plan-1:T2');

    assert.equal(depsT2.upstream.length, 1);
    assert.equal(depsT2.upstream[0].id, 'T1');

    assert.equal(depsT2.downstream.length, 1);
    assert.equal(depsT2.downstream[0].id, 'T3');
  });

  test('topologicalSort returns tasks in dependency order', () => {
    const model = new DeliveryGraphModel(sampleGraph);
    const tasks = model.getTasks('proj-1', 'plan-1');
    const sorted = model.topologicalSort(tasks);

    assert.equal(sorted[0].id, 'T1');
    assert.equal(sorted[1].id, 'T2');
    assert.equal(sorted[2].id, 'T3');
  });

  test('getCriticalPath finds longest dependency chain', () => {
    const model = new DeliveryGraphModel(sampleGraph);
    const criticalPath = model.getCriticalPath('proj-1', 'plan-1');

    assert.equal(criticalPath.length, 3);
    assert.equal(criticalPath[0].id, 'T1');
    assert.equal(criticalPath[1].id, 'T2');
    assert.equal(criticalPath[2].id, 'T3');
  });

  test('getReadyToDispatchTasks returns tasks ready for execution', () => {
    const model = new DeliveryGraphModel(sampleGraph);
    const ready = model.getReadyToDispatchTasks('proj-1', 'plan-1');

    assert.equal(ready.length, 1);
    assert.equal(ready[0].id, 'T2');
  });

  test('filterTasks searches by query across fields and file paths', () => {
    const model = new DeliveryGraphModel(sampleGraph);
    const tasks = model.getTasks('proj-1', 'plan-1');

    // Query title
    const res1 = model.filterTasks(tasks, { query: 'Foundation' });
    assert.equal(res1.length, 1);
    assert.equal(res1[0].id, 'T1');

    // Query file path in create
    const res2 = model.filterTasks(tasks, { query: 'core.js' });
    assert.equal(res2.length, 2); // T1 creates it, T2 modifies it

    // Query test file path
    const res3 = model.filterTasks(tasks, { query: 'core.test.js' });
    assert.equal(res3.length, 1);

    // Filter by status 'ready'
    const resReady = model.filterTasks(tasks, { status: 'ready' });
    assert.equal(resReady.length, 1);
    assert.equal(resReady[0].id, 'T2');

    // Filter by status 'done'
    const resDone = model.filterTasks(tasks, { status: 'done' });
    assert.equal(resDone.length, 1);
    assert.equal(resDone[0].id, 'T1');
  });

  test('calculateMetrics computes KPIs and progress %', () => {
    const model = new DeliveryGraphModel(sampleGraph);
    const metrics = model.calculateMetrics('proj-1', 'plan-1');

    assert.equal(metrics.total, 3);
    assert.equal(metrics.done, 1);
    assert.equal(metrics.donePct, 33);
    assert.equal(metrics.todo, 2);
    assert.equal(metrics.readyToDispatch, 1);
    assert.equal(metrics.wavesCount, 2);
    assert.equal(metrics.wavesCompleted, 1);
  });

  test('getEnrichedPlans computes requiresWork, workStatus and plan relationships', () => {
    const model = new DeliveryGraphModel(sampleGraph);
    const enriched = model.getEnrichedPlans('proj-1');

    assert.equal(enriched.length, 1);
    const p1 = enriched[0];
    assert.equal(p1.id, 'plan-1');
    assert.equal(p1.requiresWork, true);
    assert.equal(p1.workStatus, 'in_progress');
    assert.equal(p1.metrics.total, 3);
  });

  test('getPlanDependencyGraph computes topological tiers, SVG bezier edges, and handles standalone plans', () => {
    const multiPlanGraph = {
      version: '1.0.0',
      projects: [
        {
          id: 'proj-multi',
          name: 'Multi Plan Project',
          plans: [
            {
              id: 'plan-root',
              title: 'Root Architecture',
              filePath: 'docs/plans/plan-root.md',
              status: 'done',
              tasks: [{ id: 'R1', globalId: 'urn:sdlc:proj-multi:plan-root:R1', dependsOn: [] }]
            },
            {
              id: 'plan-sub',
              title: 'Subsystem Plan',
              filePath: 'docs/plans/plan-sub.md',
              sourcePlanPath: 'docs/plans/plan-root.md',
              status: 'in_progress',
              tasks: [{ id: 'S1', globalId: 'urn:sdlc:proj-multi:plan-sub:S1', dependsOn: ['urn:sdlc:proj-multi:plan-root:R1'] }]
            },
            {
              id: 'plan-leaf',
              title: 'Leaf Plan',
              filePath: 'docs/plans/plan-leaf.md',
              sourcePlanPath: 'docs/plans/plan-sub.md',
              status: 'actionable',
              tasks: [{ id: 'L1', globalId: 'urn:sdlc:proj-multi:plan-leaf:L1', dependsOn: ['urn:sdlc:proj-multi:plan-sub:S1'] }]
            },
            {
              id: 'plan-standalone',
              title: 'Isolated Utility Plan',
              filePath: 'docs/plans/plan-standalone.md',
              status: 'done',
              tasks: [{ id: 'U1', globalId: 'urn:sdlc:proj-multi:plan-standalone:U1', dependsOn: [] }]
            }
          ],
          todos: []
        }
      ]
    };

    const model = new DeliveryGraphModel(multiPlanGraph);
    const graph = model.getPlanDependencyGraph('proj-multi');

    assert.equal(graph.nodes.length, 4);
    assert.equal(graph.cycleDetected, false);
    assert.equal(graph.cycleEdges.length, 0);

    const rootNode = graph.nodes.find(n => n.id === 'plan-root');
    const subNode = graph.nodes.find(n => n.id === 'plan-sub');
    const leafNode = graph.nodes.find(n => n.id === 'plan-leaf');
    const standaloneNode = graph.nodes.find(n => n.id === 'plan-standalone');

    assert.equal(rootNode.tier, 0);
    assert.equal(subNode.tier, 1);
    assert.equal(leafNode.tier, 2);
    assert.equal(standaloneNode.tier, -1);
    assert.equal(standaloneNode.tierName, 'Standalone Utility Plans');

    // Standalone column placed after maxTier
    assert.ok(standaloneNode.x > leafNode.x);

    // Edges exist and have cubic bezier format
    assert.ok(graph.edges.length >= 2);
    graph.edges.forEach(e => {
      assert.ok(e.d.startsWith('M '));
      assert.ok(e.d.includes(' C '));
    });
  });

  test('getPlanDependencyGraph detects and isolates circular feedback edges', () => {
    const cyclicGraph = {
      version: '1.0.0',
      projects: [
        {
          id: 'proj-cycle',
          name: 'Cyclic Project',
          plans: [
            {
              id: 'plan-a',
              title: 'Plan A',
              filePath: 'docs/plans/plan-a.md',
              sourcePlanPath: 'docs/plans/plan-b.md',
              tasks: [{ id: 'A1', globalId: 'urn:a1', dependsOn: ['urn:b1'] }]
            },
            {
              id: 'plan-b',
              title: 'Plan B',
              filePath: 'docs/plans/plan-b.md',
              sourcePlanPath: 'docs/plans/plan-a.md',
              tasks: [{ id: 'b1', globalId: 'urn:b1', dependsOn: ['urn:a1'] }]
            }
          ],
          todos: []
        }
      ]
    };

    const model = new DeliveryGraphModel(cyclicGraph);
    const graph = model.getPlanDependencyGraph('proj-cycle');

    assert.equal(graph.nodes.length, 2);
    assert.equal(graph.cycleDetected, true);
    assert.ok(graph.cycleEdges.length > 0);
    const cycleEdge = graph.cycleEdges[0];
    assert.equal(cycleEdge.isCycle, true);
    // Cycle edges connect bottom ports with downward loop
    assert.ok(cycleEdge.d.includes('C '));
  });
});
