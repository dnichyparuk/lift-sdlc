#!/usr/bin/env node
/**
 * validate-cost-tiers.js
 *
 * Diff every skill's and agent's frontmatter `model:` against the canonical
 * tables in `docs/cost-tiers.md`. Fail CI on drift.
 *
 * Usage:
 *   node validate-cost-tiers.js [options]
 *
 * Options:
 *   --root <path>   Project root (default: process.cwd())
 *   --strict        Treat INHERITED (frontmatter absent) as an error
 *   --json          Emit findings as JSON instead of human-readable lines
 *
 * Exit codes:
 *   0 — clean (no drift; INHERITED only emitted to stderr unless --strict)
 *   1 — drift, missing-doc, stale-doc, or (with --strict) inherited
 *   2 — parse / IO error
 *
 * Reuses extractFrontmatter + parseSimpleYaml from
 * `plugins/lift-sdlc/scripts/lib/dimensions.js` per the dry guardrail.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const { extractFrontmatter, parseSimpleYaml } = require(path.join(LIB, 'dimensions'));
const { resolveSdlcRoot } = require(path.join(LIB, 'config'));

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  // C-projectroot (#360): default to main-worktree .sdlc/ root, not cwd.
  let root = resolveSdlcRoot();
  let strict = false;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--root' && args[i + 1]) {
      root = path.resolve(args[++i]);
    } else if (a === '--strict') {
      strict = true;
    } else if (a === '--json') {
      json = true;
    }
  }

  return { root, strict, json };
}

// ---------------------------------------------------------------------------
// Frontmatter scanning
// ---------------------------------------------------------------------------

function resolveSkillsDir(root) {
  // Real repo layout
  const real = path.join(root, 'plugins', 'lift-sdlc', 'skills');
  if (fs.existsSync(real)) return real;
  // Fixture layout — flat <root>/skills
  const flat = path.join(root, 'skills');
  if (fs.existsSync(flat)) return flat;
  return null;
}

function resolveAgentsDir(root) {
  const real = path.join(root, 'plugins', 'lift-sdlc', 'agents');
  if (fs.existsSync(real)) return real;
  const flat = path.join(root, 'agents');
  if (fs.existsSync(flat)) return flat;
  return null;
}

function scanSkills(root) {
  const skillsDir = resolveSkillsDir(root);
  const out = [];
  if (!skillsDir) return out;
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillFile = path.join(skillsDir, ent.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const content = fs.readFileSync(skillFile, 'utf8');
    const fmRaw = extractFrontmatter(content);
    if (!fmRaw) {
      out.push({ name: ent.name, model: null, file: skillFile });
      continue;
    }
    const fm = parseSimpleYaml(fmRaw);
    out.push({
      name: fm.name || ent.name,
      model: fm.model || null,
      file: skillFile,
    });
  }
  return out;
}

function scanAgents(root) {
  const agentsDir = resolveAgentsDir(root);
  const out = [];
  if (!agentsDir) return out;
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith('.md')) continue;
    const agentFile = path.join(agentsDir, ent.name);
    const content = fs.readFileSync(agentFile, 'utf8');
    const fmRaw = extractFrontmatter(content);
    const baseName = ent.name.replace(/\.md$/, '');
    if (!fmRaw) {
      out.push({ name: baseName, model: null, file: agentFile });
      continue;
    }
    const fm = parseSimpleYaml(fmRaw);
    out.push({
      name: fm.name || baseName,
      model: fm.model || null,
      file: agentFile,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Doc parsing
// ---------------------------------------------------------------------------

/**
 * Parse the two markdown tables (Skill table + Agent table) from cost-tiers.md.
 * Strategy:
 *   - Find each `## 3. Skill Table` / `## 4. Agent Table` heading.
 *   - From the heading, scan forward to the first table header row (`| ... |`)
 *     followed by a separator (`|---|...|`).
 *   - Read subsequent rows until a blank line or non-pipe line.
 *   - Extract column 0 (name) and column 1 (model). Reject rows whose pipe
 *     count != header pipe count.
 */
function parseDocTables(root) {
  const docPath = path.join(root, 'docs', 'cost-tiers.md');
  if (!fs.existsSync(docPath)) {
    throw new Error(`docs/cost-tiers.md not found at ${docPath}`);
  }
  const lines = fs.readFileSync(docPath, 'utf8').split('\n');

  function findTableAfter(headingRegex) {
    const headingIdx = lines.findIndex(l => headingRegex.test(l));
    if (headingIdx === -1) return [];
    // Find first table header row after the heading.
    let i = headingIdx + 1;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*\|/.test(line)) {
        // Next line should be the separator.
        const sep = lines[i + 1];
        if (sep && /^\s*\|[\s|:-]+\|\s*$/.test(sep)) {
          return readTableRows(i, sep);
        }
      }
      // Stop if we hit the next `##` heading without finding a table.
      if (/^##\s/.test(line) && i !== headingIdx) return [];
      i++;
    }
    return [];
  }

  function readTableRows(headerIdx, sep) {
    const headerCells = splitRow(lines[headerIdx]);
    const expectedPipes = (lines[headerIdx].match(/\|/g) || []).length;
    const rows = [];
    let i = headerIdx + 2; // skip header + separator
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim() || !line.trim().startsWith('|')) break;
      const pipeCount = (line.match(/\|/g) || []).length;
      if (pipeCount !== expectedPipes) {
        throw new Error(
          `cost-tiers.md: row ${i + 1} has ${pipeCount} pipes, expected ${expectedPipes}: ${line}`
        );
      }
      const cells = splitRow(line);
      rows.push({
        name: cells[0],
        model: cells[1],
        line: i + 1,
      });
      i++;
    }
    return { headerCells, rows };
  }

  function splitRow(line) {
    // `| a | b | c |` → ["a", "b", "c"]
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return trimmed.split('|').map(c => c.trim());
  }

  const skills = findTableAfter(/^##\s+3\.\s+Skill Table/);
  const agents = findTableAfter(/^##\s+4\.\s+Agent Table/);

  if (!skills.rows || skills.rows.length === 0) {
    throw new Error('cost-tiers.md: skill table not found or empty (heading "## 3. Skill Table")');
  }
  if (!agents.rows || agents.rows.length === 0) {
    throw new Error('cost-tiers.md: agent table not found or empty (heading "## 4. Agent Table")');
  }

  return {
    skills: skills.rows,
    agents: agents.rows,
  };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

function diffOne(actuals, docRows, kind, findings) {
  const docByName = new Map(docRows.map(r => [r.name, r.model]));
  const actualByName = new Map(actuals.map(a => [a.name, a.model]));

  for (const a of actuals) {
    const docModel = docByName.get(a.name);
    if (a.model === null) {
      findings.push({ kind: 'INHERITED', target: kind, name: a.name, file: a.file });
      continue;
    }
    if (docModel === undefined) {
      findings.push({ kind: 'MISSING_DOC', target: kind, name: a.name, frontmatter: a.model });
      continue;
    }
    if (docModel !== a.model) {
      findings.push({
        kind: 'DRIFT',
        target: kind,
        name: a.name,
        frontmatter: a.model,
        doc: docModel,
      });
    }
  }

  for (const r of docRows) {
    if (!actualByName.has(r.name)) {
      findings.push({ kind: 'STALE_DOC', target: kind, name: r.name });
    }
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function emitHuman(findings, strict) {
  let exitCode = 0;
  for (const f of findings) {
    if (f.kind === 'DRIFT') {
      process.stdout.write(`DRIFT: ${f.name} frontmatter=${f.frontmatter} doc=${f.doc}\n`);
      exitCode = 1;
    } else if (f.kind === 'MISSING_DOC') {
      process.stdout.write(`MISSING_DOC: ${f.name}=${f.frontmatter}\n`);
      exitCode = 1;
    } else if (f.kind === 'STALE_DOC') {
      process.stdout.write(`STALE_DOC: ${f.name}\n`);
      exitCode = 1;
    } else if (f.kind === 'INHERITED') {
      process.stderr.write(`INHERITED: ${f.name}\n`);
      if (strict) exitCode = 1;
    }
  }
  return exitCode;
}

function emitJson(findings, strict) {
  let exitCode = 0;
  for (const f of findings) {
    if (f.kind === 'DRIFT' || f.kind === 'MISSING_DOC' || f.kind === 'STALE_DOC') {
      exitCode = 1;
    } else if (f.kind === 'INHERITED' && strict) {
      exitCode = 1;
    }
  }
  process.stdout.write(JSON.stringify({ findings, strict, exitCode }, null, 2) + '\n');
  return exitCode;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

try {
  const { root, strict, json } = parseArgs(process.argv);

  const skills = scanSkills(root);
  const agents = scanAgents(root);
  const doc = parseDocTables(root);

  const findings = [];
  diffOne(skills, doc.skills, 'skill', findings);
  diffOne(agents, doc.agents, 'agent', findings);

  const exitCode = json ? emitJson(findings, strict) : emitHuman(findings, strict);
  process.exit(exitCode);
} catch (err) {
  process.stderr.write(`validate-cost-tiers.js error: ${err.message}\n`);
  process.exit(2);
}
