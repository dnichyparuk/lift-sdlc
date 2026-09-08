#!/usr/bin/env node
/**
 * guardrails-prepare.js
 * Scans a project codebase and proposes plan guardrails based on detected signals.
 * Guardrails are constraints that plan-sdlc evaluates during its critique phases.
 *
 * Usage:
 *   node guardrails-prepare.js --project-root <path> [--mode init|add] [--target plan|execute] [--json]
 *
 * Options:
 *   --project-root <path>   Project root (default: cwd)
 *   --mode init|add         init = propose all; add = filter out existing (default: init)
 *   --target plan|execute   Target context: plan = plan-phase guardrails; execute = execution-phase guardrails (default: plan)
 *   --json                  Output JSON (always on; flag is for convention consistency)
 *
 * Exit codes: 0 = success, 1 = expected/config error, 2 = unexpected crash
 * Stdout: JSON
 * Stderr: warnings/progress
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const LIB = path.join(__dirname, '..', 'lib');

const { readSection, resolveSdlcRoot } = require(path.join(LIB, 'config'));
const { writeOutput } = require(path.join(LIB, 'output'));
const { resolveDimensionsDir } = require(path.join(LIB, 'dimensions'));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let projectRoot = resolveSdlcRoot(); // issue #351: route to main worktree .sdlc/ (overridable via --project-root)
  let mode = 'init';
  let target = 'plan';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--project-root' && args[i + 1]) {
      projectRoot = path.resolve(args[++i]);
    } else if (a === '--mode' && args[i + 1]) {
      mode = args[++i];
    } else if (a === '--target' && args[i + 1]) {
      target = args[++i];
    }
    // --json is accepted for convention; no action needed
  }

  if (mode !== 'init' && mode !== 'add') {
    process.stderr.write(`guardrails-prepare: invalid --mode "${mode}". Valid: init, add\n`);
    process.exit(1);
  }

  if (target !== 'plan' && target !== 'execute') {
    process.stderr.write(`guardrails-prepare: invalid --target "${target}". Valid: plan, execute\n`);
    process.exit(1);
  }

  return { projectRoot, mode, target };
}

// ---------------------------------------------------------------------------
// Existing guardrails
// ---------------------------------------------------------------------------

function readExisting(projectRoot, target) {
  let section = null;
  try {
    section = readSection(projectRoot, target);
  } catch (err) {
    return { error: `Failed to read ${target} config: ${err.message}`, count: 0, guardrails: [], ids: [] };
  }

  const guardrails = (section && Array.isArray(section.guardrails))
    ? section.guardrails
    : [];

  return {
    error: null,
    count: guardrails.length,
    guardrails,
    ids: guardrails.map(g => g.id).filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Signal detection helpers
// ---------------------------------------------------------------------------

function existsRel(projectRoot, ...parts) {
  return fs.existsSync(path.join(projectRoot, ...parts));
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

function parseJsonSafe(filePath) {
  const raw = readFileSafe(filePath);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Find first existing directory path from a list of candidates (relative to root).
 * Returns the relative path (e.g. "src/repositories/") or null.
 */
function findDir(projectRoot, ...candidates) {
  for (const rel of candidates) {
    if (existsRel(projectRoot, rel)) return rel + '/';
  }
  return null;
}

/**
 * Check whether any file at the top level of dir matches a predicate (non-recursive).
 */
function anyFileMatches(dirPath, predicate) {
  if (!fs.existsSync(dirPath)) return false;
  try {
    return fs.readdirSync(dirPath).some(predicate);
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Language & framework detection
// ---------------------------------------------------------------------------

function detectLanguagesAndFrameworks(projectRoot, signals) {
  // JavaScript / TypeScript
  const pkgPath = path.join(projectRoot, 'package.json');
  const pkg = parseJsonSafe(pkgPath);
  if (pkg) {
    const allDeps = {
      ...((pkg.dependencies) || {}),
      ...((pkg.devDependencies) || {}),
    };
    const hasTsConfig = existsRel(projectRoot, 'tsconfig.json');
    const hasTypeScriptDep = 'typescript' in allDeps;
    signals.languages.push(hasTsConfig || hasTypeScriptDep ? 'typescript' : 'javascript');

    const frameworkMap = {
      express:  'express',
      fastify:  'fastify',
      nestjs:   'nestjs',
      '@nestjs/core': 'nestjs',
      react:    'react',
      next:     'next',
      'next.js': 'next',
      nuxt:     'nuxt',
      vue:      'vue',
      angular:  'angular',
      '@angular/core': 'angular',
      svelte:   'svelte',
      astro:    'astro',
      hapi:     'hapi',
      koa:      'koa',
      // Serverless / IaC
      'serverless':       'serverless-framework',
      'aws-cdk-lib':      'aws-cdk',
      'sst':              'sst',
      // Observability
      'dd-trace':         'datadog',
      'newrelic':         'newrelic',
      'aws-xray-sdk-core':'aws-xray',
      // Validation
      'zod':              'zod',
      'joi':              'joi',
      'yup':              'yup',
      'class-validator':  'class-validator',
      'ajv':              'ajv',
      // Build tools
      'webpack':          'webpack',
      'esbuild':          'esbuild',
      'vite':             'vite',
      'rollup':           'rollup',
    };
    for (const [dep, framework] of Object.entries(frameworkMap)) {
      if (dep in allDeps && !signals.frameworks.includes(framework)) {
        signals.frameworks.push(framework);
      }
    }

    // Scoped package prefix matching
    const prefixMap = {
      '@middy/':          'middy',
      '@sentry/':         'sentry',
      '@pulumi/':         'pulumi',
      '@opentelemetry/':  'opentelemetry',
    };
    for (const dep of Object.keys(allDeps)) {
      for (const [prefix, framework] of Object.entries(prefixMap)) {
        if (dep.startsWith(prefix) && !signals.frameworks.includes(framework)) {
          signals.frameworks.push(framework);
        }
      }
    }
  }

  // Go
  if (existsRel(projectRoot, 'go.mod')) {
    signals.languages.push('go');
    const goMod = readFileSafe(path.join(projectRoot, 'go.mod')) || '';
    for (const fw of ['gin', 'echo', 'fiber']) {
      if (goMod.includes(fw)) signals.frameworks.push(fw);
    }
  }

  // Rust
  if (existsRel(projectRoot, 'Cargo.toml')) {
    signals.languages.push('rust');
  }

  // Python
  if (existsRel(projectRoot, 'pyproject.toml') || existsRel(projectRoot, 'requirements.txt')) {
    signals.languages.push('python');
    const pyFiles = [
      readFileSafe(path.join(projectRoot, 'pyproject.toml')) || '',
      readFileSafe(path.join(projectRoot, 'requirements.txt')) || '',
    ].join('\n');
    for (const fw of ['django', 'flask', 'fastapi']) {
      if (pyFiles.toLowerCase().includes(fw)) signals.frameworks.push(fw);
    }
  }

  // Java
  if (existsRel(projectRoot, 'pom.xml') || existsRel(projectRoot, 'build.gradle')) {
    signals.languages.push('java');
  }
}

// ---------------------------------------------------------------------------
// Structural signal detection
// ---------------------------------------------------------------------------

function detectStructure(projectRoot, signals) {
  const dirs = signals.directories;

  // Key directories — check both root and src/
  const structuralDirs = ['controllers', 'services', 'repositories', 'middleware', 'models', 'migrations'];
  for (const d of structuralDirs) {
    const found = findDir(projectRoot, d, path.join('src', d));
    if (found) dirs[d] = found;
  }

  // ORM / database
  if (existsRel(projectRoot, 'prisma')) {
    signals.hasDatabase = true;
    signals.dbType = 'prisma';
  } else if (existsRel(projectRoot, 'alembic')) {
    signals.hasDatabase = true;
    signals.dbType = 'alembic';
  } else if (
    existsRel(projectRoot, 'knexfile.js') ||
    existsRel(projectRoot, 'knexfile.ts') ||
    existsRel(projectRoot, 'knexfile.cjs')
  ) {
    signals.hasDatabase = true;
    signals.dbType = 'knex';
  } else {
    // Check for typeorm in package.json deps
    const pkgPath = path.join(projectRoot, 'package.json');
    const pkg = parseJsonSafe(pkgPath);
    if (pkg) {
      const allDeps = { ...((pkg.dependencies) || {}), ...((pkg.devDependencies) || {}) };
      if ('typeorm' in allDeps) {
        signals.hasDatabase = true;
        signals.dbType = 'typeorm';
      }
      // NoSQL / driver-based database detection
      if (!signals.hasDatabase) {
        const driverMap = {
          '@aws-sdk/client-dynamodb': 'dynamodb',
          '@aws-sdk/lib-dynamodb':    'dynamodb',
          'serverless-dynamodb':      'dynamodb',
          'mongoose':                 'mongodb',
          'mongodb':                  'mongodb',
          'redis':                    'redis',
          'ioredis':                  'redis',
          '@google-cloud/firestore':  'firestore',
          'firebase-admin':           'firestore',
          'cassandra-driver':         'cassandra',
          'neo4j-driver':             'neo4j',
        };
        for (const [dep, dbType] of Object.entries(driverMap)) {
          if (dep in allDeps) {
            signals.hasDatabase = true;
            signals.dbType = dbType;
            break;
          }
        }
      }
    }
  }
  // Migrations dir also implies database
  if ('migrations' in dirs && !signals.hasDatabase) {
    signals.hasDatabase = true;
    signals.dbType = 'migrations';
  }
  // Serverless resources with DynamoDB table definitions
  if (!signals.hasDatabase) {
    const resourcesPath = path.join(projectRoot, 'serverless', 'resources.yml');
    const resourcesContent = readFileSafe(resourcesPath);
    if (resourcesContent && resourcesContent.includes('AWS::DynamoDB::Table')) {
      signals.hasDatabase = true;
      signals.dbType = 'dynamodb';
    }
  }
  // persistence/ directory as a weaker database hint
  if (!signals.hasDatabase) {
    if (findDir(projectRoot, 'persistence', path.join('src', 'persistence'))) {
      signals.hasDatabase = true;
      signals.dbType = 'unknown';
    }
  }

  // API signals
  if (existsRel(projectRoot, 'openapi.yaml') || existsRel(projectRoot, 'openapi.json')) {
    signals.hasApi = true;
    signals.apiFormat = 'openapi';
  } else if (
    anyFileMatches(projectRoot, f => f.endsWith('.graphql') || f.endsWith('.gql')) ||
    existsRel(projectRoot, 'schema.graphql') ||
    existsRel(projectRoot, 'schema.gql')
  ) {
    signals.hasApi = true;
    signals.apiFormat = 'graphql';
  } else if (existsRel(projectRoot, 'routes') || existsRel(projectRoot, 'src', 'routes')) {
    signals.hasApi = true;
    signals.apiFormat = 'rest';
  }

  // Lambda / Serverless HTTP API detection
  if (!signals.hasApi) {
    const pkgPath = path.join(projectRoot, 'package.json');
    const pkg = parseJsonSafe(pkgPath);
    if (pkg) {
      const allDeps = { ...((pkg.dependencies) || {}), ...((pkg.devDependencies) || {}) };
      // @middy/http-* or http-status-codes → lambda-http
      const hasMiddyHttp = Object.keys(allDeps).some(dep => dep.startsWith('@middy/http-'));
      if (hasMiddyHttp || 'http-status-codes' in allDeps) {
        signals.hasApi = true;
        signals.apiFormat = 'lambda-http';
      }
    }
  }
  if (!signals.hasApi) {
    // Serverless Framework config files
    if (
      existsRel(projectRoot, 'serverless', 'functions.yml') ||
      existsRel(projectRoot, 'serverless.yml') ||
      existsRel(projectRoot, 'serverless.ts')
    ) {
      signals.hasApi = true;
      signals.apiFormat = 'serverless';
    }
  }
  if (!signals.hasApi) {
    // src/function/ or src/functions/ with handler files
    const fnDir = findDir(projectRoot, 'src/function', 'src/functions');
    if (fnDir) {
      const fullFnDir = path.join(projectRoot, fnDir);
      if (anyFileMatches(fullFnDir, f => f.toLowerCase().includes('handler'))) {
        signals.hasApi = true;
        signals.apiFormat = 'lambda-http';
      }
    }
  }

  // Tests
  if (
    existsRel(projectRoot, 'test') ||
    existsRel(projectRoot, 'tests') ||
    existsRel(projectRoot, '__tests__')
  ) {
    signals.hasTests = true;
  }
  // Check test framework in package.json devDeps
  if (!signals.hasTests || !signals.testFramework) {
    const pkg = parseJsonSafe(path.join(projectRoot, 'package.json'));
    if (pkg) {
      const devDeps = (pkg.devDependencies) || {};
      const deps = (pkg.dependencies) || {};
      const all = { ...deps, ...devDeps };
      if ('jest' in all) { signals.hasTests = true; signals.testFramework = 'jest'; }
      else if ('vitest' in all) { signals.hasTests = true; signals.testFramework = 'vitest'; }
      else if ('mocha' in all) { signals.hasTests = true; signals.testFramework = 'mocha'; }
    }
  }
  // Go test files
  if (!signals.hasTests && signals.languages.includes('go')) {
    const hasGoTests = anyFileMatches(projectRoot, f => f.endsWith('_test.go'));
    if (hasGoTests) { signals.hasTests = true; signals.testFramework = 'go-test'; }
  }

  // CI
  const ghWorkflowsDir = path.join(projectRoot, '.github', 'workflows');
  if (
    fs.existsSync(ghWorkflowsDir) &&
    anyFileMatches(ghWorkflowsDir, f => f.endsWith('.yml') || f.endsWith('.yaml'))
  ) {
    signals.hasCi = true;
    signals.ciPlatform = 'github-actions';
  } else if (existsRel(projectRoot, 'Jenkinsfile')) {
    signals.hasCi = true;
    signals.ciPlatform = 'jenkins';
  } else if (existsRel(projectRoot, '.gitlab-ci.yml')) {
    signals.hasCi = true;
    signals.ciPlatform = 'gitlab';
  }

  // Monorepo
  if (
    existsRel(projectRoot, 'lerna.json') ||
    existsRel(projectRoot, 'pnpm-workspace.yaml') ||
    existsRel(projectRoot, 'nx.json')
  ) {
    signals.hasMonorepo = true;
  }

  // OpenSpec
  if (existsRel(projectRoot, 'openspec', 'config.yaml')) {
    signals.hasOpenSpec = true;
  }
}

// ---------------------------------------------------------------------------
// Review dimensions
// ---------------------------------------------------------------------------

function detectReviewDimensions(projectRoot, signals) {
  // Route through resolveDimensionsDir() so .sdlc/-first lookup works.
  // Fixes #259 — direct .sdlc/ read missed every project that had migrated.
  const dimDir = resolveDimensionsDir(projectRoot);
  if (!fs.existsSync(dimDir)) return;
  try {
    const files = fs.readdirSync(dimDir);
    for (const f of files) {
      if (f.endsWith('.md')) {
        signals.reviewDimensions.push(f.replace(/\.md$/, ''));
      }
    }
  } catch (_) {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// AGENTS.md / AGENTS.md rule extraction
// ---------------------------------------------------------------------------

const CONSTRAINT_REGEX = /\b(must|never|always|require[sd]?|forbidden|prohibited)\b/i;

function extractagentsMdRules(projectRoot, signals) {
  const candidates = ['AGENTS.md', 'AGENTS.md'];
  const seen = new Set();
  const rules = [];

  for (const filename of candidates) {
    const filePath = path.join(projectRoot, filename);
    const content = readFileSafe(filePath);
    if (!content) continue;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (CONSTRAINT_REGEX.test(trimmed) && !seen.has(trimmed)) {
        seen.add(trimmed);
        rules.push(trimmed);
        if (rules.length >= 20) break;
      }
    }
    if (rules.length >= 20) break;
  }

  signals.agentsMdRules = rules;
}

// ---------------------------------------------------------------------------
// Proposal catalog
// ---------------------------------------------------------------------------

/**
 * Build proposals from detected signals.
 * @param {object} signals
 * @param {string} target  'plan' or 'execute'
 * @returns {Array<{id, description, severity, category, evidence}>}
 */
function buildProposals(signals, target) {
  const isPlan = (target || 'plan') === 'plan';
  const proposals = [];
  const dirs = signals.directories;

  const repoPath = dirs.repositories;
  const repoLabel = repoPath
    ? `the repository layer (${repoPath})`
    : 'the repository layer';

  if (signals.hasDatabase && repoPath) {
    proposals.push({
      id: 'no-direct-db-access',
      description: isPlan
        ? `Plans must route all database operations through ${repoLabel}. No direct SQL or ORM calls in controllers/handlers.`
        : `Code changes must not introduce direct database queries outside ${repoLabel}.`,
      severity: 'error',
      category: 'architecture',
      evidence: `Detected ${signals.dbType || 'database'} with repositories/ directory at "${repoPath}".`,
    });
  }

  if (signals.hasApi) {
    proposals.push({
      id: 'api-backward-compatibility',
      description: isPlan
        ? 'Plans must version or deprecate changed APIs. Breaking changes must be documented in Key Decisions.'
        : 'API changes must maintain backward compatibility — no breaking changes to existing endpoints or contracts without versioning.',
      severity: 'error',
      category: 'architecture',
      evidence: `Detected API (format: ${signals.apiFormat || 'unknown'}).`,
    });
  }

  if (signals.hasTests) {
    proposals.push({
      id: 'test-coverage-required',
      description: isPlan
        ? 'Every task that creates or modifies source code must include corresponding test cases.'
        : 'Code changes must include corresponding test coverage — verify tests exist and pass after each wave.',
      severity: 'error',
      category: 'testing',
      evidence: `Detected test infrastructure${signals.testFramework ? ` (${signals.testFramework})` : ''}.`,
    });
  }

  if (signals.hasDatabase) {
    proposals.push({
      id: 'database-migration-review',
      description: isPlan
        ? 'Tasks modifying database schema must be flagged as High risk.'
        : 'Database migration files must be reviewed — schema changes are flagged for manual verification.',
      severity: 'warning',
      category: 'architecture',
      evidence: `Detected ${signals.dbType || 'database'} integration.`,
    });
  }

  if (signals.hasCi) {
    proposals.push({
      id: 'no-ci-bypass',
      description: isPlan
        ? 'Plans must not include steps that skip or disable CI checks.'
        : 'Implemented code must not disable, skip, or weaken CI checks, linters, or pre-commit hooks.',
      severity: 'error',
      category: 'security',
      evidence: `Detected CI platform: ${signals.ciPlatform}.`,
    });
  }

  if (signals.hasMonorepo) {
    proposals.push({
      id: 'monorepo-boundary-respect',
      description: isPlan
        ? 'Tasks must not create cross-package dependencies without explicit justification.'
        : 'Code changes must respect monorepo package boundaries — no cross-package imports outside declared dependencies.',
      severity: 'warning',
      category: 'architecture',
      evidence: 'Detected monorepo configuration (lerna.json / pnpm-workspace.yaml / nx.json).',
    });
  }

  if (signals.hasOpenSpec) {
    proposals.push({
      id: 'spec-compliance',
      description: isPlan
        ? 'Changes must reference an OpenSpec change for traceability.'
        : 'Implementation must comply with OpenSpec delta spec requirements when available.',
      severity: 'warning',
      category: 'architecture',
      evidence: 'Detected openspec/config.yaml.',
    });
  }

  // Always-on guardrails
  proposals.push({
    id: 'no-scope-creep',
    description: isPlan
      ? 'Tasks must only address stated requirements; no gold-plating.'
      : 'Implementation must stay within the task\'s stated scope — no additional features, refactoring, or cleanup beyond what was specified.',
    severity: 'warning',
    category: 'scope',
    evidence: 'Universal guardrail — always applicable.',
  });

  proposals.push({
    id: 'single-responsibility-tasks',
    description: isPlan
      ? 'Each task must have exactly one clear deliverable.'
      : 'Each implemented change must address exactly one concern — no bundled fixes or unrelated modifications.',
    severity: 'warning',
    category: 'scope',
    evidence: 'Universal guardrail — always applicable.',
  });

  // Engineering principles — universally applicable
  proposals.push({
    id: 'yagni',
    description: isPlan
      ? 'Tasks must not add functionality beyond stated requirements — no speculative abstractions, premature generalization, or unused parameters.'
      : 'Do not add functionality until it is actually needed. No speculative abstractions, premature generalization, or unused parameters.',
    severity: 'warning',
    category: 'scope',
    evidence: 'Universal guardrail — always applicable.',
  });

  proposals.push({
    id: 'dry',
    description: isPlan
      ? 'Tasks must not duplicate logic that exists elsewhere — reuse existing functions or extract shared utilities.'
      : 'Do not duplicate logic. If the same behavior exists elsewhere, reuse it or extract a shared function.',
    severity: 'warning',
    category: 'quality',
    evidence: 'Universal guardrail — always applicable.',
  });

  proposals.push({
    id: 'kiss',
    description: isPlan
      ? 'Tasks must prefer the simplest design that satisfies requirements — avoid unnecessary abstractions and over-engineering.'
      : 'Prefer the simplest implementation that satisfies the requirements. Avoid unnecessary abstractions and over-engineered solutions.',
    severity: 'warning',
    category: 'quality',
    evidence: 'Universal guardrail — always applicable.',
  });

  // Framework-specific guardrails (issue #336)
  // Spec allows shared id with framework-specific description. Svelte and Astro
  // both use the islands pattern but with different runtime semantics, so each
  // framework gets its own description while sharing the proposal id.
  if (signals.frameworks.includes('svelte')) {
    proposals.push({
      id: 'island-only-interactivity',
      description: isPlan
        ? 'Tasks must use Svelte components as interactive islands only — default to static markup and reach for `<script>` blocks only where interactivity is required.'
        : 'Use Svelte components as interactive islands only; default to static markup. Add `<script>` interactivity only where it is required, not by default.',
      severity: 'warning',
      category: 'framework',
      evidence: 'Detected framework(s): svelte.',
    });
  }
  if (signals.frameworks.includes('astro')) {
    proposals.push({
      id: 'island-only-interactivity',
      description: isPlan
        ? 'Tasks must keep Astro components static by default — opt into client hydration (`client:load`, `client:idle`, `client:visible`) only for components that require interactivity.'
        : 'Astro components must be static by default. Use `client:*` directives only for components that genuinely require client-side interactivity; avoid unnecessary hydration.',
      severity: 'warning',
      category: 'framework',
      evidence: 'Detected framework(s): astro.',
    });
  }

  if (signals.dbType === 'prisma') {
    proposals.push({
      id: 'prisma-migration-required',
      description: isPlan
        ? 'Tasks that modify the Prisma schema must include a corresponding `prisma migrate` step. Schema changes without migrations are a blocking issue.'
        : 'Prisma schema changes must be accompanied by a migration file (`prisma migrate dev` or `prisma migrate deploy`). Do not modify schema.prisma without generating a migration.',
      severity: 'error',
      category: 'framework',
      evidence: 'Detected Prisma ORM (prisma/ directory present).',
    });
  }

  // Planning-discipline guardrails — plan target only
  if (isPlan) {
    proposals.push({
      id: 'state-premise',
      description: 'Plan must state the underlying problem in one sentence — in Goal, Architecture, or Key Decisions. Reject plans that transcribe requirements without naming the root problem.',
      severity: 'error',
      category: 'planning-discipline',
      evidence: 'Universal guardrail — always applicable to non-trivial plans.',
    });

    proposals.push({
      id: 'smallest-viable-cut',
      description: 'Plan must identify the smallest version of the work that still delivers value. If the plan covers more than the minimum, each extra task must be justified in Key Decisions.',
      severity: 'warning',
      category: 'planning-discipline',
      evidence: 'Universal guardrail — always applicable to non-trivial plans.',
    });

    proposals.push({
      id: 'failure-audience',
      description: 'Plan must name who or what fails if this implementation ships incorrectly (user, system, team, downstream service). Surfaces the blast radius before decomposition.',
      severity: 'warning',
      category: 'planning-discipline',
      evidence: 'Universal guardrail — always applicable to non-trivial plans.',
    });

    proposals.push({
      id: 'explicit-non-goals',
      description: 'Plan must list what is intentionally NOT being built. Surface adjacent improvements that were considered and excluded so reviewers and executors do not silently re-expand scope.',
      severity: 'warning',
      category: 'planning-discipline',
      evidence: 'Universal guardrail — always applicable to non-trivial plans.',
    });

    proposals.push({
      id: 'ambiguity-stops-and-asks',
      description: 'When two or more codebase patterns are viable for the same requirement with materially different downstream implications, the plan must EITHER record the choice in Key Decisions with rationale, OR the skill must AskUserQuestion before committing. Silent selection between viable patterns is a critique failure.',
      severity: 'error',
      category: 'planning-discipline',
      evidence: 'Universal guardrail — always applicable to non-trivial plans.',
    });
  }

  // Internal invariant: every proposal must carry a non-empty category field.
  // Throw early with the offending id list to surface missing categories at
  // dev time rather than silently emitting malformed output. Placed after ALL
  // proposal pushes (including isPlan-gated ones) so future proposals cannot
  // bypass the check.
  const missingCategory = proposals.filter(p => !p.category);
  if (missingCategory.length > 0) {
    throw new Error(
      `buildProposals: proposals missing category field: ${missingCategory.map(p => p.id).join(', ')}`
    );
  }

  return proposals;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { projectRoot, mode, target } = parseArgs(process.argv);

  const errors = [];
  const warnings = [];

  // 1. Read existing guardrails
  const existingResult = readExisting(projectRoot, target);
  if (existingResult.error) {
    errors.push(existingResult.error);
  }
  const existing = {
    count: existingResult.count,
    guardrails: existingResult.guardrails,
    ids: existingResult.ids,
  };

  // 2. Detect signals
  const signals = {
    languages: [],
    frameworks: [],
    hasDatabase: false,
    dbType: null,
    hasApi: false,
    apiFormat: null,
    hasTests: false,
    testFramework: null,
    hasCi: false,
    ciPlatform: null,
    hasMonorepo: false,
    hasOpenSpec: false,
    directories: {},
    reviewDimensions: [],
    agentsMdRules: [],
  };

  detectLanguagesAndFrameworks(projectRoot, signals);
  detectStructure(projectRoot, signals);
  detectReviewDimensions(projectRoot, signals);
  extractagentsMdRules(projectRoot, signals);

  // 3. Build proposals
  let proposals = buildProposals(signals, target);

  // 4. In add mode, filter out already-existing ids
  if (mode === 'add' && existing.ids.length > 0) {
    const existingSet = new Set(existing.ids);
    proposals = proposals.filter(p => !existingSet.has(p.id));
  }

  const output = {
    errors,
    warnings,
    existing,
    signals,
    proposals,
  };

  writeOutput(output, 'guardrails-prepare', errors.length > 0 ? 1 : 0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`guardrails-prepare.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { buildProposals, detectLanguagesAndFrameworks, detectStructure, readExisting };
