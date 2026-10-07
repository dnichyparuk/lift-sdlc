'use strict';

/**
 * catalog.js
 * Universal Plan Catalog and Delivery Dashboard CLI.
 * Scans projects, parses markdown plans and TODOs, reconciles execution logs,
 * outputs canonical delivery-graph.json and an autonomous HTML dashboard.
 */

const fs = require('node:fs');
const path = require('node:path');

const { parsePlanMarkdown, parseTodoMarkdown, slugify } = require('../lib/plan-indexer/markdown-parser.js');
const { reconcileProject } = require('../lib/plan-indexer/reconciler.js');
const { buildDashboardHtml } = require('./catalog-build-html.js');

/**
 * Recursively find all markdown files in a directory.
 * @param {string} dir
 * @returns {Array<string>} Absolute file paths
 */
function findMarkdownFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];

  function walk(current) {
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          if (!entry.name.startsWith('_TEMPLATE')) {
            results.push(fullPath);
          }
        }
      }
    } catch {
      // Permission or read error
    }
  }

  walk(dir);
  return results;
}

/**
 * Determine human-readable project name and ID.
 * @param {string} projectDir
 * @returns {{ id: string, name: string }}
 */
function resolveProjectIdentity(projectDir) {
  const baseName = path.basename(projectDir);
  const id = slugify(baseName);
  let name = baseName
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

  // Check package.json for human-readable name
  const pkgPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.name) {
        name = pkg.name;
      }
    } catch {
      // ignore
    }
  }

  return { id, name };
}

/**
 * Scan a single project directory and build its Project delivery model.
 * @param {string} projectDir
 * @returns {object} Canonical Project object
 */
function scanProject(projectDir) {
  const absPath = path.resolve(projectDir);
  const { id, name } = resolveProjectIdentity(absPath);

  const plans = [];
  const todos = [];

  // 1. Discover and parse plans
  const plansDirs = [
    path.join(absPath, 'docs', 'plans'),
    path.join(absPath, 'docs', 'archived', 'plans')
  ];

  const planFiles = [];
  for (const pDir of plansDirs) {
    planFiles.push(...findMarkdownFiles(pDir));
  }

  for (const file of planFiles) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const relPath = path.relative(absPath, file).replace(/\\/g, '/');
      const plan = parsePlanMarkdown(content, {
        filePath: relPath,
        projectId: id
      });
      plans.push(plan);
    } catch (err) {
      // Skip unparseable plan file
    }
  }

  // 2. Discover and parse TODOs
  const todoDir = path.join(absPath, 'docs', 'TODO');
  const todoFiles = findMarkdownFiles(todoDir);

  for (const file of todoFiles) {
    try {
      const content = fs.readFileSync(file, 'utf8');
      const relPath = path.relative(absPath, file).replace(/\\/g, '/');
      const todo = parseTodoMarkdown(content, { filePath: relPath });
      todos.push(todo);
    } catch (err) {
      // Skip unparseable todo file
    }
  }

  const project = {
    id,
    name,
    repoPath: absPath,
    plans,
    todos
  };

  // 3. Reconcile with .sdlc/execution and cross-link TODOs
  return reconcileProject(project);
}

/**
 * Discover project directories in a workspace directory.
 * @param {string} workspaceDir
 * @returns {Array<string>} Project directory paths
 */
function discoverProjectsInWorkspace(workspaceDir) {
  const absDir = path.resolve(workspaceDir);
  if (!fs.existsSync(absDir)) return [];

  const candidates = [];
  const ignored = new Set(['node_modules', '.git', '.cache', 'dist', 'build', 'target', 'tmp', '.venv']);

  try {
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || ignored.has(entry.name)) {
        continue;
      }
      const subPath = path.join(absDir, entry.name);
      const hasPlans = fs.existsSync(path.join(subPath, 'docs', 'plans'));
      const hasSdlc = fs.existsSync(path.join(subPath, '.sdlc'));
      if (hasPlans || hasSdlc) {
        candidates.push(subPath);
      }
    }
  } catch {
    // ignore
  }

  // If workspace itself is a project and no subprojects found
  if (candidates.length === 0) {
    if (fs.existsSync(path.join(absDir, 'docs', 'plans')) || fs.existsSync(path.join(absDir, '.sdlc'))) {
      candidates.push(absDir);
    }
  }

  return candidates;
}

/**
 * Main generator function.
 *
 * @param {object} options
 * @param {string} [options.workspaceDir]
 * @param {string} [options.projectDir]
 * @param {string} [options.jsonPath]
 * @param {string} [options.htmlPath]
 * @returns {object} Result summary and graphData
 */
function generateCatalog(options = {}) {
  const {
    workspaceDir,
    projectDir,
    jsonPath,
    htmlPath
  } = options;

  let projectPaths = [];
  if (workspaceDir) {
    projectPaths = discoverProjectsInWorkspace(workspaceDir);
  } else if (projectDir) {
    projectPaths = [path.resolve(projectDir)];
  } else {
    projectPaths = [process.cwd()];
  }

  const projects = [];
  for (const pPath of projectPaths) {
    const proj = scanProject(pPath);
    projects.push(proj);
  }

  const graphData = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    projects
  };

  // Write JSON output if requested
  if (jsonPath) {
    const absJson = path.resolve(jsonPath);
    const parentDir = path.dirname(absJson);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(absJson, JSON.stringify(graphData, null, 2), 'utf8');
  }

  // Write HTML output if requested
  if (htmlPath) {
    const absHtml = path.resolve(htmlPath);
    buildDashboardHtml({
      graphData,
      outputPath: absHtml
    });
  }

  // Compute stats
  let totalPlans = 0;
  let totalTasks = 0;
  let doneTasks = 0;
  let inProgressTasks = 0;
  let blockedTasks = 0;
  let todoTasks = 0;

  for (const proj of projects) {
    totalPlans += proj.plans.length;
    for (const plan of proj.plans) {
      for (const t of plan.tasks) {
        totalTasks++;
        if (t.status === 'done') doneTasks++;
        else if (t.status === 'in_progress') inProgressTasks++;
        else if (t.status === 'blocked') blockedTasks++;
        else todoTasks++;
      }
    }
  }

  const stats = {
    projectsCount: projects.length,
    plansCount: totalPlans,
    tasksCount: {
      total: totalTasks,
      done: doneTasks,
      inProgress: inProgressTasks,
      blocked: blockedTasks,
      todo: todoTasks
    },
    jsonPath: jsonPath ? path.resolve(jsonPath) : null,
    htmlPath: htmlPath ? path.resolve(htmlPath) : null
  };

  return { graphData, stats };
}

// CLI Execution
if (require.main === module) {
  const args = process.argv.slice(2);
  let workspaceDir = null;
  let projectDir = null;
  let jsonPath = '.sdlc/catalog/delivery-graph.json';
  let htmlPath = 'docs/visualizations/delivery_dashboard.html';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) {
      workspaceDir = args[++i];
    } else if (args[i] === '--project' && args[i + 1]) {
      projectDir = args[++i];
    } else if (args[i] === '--json' && args[i + 1]) {
      jsonPath = args[++i];
    } else if (args[i] === '--html' && args[i + 1]) {
      htmlPath = args[++i];
    }
  }

  try {
    const { stats } = generateCatalog({
      workspaceDir,
      projectDir,
      jsonPath,
      htmlPath
    });

    console.log('=== Universal Delivery Catalog Generated ===');
    console.log(`Projects Indexed : ${stats.projectsCount}`);
    console.log(`Plans Indexed    : ${stats.plansCount}`);
    console.log(`Tasks Breakdown  : ${stats.tasksCount.total} total`);
    console.log(`  - Done         : ${stats.tasksCount.done}`);
    console.log(`  - In Progress  : ${stats.tasksCount.inProgress}`);
    console.log(`  - Blocked      : ${stats.tasksCount.blocked}`);
    console.log(`  - Backlog/Todo : ${stats.tasksCount.todo}`);
    if (stats.jsonPath) console.log(`JSON Output      : ${stats.jsonPath}`);
    if (stats.htmlPath) console.log(`HTML Dashboard   : ${stats.htmlPath}`);
    console.log('============================================');
  } catch (err) {
    console.error(`Catalog generation failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  generateCatalog,
  scanProject,
  discoverProjectsInWorkspace
};
