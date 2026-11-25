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
 * `scripts/lib/dimensions.js` per the dry guardrail.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LIB = path.join(__dirname, '..', 'lib');
const { extractFrontmatter, parseSimpleYaml } = require(path.join(LIB, 'dimensions'));
const { resolveSdlcRoot } = require(path.join(LIB, 'config'));
const { GEMINI4_MODELS, VALID_AGY_ENUMS } = require(path.join(LIB, 'model-tiers'));

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
  const flat = path.join(root, 'skills');
  if (fs.existsSync(flat)) return flat;
  return null;
}

function resolveAgentsDir(root) {
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
 * Parse the two markdown tables (Skill table + Agent table) from model-references.md (or cost-tiers.md).
 * Strategy:
 *   - Find each `## 3. ...Skill...` / `## 4. ...Agent...` heading.
 *   - From the heading, scan forward to the first table header row (`| ... |`)
 *     followed by a separator (`|---|...|`).
 *   - Read subsequent rows until a blank line or non-pipe line.
 *   - Dynamically locate Name and Model columns, stripping markdown formatting.
 *   - Reject rows whose pipe count != header pipe count.
 */
function parseDocTables(root) {
  let docPath = path.join(root, 'docs', 'model-references.md');
  if (!fs.existsSync(docPath)) {
    docPath = path.join(root, 'docs', 'cost-tiers.md');
  }
  if (!fs.existsSync(docPath)) {
    throw new Error(`Neither docs/model-references.md nor docs/cost-tiers.md found in ${root}`);
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

  function cleanCell(cell) {
    // Strip markdown formatting: bold/italic (*, edge _), code backticks (`), links [text](url) -> text
    // Preserve intra-word underscores (e.g., `flash_lite`).
    return cell
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*`]/g, '')
      .replace(/(^|\s)_+|_+(\s|$)/g, '$1$2')
      .trim();
  }

  function readTableRows(headerIdx, sep) {
    const headerCells = splitRow(lines[headerIdx]);
    const expectedPipes = (lines[headerIdx].match(/\|/g) || []).length;

    const nameColIdx = headerCells.findIndex(h => /name/i.test(h));
    const modelColIdx = headerCells.findIndex(h => /frontmatter model/i.test(h) || /^model$/i.test(h));

    if (nameColIdx === -1 || modelColIdx === -1) {
      throw new Error(
        `Unable to identify Name or Model column in table header: ${lines[headerIdx]}`
      );
    }

    const rows = [];
    let i = headerIdx + 2; // skip header + separator
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim() || !line.trim().startsWith('|')) break;
      const pipeCount = (line.match(/\|/g) || []).length;
      if (pipeCount !== expectedPipes) {
        throw new Error(
          `Table row ${i + 1} has ${pipeCount} pipes, expected ${expectedPipes}: ${line}`
        );
      }
      const cells = splitRow(line);
      rows.push({
        name: cleanCell(cells[nameColIdx]),
        model: cleanCell(cells[modelColIdx]),
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

  const skills = findTableAfter(/^##\s+3\.\s+.*Skill/i);
  const agents = findTableAfter(/^##\s+4\.\s+.*Agent/i);

  if (!skills.rows || skills.rows.length === 0) {
    throw new Error('Skill table not found or empty under heading matching "## 3. ...Skill..."');
  }
  if (!agents.rows || agents.rows.length === 0) {
    throw new Error('Agent table not found or empty under heading matching "## 4. ...Agent..."');
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

function validateAgentModels(agents, findings) {
  for (const a of agents) {
    if (a.model !== null && !VALID_AGY_ENUMS.includes(a.model)) {
      findings.push({
        kind: 'INVALID_AGENT_MODEL',
        target: 'agent',
        name: a.name,
        frontmatter: a.model,
        allowed: VALID_AGY_ENUMS,
      });
    }
  }
}

function validatePipelineManifest(root, findings) {
  const skillsDir = resolveSkillsDir(root);
  if (!skillsDir) return;
  const pipelinePath = path.join(skillsDir, 'ship-sdlc', 'pipeline.json');
  if (!fs.existsSync(pipelinePath)) return;

  const manifest = JSON.parse(fs.readFileSync(pipelinePath, 'utf8'));
  const validPipelineModels = new Set([...GEMINI4_MODELS, 'inherit']);

  if (manifest.orchestratorModel !== null && manifest.orchestratorModel !== undefined) {
    if (!validPipelineModels.has(manifest.orchestratorModel)) {
      findings.push({
        kind: 'INVALID_PIPELINE_MODEL',
        target: 'pipeline',
        name: 'orchestratorModel',
        model: manifest.orchestratorModel,
      });
    }
  }

  for (const step of manifest.steps || []) {
    if (step.dispatchMode === null) {
      if (step.defaultModel !== null && step.defaultModel !== undefined) {
        if (!validPipelineModels.has(step.defaultModel)) {
          findings.push({
            kind: 'INVALID_PIPELINE_MODEL',
            target: 'pipeline',
            name: `steps.${step.id}.defaultModel`,
            model: step.defaultModel,
          });
        }
      }
    } else if (step.defaultModel === null || step.defaultModel === undefined || !validPipelineModels.has(step.defaultModel)) {
      findings.push({
        kind: 'INVALID_PIPELINE_MODEL',
        target: 'pipeline',
        name: `steps.${step.id}.defaultModel`,
        model: step.defaultModel ?? null,
      });
    }
    if (step.loop && Array.isArray(step.loop.subDispatch)) {
      for (const sd of step.loop.subDispatch) {
        if (sd.model !== null && sd.model !== undefined && !validPipelineModels.has(sd.model)) {
          findings.push({
            kind: 'INVALID_PIPELINE_MODEL',
            target: 'pipeline',
            name: `steps.${step.id}.loop.subDispatch.${sd.skill}.model`,
            model: sd.model,
          });
        }
      }
    }
  }
}

function validateSkillCallerModels(root, agents, findings) {
  const skillsDir = resolveSkillsDir(root);
  if (!skillsDir) return;

  const agentModelByName = new Map();
  for (const a of agents) {
    if (a.model !== null) {
      agentModelByName.set(a.name, a.model);
    }
  }
  if (agentModelByName.size === 0) return;

  const typeNameRe = /(?:["']?TypeName["']?)\s*:\s*["']([a-z0-9-]+)["']/;
  const modelRe = /(?:["']?Model["']?)\s*:\s*["'](inherit|flash_lite|flash|pro)["']/;

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillFile = path.join(skillsDir, ent.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const content = fs.readFileSync(skillFile, 'utf8');
    if (!content.includes('invoke_subagent')) continue;

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const tm = lines[i].match(typeNameRe);
      if (!tm) continue;
      const agentName = tm[1];
      if (!agentModelByName.has(agentName)) continue;

      let callerModel = null;
      // Scan forward within the same subagent block (up to 8 lines)
      for (let j = i + 1; j <= Math.min(lines.length - 1, i + 8); j++) {
        if (typeNameRe.test(lines[j])) break;
        if (/^\s*\}/.test(lines[j])) break;
        const mm = lines[j].match(modelRe);
        if (mm) {
          callerModel = mm[1];
          break;
        }
      }
      // Scan backward if Model preceded TypeName (up to 4 lines)
      if (!callerModel) {
        for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
          if (typeNameRe.test(lines[j])) break;
          if (/^\s*\{/.test(lines[j])) break;
          const mm = lines[j].match(modelRe);
          if (mm) {
            callerModel = mm[1];
            break;
          }
        }
      }

      if (callerModel) {
        const expectedModel = agentModelByName.get(agentName);
        if (callerModel !== expectedModel) {
          findings.push({
            kind: 'CALLER_MODEL_MISMATCH',
            target: 'skill-caller',
            skill: ent.name,
            agent: agentName,
            callerModel,
            agentModel: expectedModel,
            line: i + 1,
            file: skillFile,
          });
        }
      }
    }
  }
}

function validateNoLegacyGemini3(root, findings) {
  const skillsDir = resolveSkillsDir(root);
  if (!skillsDir) return;

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const filesToCheck = [];
    const skillFile = path.join(skillsDir, ent.name, 'SKILL.md');
    if (fs.existsSync(skillFile)) {
      filesToCheck.push(skillFile);
    }
    const resourcesDir = path.join(skillsDir, ent.name, 'resources');
    if (fs.existsSync(resourcesDir) && fs.statSync(resourcesDir).isDirectory()) {
      for (const rEnt of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
        if (rEnt.isFile() && rEnt.name.endsWith('.md')) {
          filesToCheck.push(path.join(resourcesDir, rEnt.name));
        }
      }
    }

    for (const filePath of filesToCheck) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/);
      const relPath = path.relative(root, filePath).replace(/\\/g, '/');
      for (let i = 0; i < lines.length; i++) {
        if (/gemini-3\./i.test(lines[i])) {
          findings.push({
            kind: 'LEGACY_GEMINI3_REF',
            target: 'skill-doc',
            name: relPath,
            line: i + 1,
          });
        }
      }
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
    } else if (f.kind === 'INVALID_AGENT_MODEL') {
      process.stdout.write(`INVALID_AGENT_MODEL: ${f.name}=${f.frontmatter} (expected one of: ${VALID_AGY_ENUMS.join('|')})\n`);
      exitCode = 1;
    } else if (f.kind === 'INVALID_PIPELINE_MODEL') {
      process.stdout.write(`INVALID_PIPELINE_MODEL: ${f.name}=${f.model} (expected Gemini 4 tier or inherit)\n`);
      exitCode = 1;
    } else if (f.kind === 'CALLER_MODEL_MISMATCH') {
      process.stdout.write(`CALLER_MODEL_MISMATCH: ${f.skill} invokes ${f.agent} with Model=${f.callerModel}, but agents/${f.agent}.md declares model=${f.agentModel} (line ${f.line})\n`);
      exitCode = 1;
    } else if (f.kind === 'LEGACY_GEMINI3_REF') {
      process.stdout.write(`LEGACY_GEMINI3_REF: ${f.name}:${f.line} contains legacy gemini-3. reference\n`);
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
    if (
      f.kind === 'DRIFT' ||
      f.kind === 'MISSING_DOC' ||
      f.kind === 'STALE_DOC' ||
      f.kind === 'INVALID_AGENT_MODEL' ||
      f.kind === 'INVALID_PIPELINE_MODEL' ||
      f.kind === 'CALLER_MODEL_MISMATCH' ||
      f.kind === 'LEGACY_GEMINI3_REF'
    ) {
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
  validateAgentModels(agents, findings);
  validatePipelineManifest(root, findings);
  validateSkillCallerModels(root, agents, findings);
  validateNoLegacyGemini3(root, findings);

  const exitCode = json ? emitJson(findings, strict) : emitHuman(findings, strict);
  process.exit(exitCode);
} catch (err) {
  process.stderr.write(`validate-cost-tiers.js error: ${err.message}\n`);
  process.exit(2);
}
