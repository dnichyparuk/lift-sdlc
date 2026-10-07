'use strict';

/**
 * model.js
 * Pure Headless Domain Model for DeliveryGraph.
 * Provides topological DAG sorting, dependency graph resolution, critical path analysis,
 * task filtering, and metric calculations. Zero DOM dependencies.
 */

class DeliveryGraphModel {
  /**
   * @param {object} graphData - Full canonical delivery graph object
   */
  constructor(graphData) {
    this.data = graphData || { version: '1.0.0', generatedAt: new Date().toISOString(), projects: [] };
    this._index();
  }

  _index() {
    this.tasksByGlobalId = new Map();
    this.todosById = new Map();

    for (const project of this.data.projects || []) {
      for (const todo of project.todos || []) {
        this.todosById.set(todo.id, todo);
      }
      for (const plan of project.plans || []) {
        for (const task of plan.tasks || []) {
          this.tasksByGlobalId.set(task.globalId, task);
        }
      }
    }
  }

  getProjects() {
    return this.data.projects || [];
  }

  getProject(projectId) {
    return (this.data.projects || []).find(p => p.id === projectId) || null;
  }

  getPlans(projectId) {
    const project = this.getProject(projectId);
    return project ? project.plans || [] : [];
  }

  getPlan(projectId, planId) {
    const plans = this.getPlans(projectId);
    return plans.find(p => p.id === planId) || null;
  }

  getTasks(projectId, planId) {
    const plan = this.getPlan(projectId, planId);
    return plan ? plan.tasks || [] : [];
  }

  getTask(projectId, planId, taskIdOrSlugOrGlobal) {
    const tasks = this.getTasks(projectId, planId);
    return tasks.find(t =>
      t.id === taskIdOrSlugOrGlobal ||
      t.slug === taskIdOrSlugOrGlobal ||
      t.globalId === taskIdOrSlugOrGlobal
    ) || null;
  }

  /**
   * Get upstream (what this task depends on) and downstream (what depends on this task) tasks.
   * @param {string} taskGlobalId
   * @returns {{ upstream: Array<object>, downstream: Array<object> }}
   */
  getDependencies(taskGlobalId) {
    const target = this.tasksByGlobalId.get(taskGlobalId);
    if (!target) return { upstream: [], downstream: [] };

    // Upstream: all tasks in target.dependsOn
    const upstream = [];
    for (const depId of target.dependsOn || []) {
      const depTask = this.tasksByGlobalId.get(depId);
      if (depTask) upstream.push(depTask);
    }

    // Downstream: all tasks across the workspace that list target.globalId or target.id in dependsOn
    const downstream = [];
    for (const task of this.tasksByGlobalId.values()) {
      if (Array.isArray(task.dependsOn) && (task.dependsOn.includes(target.globalId) || task.dependsOn.includes(target.id))) {
        downstream.push(task);
      }
    }

    return { upstream, downstream };
  }

  /**
   * Topological DAG sort of tasks.
   * @param {Array<object>} tasks
   * @returns {Array<object>}
   */
  topologicalSort(tasks) {
    const taskMap = new Map(tasks.map(t => [t.globalId, t]));
    const localIdMap = new Map(tasks.map(t => [t.id, t]));
    const inDegree = new Map();
    const adj = new Map();

    for (const task of tasks) {
      inDegree.set(task.globalId, 0);
      adj.set(task.globalId, []);
    }

    for (const task of tasks) {
      for (const dep of task.dependsOn || []) {
        const depTask = taskMap.get(dep) || localIdMap.get(dep);
        if (depTask) {
          adj.get(depTask.globalId).push(task.globalId);
          inDegree.set(task.globalId, inDegree.get(task.globalId) + 1);
        }
      }
    }

    const queue = [];
    for (const [gid, deg] of inDegree.entries()) {
      if (deg === 0) queue.push(gid);
    }

    const sorted = [];
    while (queue.length > 0) {
      const gid = queue.shift();
      const task = taskMap.get(gid);
      if (task) sorted.push(task);

      for (const nextGid of adj.get(gid) || []) {
        inDegree.set(nextGid, inDegree.get(nextGid) - 1);
        if (inDegree.get(nextGid) === 0) {
          queue.push(nextGid);
        }
      }
    }

    // If there is a cycle, append remaining unvisited tasks in original order
    if (sorted.length < tasks.length) {
      for (const task of tasks) {
        if (!sorted.includes(task)) {
          sorted.push(task);
        }
      }
    }

    return sorted;
  }

  /**
   * Calculate Critical Path (longest dependency sequence) for a plan.
   * @param {string} projectId
   * @param {string} planId
   * @returns {Array<object>} List of tasks forming the longest critical path
   */
  getCriticalPath(projectId, planId) {
    const tasks = this.getTasks(projectId, planId);
    if (tasks.length === 0) return [];

    const sorted = this.topologicalSort(tasks);
    const dist = new Map();
    const prev = new Map();

    for (const t of tasks) {
      dist.set(t.globalId, 1);
      prev.set(t.globalId, null);
    }

    const taskMap = new Map(tasks.map(t => [t.globalId, t]));
    const localIdMap = new Map(tasks.map(t => [t.id, t]));

    for (const u of sorted) {
      const uDist = dist.get(u.globalId);
      for (const dep of u.dependsOn || []) {
        const depTask = taskMap.get(dep) || localIdMap.get(dep);
        if (depTask) {
          const vDist = dist.get(depTask.globalId);
          if (vDist + 1 > uDist) {
            dist.set(u.globalId, vDist + 1);
            prev.set(u.globalId, depTask.globalId);
          }
        }
      }
    }

    // Find task with maximum distance
    let maxDist = 0;
    let maxTaskGid = null;
    for (const [gid, d] of dist.entries()) {
      if (d > maxDist) {
        maxDist = d;
        maxTaskGid = gid;
      }
    }

    const path = [];
    let curr = maxTaskGid;
    while (curr) {
      const task = taskMap.get(curr);
      if (task) path.unshift(task);
      curr = prev.get(curr);
    }

    return path;
  }

  /**
   * Get tasks ready to dispatch:
   * status === 'todo', all dependsOn tasks are 'done', no active P0 TODO blockers.
   * @param {string} projectId
   * @param {string} planId
   * @returns {Array<object>}
   */
  getReadyToDispatchTasks(projectId, planId) {
    const tasks = this.getTasks(projectId, planId);
    return tasks.filter(t => t.isReadyToDispatch === true);
  }

  /**
   * Filter tasks by search query and status filter.
   * Search checks: id, title, markdownSource, files.create, files.modify, files.delete, files.test.
   * Status filter options: 'all', 'done', 'in_progress', 'blocked', 'todo', 'partly', 'ready'.
   *
   * @param {Array<object>} tasks
   * @param {object} options
   * @param {string} [options.query='']
   * @param {string} [options.status='all']
   * @returns {Array<object>}
   */
  filterTasks(tasks, options = {}) {
    const { query = '', status = 'all' } = options;
    const q = query.trim().toLowerCase();

    return tasks.filter(task => {
      // 1. Status Filter
      if (status === 'ready') {
        if (!task.isReadyToDispatch) return false;
      } else if (status !== 'all') {
        if (task.status !== status) return false;
      }

      // 2. Query Search
      if (!q) return true;

      if (task.id.toLowerCase().includes(q)) return true;
      if (task.title && task.title.toLowerCase().includes(q)) return true;
      if (task.globalId && task.globalId.toLowerCase().includes(q)) return true;
      if (task.markdownSource && task.markdownSource.toLowerCase().includes(q)) return true;

      // Check files
      const files = task.files || {};
      for (const op of ['create', 'modify', 'delete', 'test']) {
        const fileList = files[op] || [];
        for (const f of fileList) {
          if (f.toLowerCase().includes(q)) return true;
        }
      }

      return false;
    });
  }

  /**
   * Calculate summary metrics for a plan.
   * @param {string} projectId
   * @param {string} planId
   * @returns {object}
   */
  calculateMetrics(projectId, planId) {
    const plan = this.getPlan(projectId, planId);
    if (!plan) {
      return {
        total: 0,
        done: 0,
        donePct: 0,
        inProgress: 0,
        blocked: 0,
        todo: 0,
        partly: 0,
        readyToDispatch: 0,
        wavesCount: 0,
        wavesCompleted: 0
      };
    }

    const tasks = plan.tasks || [];
    const total = tasks.length;
    const done = tasks.filter(t => t.status === 'done').length;
    const inProgress = tasks.filter(t => t.status === 'in_progress').length;
    const blocked = tasks.filter(t => t.status === 'blocked').length;
    const partly = tasks.filter(t => t.status === 'partly').length;
    const todo = tasks.filter(t => t.status === 'todo').length;
    const readyToDispatch = tasks.filter(t => t.isReadyToDispatch === true).length;

    const donePct = total > 0 ? Math.round((done / total) * 100) : 0;

    const waves = plan.waves || [];
    const wavesCount = waves.length;
    const wavesCompleted = waves.filter(w => w.status === 'completed').length;

    return {
      total,
      done,
      donePct,
      inProgress,
      blocked,
      todo,
      partly,
      readyToDispatch,
      wavesCount,
      wavesCompleted
    };
  }

  getEnrichedPlans(projectId) {
    const project = this.getProject(projectId);
    if (!project) return [];

    const plans = project.plans || [];
    const todos = project.todos || [];

    const planById = new Map();
    const planByBasename = new Map();

    for (const p of plans) {
      planById.set(p.id, p);
      const base = (p.filePath || '').split('/').pop() || p.id;
      planByBasename.set(base, p);
      planByBasename.set(base.replace(/\.md$/, ''), p);
    }

    return plans.map((plan) => {
      const metrics = this.calculateMetrics(projectId, plan.id);

      // 1. Linked Todos & Blockers
      const linkedTodos = todos.filter((todo) => {
        if (todo.relatedPlan && (todo.relatedPlan === plan.id || plan.filePath.includes(todo.relatedPlan))) {
          return true;
        }
        if (todo.blocks) {
          const blocksLower = todo.blocks.toLowerCase();
          if (blocksLower.includes(plan.id.toLowerCase())) return true;
          for (const task of plan.tasks || []) {
            if (blocksLower.includes(task.id.toLowerCase()) || (task.slug && blocksLower.includes(task.slug))) {
              return true;
            }
          }
        }
        return false;
      });

      // 2. Upstream Plans (plans this plan depends on or derives from)
      const upstreamPlans = [];
      const upstreamPlanIds = new Set();

      const fullSourceText = [
        plan.sourcePlanPath || '',
        plan.goal || '',
        plan.architectureSummary || ''
      ].join(' ');

      for (const other of plans) {
        if (other.id === plan.id) continue;
        const otherBase = (other.filePath || '').split('/').pop() || other.id;
        const otherClean = otherBase.replace(/\.md$/, '');
        if (otherClean.length < 5) continue;

        const escapedId = other.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedBase = otherBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedClean = otherClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const regex = new RegExp(`\\b(?:${escapedId}|${escapedBase}|${escapedClean})\\b`, 'i');
        if (regex.test(fullSourceText)) {
          if (!upstreamPlanIds.has(other.id)) {
            upstreamPlanIds.add(other.id);
            upstreamPlans.push({
              id: other.id,
              title: other.title,
              filePath: other.filePath
            });
          }
        }
      }

      // 3. Downstream Plans (other plans in project that cite this plan)
      const downstreamPlans = [];
      const downstreamPlanIds = new Set();

      const thisBase = (plan.filePath || '').split('/').pop() || plan.id;
      const thisClean = thisBase.replace(/\.md$/, '');
      if (thisClean.length >= 5) {
        const escapedThisId = plan.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedThisBase = thisBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escapedThisClean = thisClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const thisRegex = new RegExp(`\\b(?:${escapedThisId}|${escapedThisBase}|${escapedThisClean})\\b`, 'i');

        for (const other of plans) {
          if (other.id === plan.id) continue;
          const otherSourceText = [
            other.sourcePlanPath || '',
            other.goal || '',
            other.architectureSummary || ''
          ].join(' ');

          if (thisRegex.test(otherSourceText)) {
            if (!downstreamPlanIds.has(other.id)) {
              downstreamPlanIds.add(other.id);
              downstreamPlans.push({
                id: other.id,
                title: other.title,
                filePath: other.filePath
              });
            }
          }
        }
      }

      // 4. Work Status
      const isArchived = plan.status === 'archived' || (plan.filePath || '').includes('/archived/');
      const hasBlockers = metrics.blocked > 0 || plan.status === 'blocked' || linkedTodos.some(t => t.priority === 'P0' || t.status === 'blocked');
      const hasActiveWork = metrics.inProgress > 0 || plan.status === 'in_progress';
      const hasReadyTasks = metrics.readyToDispatch > 0;
      const isComplete = (metrics.total > 0 && metrics.donePct === 100) || plan.status === 'done';

      let workStatus = 'actionable';
      if (isArchived) {
        workStatus = 'archived';
      } else if (hasBlockers) {
        workStatus = 'blocked';
      } else if (hasActiveWork) {
        workStatus = 'in_progress';
      } else if (hasReadyTasks) {
        workStatus = 'actionable';
      } else if (isComplete) {
        workStatus = 'done';
      } else if (metrics.total === 0 || plan.status === 'proposed') {
        workStatus = 'proposed';
      }

      const requiresWork = !isArchived && !isComplete && (metrics.todo > 0 || metrics.inProgress > 0 || metrics.blocked > 0 || metrics.total === 0);

      return {
        ...plan,
        metrics,
        requiresWork,
        workStatus,
        linkedTodos,
        upstreamPlans,
        downstreamPlans
      };
    });
  }

  /**
   * Generates layouted visual plan dependency graph with topological Sugiyama tiers,
   * 3-color DFS cycle breaking, barycenter ordering, and cubic bezier SVG edges.
   * @param {string} projectId
   * @returns {object}
   */
  getPlanDependencyGraph(projectId) {
    const enrichedPlans = this.getEnrichedPlans(projectId);
    // Filter out documentation overview and guideline files from the plan DAG
    const activePlans = (enrichedPlans || []).filter(p => {
      const b = ((p.filePath || p.id).split('/').pop() || '').toLowerCase();
      return !b.startsWith('readme') && !b.startsWith('plan_guidelines');
    });

    if (activePlans.length === 0) {
      return { projectId, nodes: [], edges: [], tiers: [], cycleDetected: false, cycleEdges: [] };
    }

    const planMap = new Map();
    const idOrBasenameMap = new Map();

    activePlans.forEach(p => {
      planMap.set(p.id, p);
      idOrBasenameMap.set(p.id, p.id);
      const base = (p.filePath || '').split('/').pop() || p.id;
      idOrBasenameMap.set(base, p.id);
      idOrBasenameMap.set(base.replace(/\.md$/, ''), p.id);
    });

    const taskToPlanId = new Map();
    activePlans.forEach(p => {
      for (const t of p.tasks || []) {
        taskToPlanId.set(t.globalId, p.id);
        taskToPlanId.set(t.id, p.id);
      }
    });

    // Step 1: Build Directed Adjacency Lists
    const adj = new Map(); // from -> Set<to>
    const revAdj = new Map(); // to -> Set<from>
    activePlans.forEach(p => {
      adj.set(p.id, new Set());
      revAdj.set(p.id, new Set());
    });

    activePlans.forEach(plan => {
      // 1a. upstreamPlans reference
      for (const up of plan.upstreamPlans || []) {
        const upId = idOrBasenameMap.get(up.id) || up.id;
        if (planMap.has(upId) && upId !== plan.id) {
          adj.get(upId).add(plan.id);
          revAdj.get(plan.id).add(upId);
        }
      }

      // 1b. sourcePlanPath reference via regex matching of known plan IDs & filenames
      if (plan.sourcePlanPath) {
        for (const [key, targetPlanId] of idOrBasenameMap.entries()) {
          if (key.length < 5 || targetPlanId === plan.id) continue;
          const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(`\\b${escaped}\\b`, 'i');
          if (regex.test(plan.sourcePlanPath)) {
            adj.get(targetPlanId).add(plan.id);
            revAdj.get(plan.id).add(targetPlanId);
          }
        }
      }

      // 1c. Inter-plan task dependencies
      for (const task of plan.tasks || []) {
        for (const depId of task.dependsOn || []) {
          const parentPlanId = taskToPlanId.get(depId);
          if (parentPlanId && parentPlanId !== plan.id && planMap.has(parentPlanId)) {
            adj.get(parentPlanId).add(plan.id);
            revAdj.get(plan.id).add(parentPlanId);
          }
        }
      }
    });

    // Step 2: Cycle Detection & Breaking using 3-Color DFS
    const visitState = new Map();
    const cycleEdgePairs = new Set();
    const dagAdj = new Map();

    activePlans.forEach(p => {
      visitState.set(p.id, 0);
      dagAdj.set(p.id, new Set());
    });

    const dfs = (u) => {
      visitState.set(u, 1);

      for (const v of adj.get(u) || []) {
        const vState = visitState.get(v) || 0;
        if (vState === 1) {
          cycleEdgePairs.add(`${u}->${v}`);
        } else {
          if (vState === 0) {
            dfs(v);
          }
          dagAdj.get(u).add(v);
        }
      }

      visitState.set(u, 2);
    };

    activePlans.forEach(p => {
      if (visitState.get(p.id) === 0) {
        dfs(p.id);
      }
    });

    // Step 3: Layering & Tier Assignment on DAG (Longest Path Leveling)
    const inDegree = new Map();
    activePlans.forEach(p => inDegree.set(p.id, 0));

    for (const [, targets] of dagAdj.entries()) {
      for (const v of targets) {
        inDegree.set(v, (inDegree.get(v) || 0) + 1);
      }
    }

    const isStandalone = (id) => {
      const outDeg = (adj.get(id) || new Set()).size;
      const inDeg = (revAdj.get(id) || new Set()).size;
      return outDeg === 0 && inDeg === 0;
    };

    const levels = new Map();
    activePlans.forEach(p => {
      if (isStandalone(p.id)) {
        levels.set(p.id, -1);
      } else if ((inDegree.get(p.id) || 0) === 0) {
        levels.set(p.id, 0);
      }
    });

    const queue = [];
    for (const [id, deg] of inDegree.entries()) {
      if (deg === 0 && !isStandalone(id)) {
        queue.push(id);
      }
    }

    while (queue.length > 0) {
      const u = queue.shift();
      const uLevel = levels.get(u) || 0;

      for (const v of dagAdj.get(u) || []) {
        const currVLevel = levels.get(v);
        if (currVLevel === undefined || uLevel + 1 > currVLevel) {
          levels.set(v, uLevel + 1);
        }
        const newDeg = (inDegree.get(v) || 1) - 1;
        inDegree.set(v, newDeg);
        if (newDeg === 0) {
          queue.push(v);
        }
      }
    }

    activePlans.forEach(p => {
      if (!levels.has(p.id)) {
        levels.set(p.id, isStandalone(p.id) ? -1 : 1);
      }
    });

    let maxTier = 0;
    for (const lvl of levels.values()) {
      if (lvl >= 0 && lvl > maxTier) {
        maxTier = lvl;
      }
    }

    // Step 4: Geometry & Coordinate Assignment
    const NODE_WIDTH = 340;
    const NODE_HEIGHT = 180;
    const GAP_X = 140;
    const GAP_Y = 40;
    const PAD_X = 60;
    const PAD_Y = 60;

    const getTierName = (tier) => {
      if (tier === 0) return 'Tier 0: Architectural Blueprints';
      if (tier === 1) return 'Tier 1: Subsystems';
      if (tier === 2) return 'Tier 2: Specialized & Leaf Plans';
      if (tier === -1) return 'Standalone Utility Plans';
      return `Tier ${tier}: Specialized Plans`;
    };

    const plansByTier = new Map();
    activePlans.forEach(p => {
      const t = levels.get(p.id) !== undefined ? levels.get(p.id) : -1;
      if (!plansByTier.has(t)) plansByTier.set(t, []);
      plansByTier.get(t).push(p);
    });

    const nodeCoords = new Map();

    for (let t = 0; t <= maxTier; t++) {
      const colPlans = plansByTier.get(t) || [];
      if (colPlans.length === 0) continue;

      if (t > 0) {
        colPlans.sort((a, b) => {
          const parentsA = Array.from(revAdj.get(a.id) || []);
          const parentsB = Array.from(revAdj.get(b.id) || []);
          const avgYA = parentsA.length > 0
            ? parentsA.reduce((sum, pid) => sum + (nodeCoords.get(pid)?.y || 0), 0) / parentsA.length
            : 0;
          const avgYB = parentsB.length > 0
            ? parentsB.reduce((sum, pid) => sum + (nodeCoords.get(pid)?.y || 0), 0) / parentsB.length
            : 0;
          return avgYA - avgYB;
        });
      }

      const colX = PAD_X + t * (NODE_WIDTH + GAP_X);
      colPlans.forEach((plan, idx) => {
        const rowY = PAD_Y + idx * (NODE_HEIGHT + GAP_Y);
        nodeCoords.set(plan.id, { x: colX, y: rowY, orderInTier: idx });
      });
    }

    const standalonePlans = plansByTier.get(-1) || [];
    const standaloneX = PAD_X + (maxTier + 1) * (NODE_WIDTH + GAP_X);
    const STANDALONE_MAX_ROWS = 6;
    standalonePlans.forEach((plan, idx) => {
      const colOffset = Math.floor(idx / STANDALONE_MAX_ROWS);
      const rowInCol = idx % STANDALONE_MAX_ROWS;
      const x = standaloneX + colOffset * (NODE_WIDTH + 40);
      const y = PAD_Y + rowInCol * (NODE_HEIGHT + GAP_Y);
      nodeCoords.set(plan.id, { x, y, orderInTier: idx });
    });

    const nodes = activePlans.map(p => {
      const t = levels.get(p.id) !== undefined ? levels.get(p.id) : -1;
      const coords = nodeCoords.get(p.id) || { x: 0, y: 0, orderInTier: 0 };
      const upstreamPlanIds = Array.from(revAdj.get(p.id) || []);
      const downstreamPlanIds = Array.from(adj.get(p.id) || []);

      return {
        id: p.id,
        title: p.title,
        version: p.version,
        filePath: p.filePath,
        status: p.status,
        workStatus: p.workStatus,
        requiresWork: p.requiresWork,
        tier: t,
        tierName: getTierName(t),
        orderInTier: coords.orderInTier,
        metrics: p.metrics,
        goal: p.goal,
        architectureSummary: p.architectureSummary,
        verificationCommand: p.verificationCommand,
        linkedTodos: p.linkedTodos || [],
        upstreamPlanIds,
        downstreamPlanIds,
        x: coords.x,
        y: coords.y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT
      };
    });

    // Step 5: SVG Bezier Edge Calculation
    const edges = [];
    const cycleEdges = [];

    for (const [fromId, targetSet] of adj.entries()) {
      const fromCoords = nodeCoords.get(fromId);
      if (!fromCoords) continue;

      for (const toId of targetSet) {
        const toCoords = nodeCoords.get(toId);
        if (!toCoords) continue;

        const isCycle = cycleEdgePairs.has(`${fromId}->${toId}`);
        let d = '';

        if (isCycle) {
          const fromX = fromCoords.x + NODE_WIDTH / 2;
          const fromY = fromCoords.y + NODE_HEIGHT;
          const toX = toCoords.x + NODE_WIDTH / 2;
          const toY = toCoords.y + NODE_HEIGHT;
          d = `M ${fromX} ${fromY} C ${fromX} ${fromY + 90}, ${toX} ${toY + 90}, ${toX} ${toY}`;
        } else {
          const fromX = fromCoords.x + NODE_WIDTH;
          const fromY = fromCoords.y + NODE_HEIGHT / 2;
          const toX = toCoords.x;
          const toY = toCoords.y + NODE_HEIGHT / 2;
          const dx = Math.max(60, (toX - fromX) * 0.45);
          d = `M ${fromX} ${fromY} C ${fromX + dx} ${fromY}, ${toX - dx} ${toY}, ${toX} ${toY}`;
        }

        const edge = {
          id: `edge-${fromId}-${toId}`,
          fromPlanId: fromId,
          toPlanId: toId,
          isCycle,
          d
        };

        edges.push(edge);
        if (isCycle) {
          cycleEdges.push(edge);
        }
      }
    }

    const tiers = [];
    for (let t = 0; t <= maxTier; t++) {
      const colPlans = plansByTier.get(t) || [];
      if (colPlans.length > 0) {
        tiers.push({
          tier: t,
          title: getTierName(t),
          nodeIds: colPlans.map(p => p.id)
        });
      }
    }
    if (standalonePlans.length > 0) {
      tiers.push({
        tier: -1,
        title: getTierName(-1),
        nodeIds: standalonePlans.map(p => p.id)
      });
    }

    return {
      projectId,
      nodes,
      edges,
      tiers,
      cycleDetected: cycleEdges.length > 0,
      cycleEdges
    };
  }
}

// Universal export pattern: Node.js (CommonJS), browser (window), and globalThis
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DeliveryGraphModel };
}
if (typeof window !== 'undefined') {
  window.DeliveryGraphModel = DeliveryGraphModel;
}
if (typeof globalThis !== 'undefined') {
  globalThis.DeliveryGraphModel = DeliveryGraphModel;
}
