#!/usr/bin/env node
/**
 * jira-prepare.js
 * Cache and template management for the jira-sdlc skill.
 * Stores per-project Jira metadata (cloudId, issue types, field schemas,
 * workflow graphs, user mappings) to eliminate repeated discovery calls.
 *
 * Usage:
 *   node jira-prepare.js --project <KEY> [--cache-dir <path>] [--site <host>]
 *                        [--skip-workflow-discovery] [subcommand]
 *
 * Subcommands:
 *   --check          Report cache + template status (default)
 *   --load           Output full cache JSON
 *   --save           Read JSON from stdin, write as cache
 *   --save-field <n> Read JSON from stdin, merge into cache[n]
 *   --templates      Resolve templates per issue type
 *   --init-templates Copy defaults to .sdlc/jira-templates/
 *   --clear          Delete cache file
 *
 * Exit codes: 0 = success, 1 = user error, 2 = crash
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const LIB = path.join(__dirname, '..', 'lib');

const { writeOutput } = require(path.join(LIB, 'output'));
const { validateLinks, formatViolations } = require(path.join(LIB, 'links'));
const { parseRemoteOwner } = require(path.join(LIB, 'git'));
const { resolveSkipConfigCheck, ensureConfigVersion } = require(path.join(LIB, 'config-version-prepare'));
const { resolveSdlcRoot } = require(path.join(LIB, 'config'));

// ---------------------------------------------------------------------------
// Home-cache path helpers
// ---------------------------------------------------------------------------

function getHomeCacheRoot() {
  return path.join(os.homedir(), '.sdlc-cache', 'jira');
}

function sanitizeSiteHost(siteUrl) {
  if (!siteUrl || typeof siteUrl !== 'string') return null;
  let host;
  try {
    host = new URL(siteUrl).host;
  } catch (_) {
    // Accept bare hosts passed without scheme
    host = siteUrl.replace(/^https?:\/\//i, '').split('/')[0];
  }
  if (!host) return null;
  return host.toLowerCase().replace(/\./g, '_');
}

/**
 * Resolve candidate cache paths for a project key.
 * - If `explicitSite` is provided, returns a single path under that site subdir
 *   (whether or not the file exists — caller decides).
 * - Otherwise scans `~/.sdlc-cache/jira/<site>/<KEY>.json` for every site and
 *   returns only existing matches.
 *
 * Returns an array of { path, site } entries.
 */
function resolveCandidatePaths(projectKey, explicitSite) {
  const root = getHomeCacheRoot();
  if (explicitSite) {
    return [{ path: path.join(root, explicitSite, `${projectKey}.json`), site: explicitSite }];
  }
  let sites;
  try {
    sites = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const matches = [];
  for (const entry of sites) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, `${projectKey}.json`);
    if (fs.existsSync(candidate)) {
      matches.push({ path: candidate, site: entry.name });
    }
  }
  return matches;
}

/**
 * Load the `jira` section of project config from `.sdlc/config.json`.
 * Returns `{}` on any failure.
 */
function loadJiraConfig(projectRoot) {
  try {
    const { readSection } = require(path.join(LIB, 'config.js'));
    const section = readSection(projectRoot, 'jira');
    if (section && typeof section === 'object') return section;
  } catch (_) { /* ignore */ }
  return {};
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let projectKey             = null;
  let cacheDir               = null;   // only set when --cache-dir is passed
  let templatesDir           = null;
  let subcommand             = 'check';
  let saveFieldName          = null;
  let copyType               = null;
  let copyFrom               = null;
  let site                   = null;
  let skipWorkflowDiscovery  = false;
  let bodyFile               = null;   // for --validate-body
  let wantJson               = false;  // for --validate-body output format
  const errors               = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--project' && args[i + 1]) {
      projectKey = args[++i].toUpperCase();
    } else if (a === '--cache-dir' && args[i + 1]) {
      cacheDir = args[++i];
    } else if (a === '--templates-dir' && args[i + 1]) {
      templatesDir = args[++i];
    } else if (a === '--site' && args[i + 1]) {
      site = args[++i];
    } else if (a === '--skip-workflow-discovery') {
      skipWorkflowDiscovery = true;
    } else if (a === '--check') {
      subcommand = 'check';
    } else if (a === '--load') {
      subcommand = 'load';
    } else if (a === '--save') {
      subcommand = 'save';
    } else if (a === '--save-field' && args[i + 1]) {
      subcommand    = 'save-field';
      saveFieldName = args[++i];
    } else if (a === '--templates') {
      subcommand = 'templates';
    } else if (a === '--init-templates') {
      subcommand = 'init-templates';
    } else if (a === '--clear') {
      subcommand = 'clear';
    } else if (a === '--copy-template') {
      subcommand = 'copy-template';
    } else if (a === '--type' && args[i + 1]) {
      copyType = args[++i];
    } else if (a === '--from' && args[i + 1]) {
      copyFrom = args[++i];
    } else if (a === '--validate-body') {
      subcommand = 'validate-body';
    } else if (a === '--file' && args[i + 1]) {
      // Body source for --validate-body (alternative to stdin)
      bodyFile = args[++i];
    } else if (a === '--json') {
      wantJson = true;
    }
  }

  if (!projectKey && subcommand !== 'validate-body') {
    errors.push('--project <KEY> is required');
  }

  const flags = {
    skipWorkflowDiscovery,
    site,
  };

  return {
    projectKey,
    cacheDir,
    templatesDir,
    subcommand,
    saveFieldName,
    copyType,
    copyFrom,
    site,
    skipWorkflowDiscovery,
    bodyFile,
    wantJson,
    flags,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Cache path resolution
// ---------------------------------------------------------------------------

/**
 * Legacy signature preserved for back-compat with callers that pass an
 * explicit --cache-dir (typically tests or custom deployments). When invoked
 * with a cache dir outside the working tree, the implicit .gitignore write is
 * suppressed to avoid polluting user home / arbitrary paths.
 */
function getCachePath(projectKey, cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const rel = path.relative(process.cwd(), cacheDir);
  const insideWorkTree = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (insideWorkTree) {
    const gitignorePath = path.join(cacheDir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, '*\n', 'utf8');
    }
  }
  return path.join(cacheDir, `${projectKey}.json`);
}

function findPluginInstalls() {
  const pluginsRoot = path.join(os.homedir(), '.gemini', 'config', 'plugins');
  const results     = [];

  function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === 'templates' && dir.endsWith('jira-sdlc')) {
        results.push(full);
      } else {
        walk(full, depth + 1);
      }
    }
  }

  walk(pluginsRoot, 0);
  return results;
}

function resolveTemplatesDir(overridePath) {
  if (overridePath) return overridePath;

  const installs = findPluginInstalls();
  if (installs.length > 0) return installs[0];

  return path.join(process.cwd(), 'plugins', 'lift-sdlc', 'skills', 'jira-sdlc', 'templates');
}

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

function readStdin() {
  try {
    return fs.readFileSync('/dev/stdin', 'utf8');
  } catch (err) {
    writeOutput({ errors: [`Failed to read stdin: ${err.message}`] }, 'jira-context', 1);
  }
}

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------

// Spec R18: when an issue type lacks both a custom and a shipped template,
// fall back to a parent template before resolving to 'none'. Keys are
// case-sensitive and match Atlassian issue-type names verbatim.
const TEMPLATE_FALLBACK_MAP = {
  'Sub-bug': 'Bug',
  'Sub-task': 'Task',
  'Subtask': 'Task',
};

function resolveTemplateStatus(projectKey, cachePath, templatesDir) {
  let issueTypes = [];
  if (cachePath && fs.existsSync(cachePath)) {
    try {
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cache.issueTypes && typeof cache.issueTypes === 'object') {
        issueTypes = Object.keys(cache.issueTypes);
      }
    } catch (_) { /* ignore parse errors */ }
  }

  // R-projectroot: main-worktree-rooted resolution (#360).
  const customDir = path.join(resolveSdlcRoot(), '.sdlc', 'jira-templates');

  // Collect all available default template names (without .md)
  let defaultTemplateNames = [];
  try {
    defaultTemplateNames = fs.readdirSync(templatesDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.slice(0, -3));
  } catch (_) { /* templates dir may not exist */ }

  const customTemplates  = {};
  const resolved         = {};
  const fallbacks        = []; // [{type, fallbackTo}] — spec R18
  const noneTypes        = []; // types still resolved as 'none' after fallback lookup

  for (const issueType of issueTypes) {
    const customPath = path.join(customDir, `${issueType}.md`);
    const customExists = fs.existsSync(customPath);
    customTemplates[issueType] = { path: customPath, exists: customExists };

    if (customExists) {
      resolved[issueType] = 'custom';
    } else if (defaultTemplateNames.includes(issueType)) {
      resolved[issueType] = 'default';
    } else {
      const parent = TEMPLATE_FALLBACK_MAP[issueType];
      if (parent && defaultTemplateNames.includes(parent)) {
        resolved[issueType] = 'default-fallback';
        fallbacks.push({ type: issueType, fallbackTo: parent });
      } else {
        resolved[issueType] = 'none';
        noneTypes.push(issueType);
      }
    }
  }

  return {
    issueTypes,
    customTemplates,
    defaultTemplates: defaultTemplateNames,
    resolved,
    fallbacks,
    noneTypes,
  };
}

// ---------------------------------------------------------------------------
// Shared: resolve effective cache path for check/load/clear
// Returns { path, warnings, candidateSites, error }.
// - `path` is null when no cache exists and no legacy was migrated.
// - `candidateSites` is populated when multiple home-cache entries matched.
// - `error` (string) is set when a hard failure prevents resolution.
// ---------------------------------------------------------------------------

function resolveEffectiveCachePath({ projectKey, cacheDir, site }) {
  const warnings = [];

  // Explicit --cache-dir takes precedence (back-compat).
  if (cacheDir) {
    return { path: getCachePath(projectKey, cacheDir), warnings, candidateSites: [] };
  }

  // Home-cache scan
  const matches = resolveCandidatePaths(projectKey, site);
  if (site) {
    // --site always resolves to a single candidate path. When the home-cache
    // root itself does not exist yet, return path: null so callers emit a clear
    // "No cache found" rather than propagating a path that cannot exist.
    const root = getHomeCacheRoot();
    if (!fs.existsSync(root)) {
      warnings.push(`Home cache root ${root} does not exist. Run cache initialization first (omit --site or use --force-refresh).`);
      return { path: null, warnings, candidateSites: [] };
    }
    return { path: matches[0].path, warnings, candidateSites: [] };
  }

  if (matches.length === 1) {
    return { path: matches[0].path, warnings, candidateSites: [] };
  }

  if (matches.length >= 2) {
    const sites = matches.map(m => m.site);
    warnings.push(`Cache key '${projectKey}' exists under multiple sites: ${sites.join(', ')}. Pass --site <host> to disambiguate.`);
    return { path: null, warnings, candidateSites: sites };
  }

  return { path: null, warnings, candidateSites: [] };
}

/**
 * Validate `--project <KEY>` against `jira.projects` (when set).
 * Returns an error string or null.
 */
function validateProjectMembership(projectKey, jiraConfig) {
  const list = Array.isArray(jiraConfig && jiraConfig.projects) ? jiraConfig.projects : null;
  if (!list || list.length < 2) return null;
  if (list.includes(projectKey)) return null;
  return `Project ${projectKey} is not in jira.projects: [${list.join(', ')}]`;
}

// ---------------------------------------------------------------------------
// Subcommand: --check
// ---------------------------------------------------------------------------

function checkCache({ projectKey, cacheDir, site, skipWorkflowDiscovery, templatesDir }) {
  // R-projectroot: main-worktree-rooted resolution (#360).
  const jiraConfig = loadJiraConfig(resolveSdlcRoot());
  const membershipError = validateProjectMembership(projectKey, jiraConfig);
  if (membershipError) {
    writeOutput({ errors: [membershipError] }, 'jira-context', 1);
    return;
  }

  const resolved = resolveEffectiveCachePath({ projectKey, cacheDir, site });
  for (const w of resolved.warnings) process.stderr.write(`Warning: ${w}\n`);

  const flagsBlock = {
    skipWorkflowDiscovery: !!skipWorkflowDiscovery,
    site:                  site || null,
  };

  if (!resolved.path) {
    writeOutput({
      exists:         false,
      fresh:          false,
      projectKey,
      cachePath:      null,
      candidateSites: resolved.candidateSites,
      missing:        ['all'],
      flags:          flagsBlock,
      errors:         [],
      warnings:       resolved.warnings,
    }, 'jira-context', 0);
    return;
  }

  if (!fs.existsSync(resolved.path)) {
    writeOutput({
      exists:         false,
      fresh:          false,
      projectKey,
      cachePath:      resolved.path,
      candidateSites: [],
      missing:        ['all'],
      flags:          flagsBlock,
      errors:         [],
      warnings:       resolved.warnings,
    }, 'jira-context', 0);
    return;
  }

  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(resolved.path, 'utf8'));
  } catch (err) {
    writeOutput({
      exists:     true,
      fresh:      false,
      projectKey,
      cachePath:  resolved.path,
      missing:    ['all'],
      flags:      flagsBlock,
      errors:     [`Cache file is not valid JSON: ${err.message}`],
      warnings:   resolved.warnings,
    }, 'jira-context', 0);
    return;
  }

  const maxAgeHours = typeof cache.maxAgeHours === 'number' ? cache.maxAgeHours : 0;
  let ageHours      = null;
  let fresh         = false;

  if (cache.lastUpdated) {
    const updatedMs = new Date(cache.lastUpdated).getTime();
    if (!isNaN(updatedMs)) {
      ageHours = (Date.now() - updatedMs) / (1000 * 60 * 60);
      fresh    = maxAgeHours === 0 ? true : ageHours < maxAgeHours;
    }
  }

  const issueTypes     = cache.issueTypes && typeof cache.issueTypes === 'object' ? cache.issueTypes : null;
  const fieldSchemas   = cache.fieldSchemas && typeof cache.fieldSchemas === 'object' ? cache.fieldSchemas : null;
  const workflows      = cache.workflows && typeof cache.workflows === 'object' ? cache.workflows : null;
  const linkTypes      = Array.isArray(cache.linkTypes) ? cache.linkTypes : null;
  const userMappings   = cache.userMappings && typeof cache.userMappings === 'object' ? cache.userMappings : null;

  const issueTypeNames = issueTypes ? Object.keys(issueTypes) : [];

  let issueTypesWithWorkflows = 0;
  const incompleteWorkflows   = [];
  if (workflows) {
    issueTypesWithWorkflows = Object.keys(workflows).length;
    for (const typeName of issueTypeNames) {
      const entry = workflows[typeName];
      if (!entry) {
        incompleteWorkflows.push(typeName);
      }
      // Entries marked `{ unsampled: true }` are intentionally sparse (R14);
      // they count as present for section completeness.
    }
  } else {
    incompleteWorkflows.push(...issueTypeNames);
  }

  const sections = {
    cloudId: {
      present: Boolean(cache.cloudId),
    },
    currentUser: {
      present: Boolean(cache.currentUser),
    },
    project: {
      present: Boolean(cache.project),
    },
    issueTypes: {
      present: Boolean(issueTypes),
      count:   issueTypeNames.length,
    },
    fieldSchemas: {
      present:               Boolean(fieldSchemas),
      issueTypesWithSchemas: fieldSchemas ? Object.keys(fieldSchemas).length : 0,
    },
    workflows: {
      present:                  Boolean(workflows),
      issueTypesWithWorkflows,
      incomplete:               incompleteWorkflows,
    },
    linkTypes: {
      present: Boolean(linkTypes),
      count:   linkTypes ? linkTypes.length : 0,
    },
    userMappings: {
      present: Boolean(userMappings),
      count:   userMappings ? Object.keys(userMappings).length : 0,
    },
  };

  const missing = [];
  for (const [name, info] of Object.entries(sections)) {
    if (!info.present) missing.push(name);
  }

  const templateStatus = resolveTemplateStatus(projectKey, resolved.path, templatesDir);
  const customTypes    = Object.entries(templateStatus.resolved)
    .filter(([, v]) => v === 'custom')
    .map(([k]) => k);
  // `uncoveredTypes` retains its pre-fallback semantics (types resolved as 'none')
  // so existing consumers and tests still see only truly-uncovered types. The
  // fallback array is surfaced separately as `fallbacks` for spec R18.
  const uncoveredTypes = templateStatus.noneTypes;
  const fallbackTypes  = templateStatus.fallbacks;

  const warnings = [...resolved.warnings];
  if (ageHours === null) {
    warnings.push('Cache file has no lastUpdated field; freshness cannot be determined.');
  }
  if (incompleteWorkflows.length > 0) {
    warnings.push(`Workflow data missing for issue types: ${incompleteWorkflows.join(', ')}`);
  }

  writeOutput({
    exists: true,
    fresh,
    ageHours:    ageHours !== null ? Math.round(ageHours * 100) / 100 : null,
    maxAgeHours,
    projectKey,
    cachePath:      resolved.path,
    candidateSites: [],
    sections,
    templates: {
      customCount:    customTypes.length,
      defaultCount:   templateStatus.defaultTemplates.length,
      customTypes,
      uncoveredTypes,
      fallbacks:      fallbackTypes,
    },
    missing,
    flags:    flagsBlock,
    errors:   [],
    warnings,
  }, 'jira-context', 0);
}

// ---------------------------------------------------------------------------
// Subcommand: --load
// ---------------------------------------------------------------------------

function loadCache({ projectKey, cacheDir, site }) {
  const resolved = resolveEffectiveCachePath({ projectKey, cacheDir, site });
  for (const w of resolved.warnings) process.stderr.write(`Warning: ${w}\n`);

  if (!resolved.path) {
    if (resolved.candidateSites.length >= 2) {
      writeOutput({
        errors:         [`Multiple cache entries for '${projectKey}' — pass --site <host> to disambiguate.`],
        candidateSites: resolved.candidateSites,
      }, 'jira-context', 1);
      return;
    }
    writeOutput({ errors: ['No cache found for project. Run cache initialization first.'] }, 'jira-context', 1);
    return;
  }
  if (!fs.existsSync(resolved.path)) {
    writeOutput({ errors: ['No cache found for project. Run cache initialization first.'] }, 'jira-context', 1);
    return;
  }
  const cache = JSON.parse(fs.readFileSync(resolved.path, 'utf8'));
  writeOutput(cache, 'jira-context', 0);
}

// ---------------------------------------------------------------------------
// Subcommand: --save
// ---------------------------------------------------------------------------

function saveCache({ projectKey, cacheDir, site }) {
  const raw = readStdin();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    writeOutput({ errors: [`Invalid JSON on stdin: ${err.message}`] }, 'jira-context', 1);
    return;
  }

  const missingFields = ['version', 'cloudId', 'project', 'siteUrl'].filter(f => !(f in data));
  if (missingFields.length > 0) {
    writeOutput({ errors: [`Cache JSON is missing required fields: ${missingFields.join(', ')}`] }, 'jira-context', 1);
    return;
  }

  let writePath;
  if (cacheDir) {
    writePath = getCachePath(projectKey, cacheDir);
  } else {
    const resolvedSite = site || sanitizeSiteHost(data.siteUrl);
    if (!resolvedSite) {
      writeOutput({ errors: [`Cannot derive site host from siteUrl: ${data.siteUrl}`] }, 'jira-context', 1);
      return;
    }
    writePath = path.join(getHomeCacheRoot(), resolvedSite, `${projectKey}.json`);
  }

  fs.mkdirSync(path.dirname(writePath), { recursive: true });
  fs.writeFileSync(writePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  writeOutput({ saved: true, cachePath: writePath }, 'jira-context', 0);
}

// ---------------------------------------------------------------------------
// Subcommand: --save-field
// ---------------------------------------------------------------------------

function saveField({ projectKey, cacheDir, site }, fieldName) {
  const resolved = resolveEffectiveCachePath({ projectKey, cacheDir, site });
  for (const w of resolved.warnings) process.stderr.write(`Warning: ${w}\n`);

  if (!resolved.path || !fs.existsSync(resolved.path)) {
    writeOutput({ errors: ['No cache found for project. Run cache initialization first.'] }, 'jira-context', 1);
    return;
  }

  const raw = readStdin();
  let incoming;
  try {
    incoming = JSON.parse(raw);
  } catch (err) {
    writeOutput({ errors: [`Invalid JSON on stdin: ${err.message}`] }, 'jira-context', 1);
    return;
  }

  let cache;
  try {
    cache = JSON.parse(fs.readFileSync(resolved.path, 'utf8'));
  } catch (err) {
    writeOutput({ errors: [`Cache file is not valid JSON: ${err.message}`] }, 'jira-context', 1);
    return;
  }

  const existing = cache[fieldName];
  if (typeof existing === 'object' && existing !== null && !Array.isArray(existing) &&
      typeof incoming === 'object' && incoming !== null && !Array.isArray(incoming)) {
    cache[fieldName] = Object.assign({}, existing, incoming);
  } else {
    cache[fieldName] = incoming;
  }

  fs.writeFileSync(resolved.path, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  writeOutput({ saved: true, field: fieldName, cachePath: resolved.path }, 'jira-context', 0);
}

// ---------------------------------------------------------------------------
// Subcommand: --templates
// ---------------------------------------------------------------------------

function resolveTemplates({ projectKey, cacheDir, site }, templatesDir) {
  const resolved = resolveEffectiveCachePath({ projectKey, cacheDir, site });
  const status = resolveTemplateStatus(projectKey, resolved.path, templatesDir);
  writeOutput(status, 'jira-context', 0);
}

// ---------------------------------------------------------------------------
// Subcommand: --init-templates
// ---------------------------------------------------------------------------

function initTemplates({ projectKey, cacheDir, site }, templatesDir) {
  const resolved = resolveEffectiveCachePath({ projectKey, cacheDir, site });

  let issueTypes = [];
  if (resolved.path && fs.existsSync(resolved.path)) {
    try {
      const cache = JSON.parse(fs.readFileSync(resolved.path, 'utf8'));
      if (cache.issueTypes && typeof cache.issueTypes === 'object') {
        issueTypes = Object.keys(cache.issueTypes);
      }
    } catch (_) { /* ignore */ }
  }

  // R-projectroot: main-worktree-rooted resolution (#360).
  const customDir    = path.join(resolveSdlcRoot(), '.sdlc', 'jira-templates');
  const initialized  = [];
  const skipped      = [];
  const unavailable  = [];

  fs.mkdirSync(customDir, { recursive: true });

  for (const issueType of issueTypes) {
    const dst = path.join(customDir, `${issueType}.md`);
    if (fs.existsSync(dst)) {
      skipped.push(issueType);
      continue;
    }
    const src = path.join(templatesDir, `${issueType}.md`);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      initialized.push(issueType);
    } else {
      unavailable.push(issueType);
    }
  }

  writeOutput({ initialized, skipped, unavailable }, 'jira-context', 0);
}

// ---------------------------------------------------------------------------
// Subcommand: --clear
// ---------------------------------------------------------------------------

function clearCache({ projectKey, cacheDir, site }) {
  if (cacheDir) {
    const p = getCachePath(projectKey, cacheDir);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    writeOutput({ cleared: true, cachePath: p }, 'jira-context', 0);
    return;
  }
  const candidates = resolveCandidatePaths(projectKey, site);
  const cleared = [];
  for (const c of candidates) {
    if (fs.existsSync(c.path)) {
      fs.unlinkSync(c.path);
      cleared.push(c.path);
    }
  }
  writeOutput({ cleared: true, cachePaths: cleared }, 'jira-context', 0);
}

// ---------------------------------------------------------------------------
// Subcommand: --copy-template
// ---------------------------------------------------------------------------

function copyTemplate(copyType, copyFrom, templatesDir) {
  const src = path.join(templatesDir, copyFrom + '.md');
  if (!fs.existsSync(src)) {
    writeOutput({ errors: [`Template source not found: ${src}`] }, 'jira-context', 1);
    return;
  }

  // R-projectroot: main-worktree-rooted resolution (#360).
  const dst = path.join(resolveSdlcRoot(), '.sdlc', 'jira-templates', copyType + '.md');
  fs.mkdirSync(path.dirname(dst), { recursive: true });

  if (fs.existsSync(dst)) {
    writeOutput({ copied: false, reason: 'exists', type: copyType, destination: dst }, 'jira-context', 0);
    return;
  }

  fs.copyFileSync(src, dst);
  writeOutput({ copied: true, type: copyType, from: copyFrom, destination: dst }, 'jira-context', 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Subcommand: --validate-body (issue #198, R22)
// ---------------------------------------------------------------------------
//
// Reads a Jira description or comment body from stdin (or --file <path>) and
// validates every embedded URL via lib/links.js. Exit 0 if ok, 1 on violation.
// jiraSite is resolved deterministically: if a cache for projectKey is found,
// its `siteUrl` is used; otherwise --site (if provided) is used; otherwise
// validator falls back to home-cache discovery (which returns ambiguous when
// multiple sites are cached).

async function validateBodySubcommand({ projectKey, cacheDir, site, bodyFile, wantJson }) {
  const projectRoot = resolveSdlcRoot(); // issue #351: route to main worktree .sdlc/

  let body = '';
  if (bodyFile) {
    body = fs.readFileSync(bodyFile, 'utf8');
  } else {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) body += chunk;
  }

  // Resolve jiraSite from cache (if projectKey is provided)
  let jiraSite = null;
  if (projectKey) {
    try {
      const resolved = resolveEffectiveCachePath({ projectKey, cacheDir, site });
      if (resolved.path && fs.existsSync(resolved.path)) {
        const cache = JSON.parse(fs.readFileSync(resolved.path, 'utf8'));
        if (cache && cache.siteUrl) jiraSite = cache.siteUrl;
      }
    } catch (_) {
      // best-effort — fall through to ctx.site
    }
  }
  if (!jiraSite && site) {
    // Allow explicit --site to override even without a cache present
    jiraSite = site.startsWith('http') ? site : `https://${site}`;
  }

  // expectedRepo is derived from current git remote (same source as pr.js)
  let expectedRepo = null;
  try { expectedRepo = parseRemoteOwner(projectRoot); } catch (_) { /* no remote → null */ }

  const result = await validateLinks(body, { projectRoot, expectedRepo, jiraSite });

  if (wantJson) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (result.ok) {
    const skipNote = result.skipped.length ? ` (${result.skipped.length} skipped)` : '';
    process.stdout.write('OK: Jira body link verification passed' + skipNote + '\n');
  } else {
    process.stderr.write('Jira body link verification FAILED before MCP call:\n');
    process.stderr.write(formatViolations(result.violations));
    process.stderr.write('\n');
  }
  process.exit(result.ok ? 0 : 1);
}

function main() {
  const parsed = parseArgs(process.argv);
  const { projectKey, cacheDir, templatesDir: templatesOverride, subcommand, saveFieldName, copyType, copyFrom, site, skipWorkflowDiscovery, bodyFile, wantJson, errors } = parsed;

  // Issue #232: verifyAndMigrate gate (CLI > env > default false).
  const projectRoot = resolveSdlcRoot(); // issue #351: route to main worktree .sdlc/
  const skipConfigCheck = resolveSkipConfigCheck(process.argv);
  const cv = ensureConfigVersion(projectRoot, { skip: skipConfigCheck, roles: ['project'] });
  if (cv.errors.length > 0) {
    for (const e of cv.errors) errors.push(`config-version: ${e.role}: ${e.message}`);
    writeOutput({ errors, flags: { skipConfigCheck }, migration: cv.migration }, 'jira-context', 1);
    return;
  }

  if (errors.length > 0) {
    writeOutput({ errors }, 'jira-context', 1);
    return;
  }

  const templatesDir = resolveTemplatesDir(templatesOverride);
  const ctx = { projectKey, cacheDir, site, skipWorkflowDiscovery, templatesDir };

  switch (subcommand) {
    case 'check':
      checkCache(ctx);
      break;
    case 'load':
      loadCache(ctx);
      break;
    case 'save':
      saveCache(ctx);
      break;
    case 'save-field':
      saveField(ctx, saveFieldName);
      break;
    case 'templates':
      resolveTemplates(ctx, templatesDir);
      break;
    case 'init-templates':
      initTemplates(ctx, templatesDir);
      break;
    case 'clear':
      clearCache(ctx);
      break;
    case 'copy-template':
      copyTemplate(copyType, copyFrom, templatesDir);
      break;
    case 'validate-body':
      // Async — return the promise so main() can be awaited or process exits when settled
      validateBodySubcommand({ projectKey, cacheDir, site, bodyFile, wantJson }).catch(err => {
        process.stderr.write(`jira.js --validate-body error: ${err && err.stack || err}\n`);
        process.exit(2);
      });
      return;
    default:
      writeOutput({ errors: [`Unknown subcommand: ${subcommand}`] }, 'jira-context', 1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`jira-prepare.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = {
  parseArgs,
  getCachePath,
  getHomeCacheRoot,
  sanitizeSiteHost,
  resolveCandidatePaths,
  loadJiraConfig,
  resolveEffectiveCachePath,
  validateProjectMembership,
  resolveTemplatesDir,
  checkCache,
  loadCache,
  saveCache,
  saveField,
  resolveTemplates,
  initTemplates,
  clearCache,
  copyTemplate,
};
