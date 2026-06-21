/**
 * discovery.js
 * Validates the plugin discovery and cross-reference chain.
 * Checks that every manifest, skill, script, hook, and agent is
 * correctly wired so the plugin will work after installation.
 *
 * Zero external dependencies — Node.js built-ins only.
 *
 * Exports: validateAll
 *
 * Check IDs:
 *   PD1  plugin-manifest-exists          — plugin.json exists and is valid JSON
 *   PD2  plugin-required-fields          — name present; description/version recommended
 *   PD3  semver-format                   — version, if present, is valid semver
 *   PD4  skills-discoverable             — skills have SKILL.md with name+description
 *   PD5  skill-supporting-files-exist    — sibling .md files referenced in SKILL.md exist
 *   PD6  skill-agent-refs-valid          — agents referenced in skills exist
 *   PD7  skill-script-refs-valid         — scripts referenced in skills exist
 *   PD8  hooks-valid-json                — hooks.json exists and parses
 *   PD9  agents-discoverable             — agents have frontmatter with name+description+tools
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { extractFrontmatter, parseSimpleYaml } = require('./yaml.js');

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

function readFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function listDir(dirPath) {
  try { return fs.readdirSync(dirPath); } catch { return []; }
}

// ---------------------------------------------------------------------------
// Pattern extractors for cross-reference detection
// ---------------------------------------------------------------------------

// Extract script filenames from `find -name "<script>.js"` patterns.
// Excludes placeholder patterns like "<script>.js" (containing < or >).
const RE_FIND_SCRIPT = /find\s[^`\n]*?-name\s+["']([^"'<>]+\.js)["']/g;

// Extract relative path from `-path "*/sdlc*/scripts/<subdir>/<name>.js"` patterns.
// Captures the portion after `scripts/` (e.g., `skill/commit.js`).
const RE_PATH_SCRIPT = /-path\s+["']\*\/sdlc\*\/scripts\/([^\s"'<>]+\.js)["']/g;

// Extract script filenames from direct-path fallback pattern:
// plugins/lift-sdlc/scripts/<subdir>/<script>.js
const RE_DIRECT_SCRIPT = /plugins\/lift-sdlc\/scripts\/([^\s"'<>]+\.js)/g;

function extractScriptRefs(content) {
  const names = new Set();
  let m;
  // Prefer -path match (includes subdirectory) over -name match (bare filename)
  const rePathScript = new RegExp(RE_PATH_SCRIPT.source, 'g');
  while ((m = rePathScript.exec(content)) !== null) {
    names.add(m[1]);
  }
  const reDirectScript = new RegExp(RE_DIRECT_SCRIPT.source, 'g');
  while ((m = reDirectScript.exec(content)) !== null) {
    names.add(m[1]);
  }
  // Fall back to -name for patterns that lack -path (e.g., lib/config.js lookups)
  const reFindScript = new RegExp(RE_FIND_SCRIPT.source, 'g');
  while ((m = reFindScript.exec(content)) !== null) {
    // Skip if we already captured this script via -path or direct pattern
    const basename = m[1];
    const alreadyCaptured = [...names].some(n => n === basename || n.endsWith('/' + basename));
    if (!alreadyCaptured) {
      names.add(m[1]);
    }
  }
  return [...names];
}

// Extract skill names from `Invoke the `<skill-name>` skill` patterns
const RE_INVOKE_SKILL = /Invoke the `([^`]+)` skill/g;

function extractSkillRefs(content) {
  const names = new Set();
  let m;
  const re = new RegExp(RE_INVOKE_SKILL.source, 'g');
  while ((m = re.exec(content)) !== null) {
    names.add(m[1]);
  }
  return [...names];
}

// Extract agent names from `agents/<name>` or `` `<name>` agent `` patterns
const RE_AGENTS_PATH = /agents\/([a-z][a-z0-9-]+)/g;
const RE_AGENT_BACKTICK = /`([a-z][a-z0-9-]+)`\s+agent/g;

function extractAgentRefs(content) {
  const names = new Set();
  let m;
  const re1 = new RegExp(RE_AGENTS_PATH.source, 'g');
  while ((m = re1.exec(content)) !== null) {
    names.add(m[1]);
  }
  const re2 = new RegExp(RE_AGENT_BACKTICK.source, 'g');
  while ((m = re2.exec(content)) !== null) {
    names.add(m[1]);
  }
  return [...names];
}

// Extract sibling supporting-file references: backtick-wrapped uppercase .md filenames.
// Uses negative lookbehind/lookahead to exclude double-backtick code spans
// (`` `REFERENCE.md` `` is an example in text, not a real file reference).
// Also excludes known project artifact filenames that are never skill siblings.
const RE_SIBLING_MD = /(?<!`)`(?:resources\/)?([A-Z][A-Z0-9_-]*\.md)`(?!`)/g;
const NON_SIBLING_MD = new Set(['CHANGELOG.md', 'README.md', 'LICENSE.md', 'AGENTS.md', 'SKILL.md']);

function extractSiblingFileRefs(content) {
  const names = new Set();
  let m;
  const re = new RegExp(RE_SIBLING_MD.source, 'g');
  while ((m = re.exec(content)) !== null) {
    if (!NON_SIBLING_MD.has(m[1])) {
      names.add(m[1]);
    }
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// Check builders
// ---------------------------------------------------------------------------

function pass(id, check, message) {
  return { id, check, status: 'pass', severity: 'error', message, details: [] };
}

function fail(id, check, severity, message, details = []) {
  return { id, check, status: 'fail', severity, message, details };
}

function skip(id, check, reason) {
  return { id, check, status: 'skip', severity: 'error', message: reason, details: [] };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkPD1(projectRoot) {
  const filePath = path.join(projectRoot, 'plugin.json');
  const rel = 'plugin.json';

  if (!isFile(filePath)) {
    return { finding: fail('PD1', 'plugin-manifest-exists', 'error',
      `${rel} not found`, [`Expected at: ${filePath}`]), data: null };
  }

  const content = readFile(filePath);
  if (content === null) {
    return { finding: fail('PD1', 'plugin-manifest-exists', 'error',
      `${rel} is not readable`, []), data: null };
  }

  let data;
  try {
    data = JSON.parse(content);
  } catch (err) {
    return { finding: fail('PD1', 'plugin-manifest-exists', 'error',
      `${rel} contains invalid JSON`, [err.message]), data: null };
  }

  return { finding: pass('PD1', 'plugin-manifest-exists',
    `${rel} exists and is valid JSON`), data };
}

function checkPD2(projectRoot, manifest) {
  if (!manifest) return skip('PD2', 'plugin-required-fields', 'PD1 failed — cannot check');
  const rel = 'plugin.json';
  const details = [];
  if (!manifest.name) details.push(`${rel}: missing required field "name"`);
  if (!manifest.description) details.push(`${rel}: missing recommended field "description" (optional but strongly advised)`);
  if (!manifest.version) details.push(`${rel}: missing recommended field "version" (optional but strongly advised)`);
  if (details.filter(d => d.includes('required')).length > 0) {
    return fail('PD2', 'plugin-required-fields', 'error',
      `${rel} is missing required fields`, details);
  }
  if (details.length > 0) {
    return fail('PD2', 'plugin-required-fields', 'warning',
      `${rel} is missing recommended fields`, details);
  }
  return pass('PD2', 'plugin-required-fields',
    `${rel} has required field "name" and recommended fields`);
}

const RE_SEMVER = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

function checkPD3(manifest) {
  if (!manifest) return skip('PD3', 'semver-format', 'PD1 failed — cannot check');
  if (!manifest.version) return skip('PD3', 'semver-format', 'version field absent — skipping semver check');
  if (!RE_SEMVER.test(manifest.version)) {
    return fail('PD3', 'semver-format', 'error',
      `plugin.json version "${manifest.version}" is not valid semver (expected X.Y.Z or X.Y.Z-pre)`, []);
  }
  return pass('PD3', 'semver-format', `version "${manifest.version}" is valid semver`);
}

function checkPD4(projectRoot) {
  const skillsDir = path.join(projectRoot, 'skills');
  const skillDirs = listDir(skillsDir).filter(d => isDir(path.join(skillsDir, d)));
  const details = [];
  for (const d of skillDirs) {
    const skillFile = path.join(skillsDir, d, 'SKILL.md');
    if (!isFile(skillFile)) {
      details.push(`skills/${d}: SKILL.md is missing`);
      continue;
    }
    const content = readFile(skillFile);
    if (!content) { details.push(`skills/${d}/SKILL.md: cannot read`); continue; }
    const rawFm = extractFrontmatter(content);
    if (!rawFm) {
      details.push(`skills/${d}/SKILL.md: missing YAML frontmatter`);
      continue;
    }
    const fm = parseSimpleYaml(rawFm);
    if (!fm.name)        details.push(`skills/${d}/SKILL.md: frontmatter missing "name"`);
    if (!fm.description) details.push(`skills/${d}/SKILL.md: frontmatter missing "description"`);
  }
  if (details.length > 0) {
    return fail('PD4', 'skills-discoverable', 'error',
      'One or more skills are missing SKILL.md or required frontmatter', details);
  }
  return pass('PD4', 'skills-discoverable',
    `All ${skillDirs.length} skill(s) have SKILL.md with name and description`);
}

function checkPD5(projectRoot) {
  const skillsDir = path.join(projectRoot, 'skills');
  const skillDirs = listDir(skillsDir).filter(d => isDir(path.join(skillsDir, d)));
  const details = [];
  for (const d of skillDirs) {
    const skillFile = path.join(skillsDir, d, 'SKILL.md');
    const content = readFile(skillFile);
    if (!content) continue;
    const siblingRefs = extractSiblingFileRefs(content);
    for (const ref of siblingRefs) {
      if (ref === 'SKILL.md') continue;
      const siblingPath = path.join(skillsDir, d, ref);
      if (!isFile(siblingPath)) {
        details.push(
          `skills/${d}/SKILL.md: references \`${ref}\` ` +
          `but the file does not exist in the skill directory`
        );
      }
    }
  }
  if (details.length > 0) {
    return fail('PD5', 'skill-supporting-files-exist', 'error',
      'One or more skills reference supporting files that do not exist', details);
  }
  return pass('PD5', 'skill-supporting-files-exist',
    'All sibling file references in SKILL.md files resolve to existing files');
}

function checkPD6(projectRoot) {
  const skillsDir = path.join(projectRoot, 'skills');
  const agentsDir = path.join(projectRoot, 'agents');
  const skillDirs = listDir(skillsDir).filter(d => isDir(path.join(skillsDir, d)));
  const details = [];
  for (const d of skillDirs) {
    const content = readFile(path.join(skillsDir, d, 'SKILL.md'));
    if (!content) continue;
    const agentRefs = extractAgentRefs(content);
    for (const agentName of agentRefs) {
      const agentPath = path.join(agentsDir, `${agentName}.md`);
      if (!isFile(agentPath)) {
        details.push(
          `skills/${d}/SKILL.md: references agent "${agentName}" ` +
          `but agents/${agentName}.md does not exist`
        );
      }
    }
  }
  if (details.length > 0) {
    return fail('PD6', 'skill-agent-refs-valid', 'error',
      'One or more skills reference agents that do not exist', details);
  }
  return pass('PD6', 'skill-agent-refs-valid',
    'All agent references in skills resolve to existing agent files');
}

function checkPD7(projectRoot) {
  const skillsDir = path.join(projectRoot, 'skills');
  const scriptDir = path.join(projectRoot, 'scripts');
  const skillDirs = listDir(skillsDir).filter(d => isDir(path.join(skillsDir, d)));
  const details = [];
  for (const d of skillDirs) {
    const content = readFile(path.join(skillsDir, d, 'SKILL.md'));
    if (!content) continue;
    const scriptRefs = extractScriptRefs(content);
    for (const scriptName of scriptRefs) {
      const scriptPath = path.join(scriptDir, scriptName);
      if (!isFile(scriptPath)) {
        details.push(
          `skills/${d}/SKILL.md: references script "${scriptName}" ` +
          `but scripts/${scriptName} does not exist`
        );
      }
    }
  }
  if (details.length > 0) {
    return fail('PD7', 'skill-script-refs-valid', 'warning',
      'One or more skills reference scripts that do not exist', details);
  }
  return pass('PD7', 'skill-script-refs-valid',
    'All script references in skills resolve to existing files');
}

function checkPD8(projectRoot) {
  // Accept both plugin-root hooks.json (Antigravity spec) and hooks/hooks.json (lift-sdlc convention)
  const hooksRoot  = path.join(projectRoot, 'hooks.json');
  const hooksSubdir = path.join(projectRoot, 'hooks', 'hooks.json');
  const hooksPath  = isFile(hooksRoot) ? hooksRoot : isFile(hooksSubdir) ? hooksSubdir : null;

  if (!hooksPath) {
    return fail('PD8', 'hooks-valid-json', 'error',
      'hooks.json not found', [`Expected at: ${hooksRoot} or ${hooksSubdir}`]);
  }
  const content = readFile(hooksPath);
  if (!content) {
    return fail('PD8', 'hooks-valid-json', 'error', `${hooksPath}: cannot read`, []);
  }
  try {
    JSON.parse(content);
  } catch (err) {
    return fail('PD8', 'hooks-valid-json', 'error',
      `${hooksPath}: invalid JSON — ${err.message}`, []);
  }
  return pass('PD8', 'hooks-valid-json', `${path.relative(projectRoot, hooksPath)} exists and is valid JSON`);
}

function checkPD9(projectRoot) {
  const agentsDir = path.join(projectRoot, 'agents');
  const files = listDir(agentsDir).filter(f => f.endsWith('.md'));
  const details = [];
  for (const f of files) {
    const content = readFile(path.join(agentsDir, f));
    if (!content) { details.push(`agents/${f}: cannot read`); continue; }
    const rawFm = extractFrontmatter(content);
    if (!rawFm) {
      details.push(`agents/${f}: missing YAML frontmatter`);
      continue;
    }
    const fm = parseSimpleYaml(rawFm);
    if (!fm.name)        details.push(`agents/${f}: frontmatter missing "name"`);
    if (!fm.description) details.push(`agents/${f}: frontmatter missing "description"`);
    if (!fm.tools)       details.push(`agents/${f}: frontmatter missing "tools"`);
  }
  if (details.length > 0) {
    return fail('PD9', 'agents-discoverable', 'warning',
      'One or more agent files are missing required frontmatter', details);
  }
  return pass('PD9', 'agents-discoverable',
    `All ${files.length} agent file(s) have frontmatter with name, description, and tools`);
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

function validateAll(projectRoot) {
  const checks = [];

  // PD1 — plugin manifest
  const { finding: pd1, data: manifest } = checkPD1(projectRoot);
  checks.push(pd1);

  // PD2–PD3 — manifest fields (depend on PD1 data)
  checks.push(checkPD2(projectRoot, manifest));
  checks.push(checkPD3(manifest));

  // PD4–PD9 — plugin component checks (all operate on projectRoot directly)
  checks.push(checkPD4(projectRoot));
  checks.push(checkPD5(projectRoot));
  checks.push(checkPD6(projectRoot));
  checks.push(checkPD7(projectRoot));
  checks.push(checkPD8(projectRoot));
  checks.push(checkPD9(projectRoot));

  const failed  = checks.filter(c => c.status === 'fail');
  const errors  = failed.filter(c => c.severity === 'error').length;
  const warnings = failed.filter(c => c.severity === 'warning').length;
  const passed  = checks.filter(c => c.status === 'pass').length;

  return {
    overall: errors > 0 ? 'fail' : 'pass',
    project_root: projectRoot,
    summary: {
      total: checks.length,
      pass: passed,
      fail: failed.length,
      total_errors: errors,
      total_warnings: warnings,
    },
    checks,
  };
}

module.exports = { validateAll };
