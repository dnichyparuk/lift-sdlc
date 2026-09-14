#!/usr/bin/env node
/**
 * learn-stale.js — D9 staleness report on a proxy signal.
 *
 * No "guardrail was triggered" telemetry exists in this repo (self-learning
 * ADR §6 open question), so this implements D9 against a deliberately weak
 * proxy: a guardrail's age (days since it was introduced into
 * `.sdlc/config.json`, per `git log`) combined with whether its id ever
 * appears in `.sdlc/learnings/log.md`. Flag-only output is what makes a
 * weak signal safe — it informs a human, it never acts:
 *
 *   - never edits config.json
 *   - never deletes or downgrades a guardrail
 *   - only ever reads (git log, fs reads) — nothing to stage or commit
 *
 * KD9: this script's internal spawnSync git calls are invisible to
 * pre-tool-git-guard.js, but this script only ever READS, so there is
 * nothing to guard.
 *
 * Usage:
 *   node learn-stale.js
 *
 * Output: one JSON line on stdout —
 *   { off: false, flagged: [{ id, ageDays, mentionedInLog: false }], checked: 12 }
 *   { off: true, flagged: [], checked: 0 }   — when learn.staleAfterCycles is null
 *
 * Exit codes: 0 = success (advisory-only; findings never fail the run),
 *             2 = unexpected script crash.
 *
 * Uses only Node.js built-in modules. No npm install required.
 */
'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');
const { readSection, resolveSdlcRoot } = require(path.join(LIB, 'config'));
const { writeJsonLine } = require(path.join(LIB, 'output'));

const CONFIG_REL_PATH = path.join('.sdlc', 'config.json');
const LOG_REL_PATH    = path.join('.sdlc', 'learnings', 'log.md');
const MS_PER_DAY       = 24 * 60 * 60 * 1000;

// Sections whose `.guardrails` arrays make up the active guardrail set
// (mirrors scripts/skill/guardrails.js's `readExisting` and
// scripts/ci/validate-guardrails.js's `--section plan|execute`).
const GUARDRAIL_SECTIONS = ['plan', 'execute'];

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * No flags accepted — kept for parity with the project's parseArgs+main
 * convention (scripts/util/execute-context-advisory.js).
 * @param {string[]} argv
 * @returns {{}}
 */
function parseArgs(argv) {
  return {};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command and normalize its result. Mirrors
 * ship-git-ops.js's `run` result normalization.
 */
function run(spawnFn, cmdArgs, cwd) {
  const result = spawnFn('git', cmdArgs, { cwd, encoding: 'utf8' });
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

/**
 * Collect the active guardrail id set from `.sdlc/config.json`'s `plan` and
 * `execute` sections (each `{ guardrails: [{id, ...}] }`), deduped by id.
 * A guardrail entry may also be a bare string (its id) — tolerated
 * defensively since not every consumer in this repo normalizes the shape.
 *
 * @param {string} cwd
 * @param {{ readSectionFn?: Function }} [deps]
 * @returns {string[]}
 */
function collectGuardrailIds(cwd, { readSectionFn = readSection } = {}) {
  const ids = new Set();
  for (const section of GUARDRAIL_SECTIONS) {
    const value = readSectionFn(cwd, section);
    const guardrails = (value && Array.isArray(value.guardrails)) ? value.guardrails : [];
    for (const g of guardrails) {
      const id = typeof g === 'string' ? g : (g && g.id);
      if (id) ids.add(id);
    }
  }
  return Array.from(ids);
}

/**
 * Proxy age (in days) for a guardrail id: the oldest commit touching
 * `.sdlc/config.json` whose diff changed the number of occurrences of the
 * id string (`git log -S<id>`, i.e. the pickaxe search) is treated as the
 * introduction commit; age is `now - that commit's date`.
 *
 * A weak/absent git signal (no repo, no matching commit, unparseable date)
 * resolves to age 0 — "unknown age never gets flagged" is the safe failure
 * mode for a proxy signal that only ever informs, never acts.
 *
 * @param {Function} spawnFn
 * @param {string} cwd
 * @param {string} id
 * @returns {number}
 */
function guardrailAgeDays(spawnFn, cwd, id) {
  const result = run(
    spawnFn,
    ['log', '--follow', '--reverse', `-S${id}`, '--format=%cI', '--', CONFIG_REL_PATH],
    cwd
  );
  if (result.status !== 0 || !result.stdout) return 0;

  const introDateRaw = result.stdout.split('\n')[0].trim();
  const introDate = new Date(introDateRaw);
  if (Number.isNaN(introDate.getTime())) return 0;

  const diffMs = Date.now() - introDate.getTime();
  return Math.max(0, Math.floor(diffMs / MS_PER_DAY));
}

/**
 * Read `.sdlc/learnings/log.md` for the "mentioned in log" half of the
 * gate. Missing file (common — see the ADR caveat below) reads as empty,
 * never an error.
 *
 * @param {string} cwd
 * @returns {string}
 */
function readLearningsLog(cwd) {
  try {
    return fs.readFileSync(path.join(cwd, LOG_REL_PATH), 'utf8');
  } catch (_) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Core (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * Report guardrails that look stale on the D9 proxy signal: age from
 * `.sdlc/config.json` git history AND no mention of the guardrail's id
 * anywhere in `.sdlc/learnings/log.md`. Advisory only — never writes,
 * deletes, or downgrades anything.
 *
 * Note (requirements-lens caveat): `.sdlc/learnings/log.md` is written by
 * `mcp-failure.js` and the ship "learnings-commit" step, neither of which
 * ever writes a guardrail id or signature — so `mentionedInLog` is
 * expected to be `false` for essentially every guardrail today, and this
 * report reads closer to a pure age check in practice until something else
 * starts writing guardrail-relevant entries to that log.
 *
 * @param {object} [opts]
 * @param {Function} [opts.spawnFn=spawnSync]  Injectable for tests — no real git history required.
 * @param {string} [opts.cwd=process.cwd()]
 * @param {number|null} opts.staleAfterCycles  `null` = feature off.
 * @returns {{off: true, flagged: [], checked: 0} | {off: false, flagged: Array<{id: string, ageDays: number, mentionedInLog: boolean}>, checked: number}}
 */
function findStaleGuardrails({ spawnFn = spawnSync, cwd = process.cwd(), staleAfterCycles } = {}) {
  if (staleAfterCycles == null) {
    return { off: true, flagged: [], checked: 0 };
  }

  const ids = collectGuardrailIds(cwd);
  const log = readLearningsLog(cwd);

  const flagged = [];
  for (const id of ids) {
    const ageDays = guardrailAgeDays(spawnFn, cwd, id);
    const mentionedInLog = log.includes(id);
    if (ageDays > staleAfterCycles && !mentionedInLog) {
      flagged.push({ id, ageDays, mentionedInLog: false });
    }
  }

  return { off: false, flagged, checked: ids.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  parseArgs(argv);
  const root = resolveSdlcRoot();
  const learn = readSection(root, 'learn');
  const staleAfterCycles = learn ? learn.staleAfterCycles : null;
  const result = findStaleGuardrails({ cwd: root, staleAfterCycles });
  writeJsonLine(result);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`learn-stale: unexpected error: ${err.message}\n`);
    process.exit(2);
  }
}

module.exports = {
  parseArgs,
  collectGuardrailIds,
  guardrailAgeDays,
  readLearningsLog,
  findStaleGuardrails,
};
