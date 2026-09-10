#!/usr/bin/env node
/**
 * @file ci/validate-guardrail-regression.js
 * @description Strengthen-only regression gate for guardrail definitions
 *   (KD6). Deliberately separate from validate-guardrails.js, which stays
 *   schema-only: this validator instead diffs a pre-image of
 *   `.sdlc/config.json` (captured before an LLM-authored self-learning edit,
 *   e.g. learn-prepare.js / Task 4) against the post-image (the edit's
 *   result), and fails closed unless the ONLY diffs anywhere in the file are
 *   brand-new entries appended to plan.guardrails, execute.guardrails, or
 *   rejected_guardrails. Every pre-existing guardrail must survive byte-for-
 *   byte (full-object deep equal, not just id/description/severity), and
 *   every non-guardrail key in the file (execute.* settings, pr.*, jira.*,
 *   version.*, learn.*, any other top-level key) must be untouched.
 *
 *   Stated v1 limitation (risk-lens iteration-4 finding, not fixed here):
 *   the strengthen-only guarantee is computed against the pre-image captured
 *   at learn-prepare.js time and is never re-checked at merge time. This
 *   closes the prepare-to-validate window but not the validate-to-human-
 *   merge window (a PR can sit open indefinitely) — two concurrent
 *   assimilation PRs built from the same stale pre-image would each pass
 *   their own regression check independently; git's own merge conflict on
 *   .sdlc/config.json is what catches that in practice, not this validator.
 *   Re-running the pipeline after a rebase is the intended remedy.
 *
 * @exit 0 pass (no regression), 1 regression found, 2 crash
 */
'use strict';

const fs = require('node:fs');
const { writeJsonLine } = require('../lib/output');

const GUARDRAIL_SECTION_KEYS = ['plan', 'execute'];

// ---------------------------------------------------------------------------
// Canonical-JSON deep equality (R12 precision fix): recursively serialize
// with all object keys sorted lexicographically at every level; arrays are
// serialized element-by-element IN ORDER (never sorted, never treated as
// sets) so a key-reordering-only rewrite of an untouched guardrail still
// fails closed instead of being silently normalized away.
// ---------------------------------------------------------------------------

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalJSON(value) {
  return JSON.stringify(canonicalize(value));
}

function deepEqual(a, b) {
  return canonicalJSON(a) === canonicalJSON(b);
}

/**
 * Find a human-readable dotted path to the first leaf where two plain
 * objects/values differ, for a more useful violation.path than just the
 * top-level key name (e.g. "learn.recurrenceThreshold" instead of "learn").
 * Falls back to the given prefix (or "(root)") when no deeper leaf can be
 * isolated (e.g. one side is an array, or a primitive mismatch).
 */
function firstDiffPath(a, b, prefix) {
  if (deepEqual(a, b)) {
    return prefix || '(root)';
  }
  if (
    a !== null && b !== null &&
    typeof a === 'object' && typeof b === 'object' &&
    !Array.isArray(a) && !Array.isArray(b)
  ) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!deepEqual(a[key], b[key])) {
        return firstDiffPath(a[key], b[key], prefix ? `${prefix}.${key}` : key);
      }
    }
  }
  return prefix || '(root)';
}

/**
 * Diff a single guardrail-list (plan.guardrails, execute.guardrails, or
 * rejected_guardrails): every pre-image id must survive in the post-image
 * with a full-object canonical-JSON-equal value (R12); ids present only in
 * the post-image are collected as `added`. Per-id lookup in the post-image
 * assumes ids are unique within the list — safe ONLY because the caller
 * (learn-apply.js --validate) has already run validateGuardrailsConfig
 * (R11) before calling this function; this function does not itself
 * re-check uniqueness (R12 ordering-guarantee fix — documented precondition).
 */
function diffGuardrailArray(preArr, postArr) {
  const pre = Array.isArray(preArr) ? preArr : [];
  const post = Array.isArray(postArr) ? postArr : [];

  const postById = new Map();
  for (const entry of post) {
    const id = entry && typeof entry === 'object' ? entry.id : undefined;
    if (typeof id === 'string' && !postById.has(id)) {
      postById.set(id, entry);
    }
  }

  const violations = [];
  const preIds = new Set();

  for (const entry of pre) {
    const id = entry && typeof entry === 'object' ? entry.id : undefined;
    if (typeof id === 'string') {
      preIds.add(id);
    }
    const postEntry = typeof id === 'string' ? postById.get(id) : undefined;
    const violationId = typeof id === 'string' ? id : JSON.stringify(entry);
    if (postEntry === undefined) {
      violations.push({ id: violationId, kind: 'removed' });
      continue;
    }
    if (!deepEqual(entry, postEntry)) {
      violations.push({ id: violationId, kind: 'modified' });
    }
  }

  const added = [];
  for (const entry of post) {
    const id = entry && typeof entry === 'object' ? entry.id : undefined;
    if (typeof id === 'string' && !preIds.has(id)) {
      added.push(id);
    }
  }

  return { violations, added };
}

/**
 * validateGuardrailRegression — the strengthen-only diff (KD6).
 *
 * @param {object|null} preConfig — the pre-image of .sdlc/config.json
 *   (Task 4's captured content), or null/{} when nothing was captured.
 * @param {object|null} postConfig — the post-image of .sdlc/config.json
 *   (the file as the candidate edit leaves it).
 * @param {{preImageStatus: 'resolved'|'absent'|'error'}} options —
 *   `preImageStatus` comes from Task 4's manifest and is REQUIRED context:
 *   - 'error'   — the pre-image capture itself failed; fails closed
 *                 regardless of postConfig content (R12 fail-closed fix).
 *   - 'absent'  — there was legitimately nothing to capture (first-ever
 *                 .sdlc/config.json); the only status that yields an empty
 *                 preConfig. Whole-file creation — nothing to diff against
 *                 at all, so every guardrail/rejected-guardrail id found in
 *                 postConfig is reported as `added` and the check passes.
 *   - 'resolved' (or any other/omitted value) — a real pre-image exists;
 *                 the full strengthen-only diff below applies.
 * @returns {{ok: true, added: string[]}
 *          |{ok: false, violations: Array<{id?: string, path?: string, kind: string}>}}
 */
function validateGuardrailRegression(preConfig, postConfig, options = {}) {
  const preImageStatus = options && options.preImageStatus;

  if (preImageStatus === 'error') {
    return {
      ok: false,
      violations: [{ path: '<pre-image>', kind: 'unresolved-pre-image' }],
    };
  }

  const post = postConfig || {};

  if (preImageStatus === 'absent') {
    // Whole-file creation: nothing to diff against at all. Every guardrail
    // (and rejected-guardrail) id present in the post-image is new.
    const added = [];
    const collect = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const entry of arr) {
        if (entry && typeof entry === 'object' && typeof entry.id === 'string') {
          added.push(entry.id);
        }
      }
    };
    for (const sectionKey of GUARDRAIL_SECTION_KEYS) {
      collect(post[sectionKey] && post[sectionKey].guardrails);
    }
    collect(post.rejected_guardrails);
    return { ok: true, added };
  }

  const pre = preConfig || {};
  const violations = [];
  const added = [];

  // plan.guardrails / execute.guardrails: non-guardrails keys in each
  // section must be untouched (this also correctly allows the section
  // container itself to be absent-in-pre/created-in-post, since an absent
  // section is treated as {} on both sides of the non-guardrails-key
  // comparison — R12 scope-widening fix); the guardrails array itself is
  // append-only per diffGuardrailArray.
  for (const sectionKey of GUARDRAIL_SECTION_KEYS) {
    const preSectionRaw = pre[sectionKey];
    const postSectionRaw = post[sectionKey];
    const preSection = (preSectionRaw && typeof preSectionRaw === 'object' && !Array.isArray(preSectionRaw)) ? preSectionRaw : {};
    const postSection = (postSectionRaw && typeof postSectionRaw === 'object' && !Array.isArray(postSectionRaw)) ? postSectionRaw : {};

    const preRest = { ...preSection };
    delete preRest.guardrails;
    const postRest = { ...postSection };
    delete postRest.guardrails;

    if (!deepEqual(preRest, postRest)) {
      violations.push({ path: firstDiffPath(preRest, postRest, sectionKey), kind: 'non-guardrail-key-changed' });
    }

    const arrDiff = diffGuardrailArray(preSection.guardrails, postSection.guardrails);
    violations.push(...arrDiff.violations);
    added.push(...arrDiff.added);
  }

  // rejected_guardrails: same append-only allowance, top-level array.
  {
    const arrDiff = diffGuardrailArray(pre.rejected_guardrails, post.rejected_guardrails);
    violations.push(...arrDiff.violations);
    added.push(...arrDiff.added);
  }

  // Every other top-level key (execute.* lives under 'execute' already
  // handled above; this covers pr.*, jira.*, version.*, learn.* — including
  // learn.recurrenceThreshold, which a synthesis edit could otherwise
  // quietly lower to widen its own future eligibility — and any brand-new
  // top-level key other than plan/execute/rejected_guardrails) must be
  // fully deep-equal between pre- and post-image.
  const allKeys = new Set([...Object.keys(pre), ...Object.keys(post)]);
  allKeys.delete('plan');
  allKeys.delete('execute');
  allKeys.delete('rejected_guardrails');
  for (const key of allKeys) {
    if (!deepEqual(pre[key], post[key])) {
      violations.push({ path: firstDiffPath(pre[key], post[key], key), kind: 'non-guardrail-key-changed' });
    }
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }
  return { ok: true, added };
}

// ---------------------------------------------------------------------------
// CLI — thin wrapper around validateGuardrailRegression().
//
// --post-file <path>  required: the post-image config JSON to validate.
// --pre-file <path>   optional: the pre-image config JSON.
//   - omitted entirely            -> preImageStatus 'absent' (no pre-image
//                                    was ever captured; whole-file creation).
//   - given but missing/unparsable-> preImageStatus 'error' (a pre-image was
//                                    expected but could not be resolved;
//                                    fails closed rather than crashing, since
//                                    this is a legitimate business outcome,
//                                    not an unexpected exception).
//   - given and readable          -> preImageStatus 'resolved', parsed as
//                                    the pre-image content.
// --json               emit the structured {ok, added|violations} result.
//
// The programmatic entry point (used in-process by learn-apply.js --validate,
// Task 6) instead receives preImageStatus explicitly from its own manifest
// read (Task 4's output) — this inference is CLI-only.
// ---------------------------------------------------------------------------

function parseArgs(args) {
  const result = { preFile: null, postFile: null, json: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pre-file' && i + 1 < args.length) {
      result.preFile = args[i + 1];
      i++;
    } else if (args[i] === '--post-file' && i + 1 < args.length) {
      result.postFile = args[i + 1];
      i++;
    } else if (args[i] === '--json') {
      result.json = true;
    }
  }
  return result;
}

function readJSONFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function resolvePreImage(preFile) {
  if (!preFile) {
    return { preImageStatus: 'absent', preConfig: {} };
  }
  try {
    const preConfig = readJSONFile(preFile);
    return { preImageStatus: 'resolved', preConfig };
  } catch {
    // Missing file or invalid JSON: a pre-image was expected (a --pre-file
    // was passed) but could not be resolved. Fail closed rather than crash.
    return { preImageStatus: 'error', preConfig: null };
  }
}

function main() {
  const args = process.argv.slice(2);
  const flags = parseArgs(args);

  if (!flags.postFile) {
    process.stderr.write('--post-file <path> is required\n');
    process.exit(1);
  }

  let postConfig;
  try {
    postConfig = readJSONFile(flags.postFile);
  } catch (err) {
    process.stderr.write(`Cannot read --post-file ${flags.postFile}: ${err.message}\n`);
    process.exit(1);
  }

  try {
    const { preImageStatus, preConfig } = resolvePreImage(flags.preFile);
    const result = validateGuardrailRegression(preConfig, postConfig, { preImageStatus });

    if (flags.json) {
      writeJsonLine(result, { indent: 2, exit: false });
    } else if (result.ok) {
      if (result.added.length > 0) {
        process.stdout.write(`Guardrail regression check passed. Added: ${result.added.join(', ')}\n`);
      } else {
        process.stdout.write('Guardrail regression check passed. No changes.\n');
      }
    } else {
      process.stdout.write('Guardrail regression check FAILED:\n');
      for (const violation of result.violations) {
        const subject = violation.id !== undefined ? `id=${violation.id}` : `path=${violation.path}`;
        process.stdout.write(`  ${violation.kind}: ${subject}\n`);
      }
    }

    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    process.stderr.write('CRASH: ' + err.message + '\n');
    process.exit(2);
  }
}

module.exports = { validateGuardrailRegression };

if (require.main === module) {
  main();
}
