/**
 * learnings.js
 * Pure functions for parsing, validating, grouping, and filtering pending
 * learnings changeset files. Zero external dependencies — Node.js built-ins
 * only, and no filesystem or process access (see R for that constraint).
 *
 * Reuses lib/yaml.js's extractFrontmatter/parseSimpleYaml rather than adding
 * a parser (mirrors lib/dimensions.js, the repo's precedent for a pure
 * validate-plus-constants lib consumed by both a CI validator and a prepare
 * script).
 *
 * KD8 — constants stay local to this module rather than shared, matching
 * harden-prepare.js and error-report-prepare.js.
 *
 * Exports: parsePendingFile, filterRejected, groupBySignature,
 *          selectEligible, REQUIRED_FRONTMATTER_FIELDS, SIGNATURE_PATTERN
 */

'use strict';

const { extractFrontmatter, parseSimpleYaml } = require('./yaml.js');

// ---------------------------------------------------------------------------
// Constants (KD8 — local to this module)
// ---------------------------------------------------------------------------

const REQUIRED_FRONTMATTER_FIELDS = ['signature', 'rationale', 'evidence'];

// Same kebab-case pattern validate-guardrails.js already enforces for
// guardrail IDs.
const SIGNATURE_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const MAX_TEXT_LENGTH = 2000; // hygiene bound for rationale/evidence
const MAX_IMPACT_LENGTH = 80;

const DEFAULT_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// parsePendingFile
// ---------------------------------------------------------------------------

/**
 * Parse and validate a single pending learnings changeset file's content.
 * Never throws — invalid input is reported as { valid: false, reason }.
 *
 * @param {string} content
 * @param {string} filePath
 * @returns {{valid:true, signature:string, rationale:string, evidence:string, impact:string|null, filePath:string}
 *          |{valid:false, filePath:string, reason:string}}
 */
function parsePendingFile(content, filePath) {
  const rawFm = extractFrontmatter(content);
  if (!rawFm) {
    return { valid: false, filePath, reason: 'Missing YAML frontmatter block (--- delimiters)' };
  }

  const fm = parseSimpleYaml(rawFm);

  const missing = REQUIRED_FRONTMATTER_FIELDS.filter((field) => !isNonEmptyString(fm[field]));
  if (missing.length > 0) {
    return { valid: false, filePath, reason: `Missing required field(s): ${missing.join(', ')}` };
  }

  const signature = fm.signature;
  if (!SIGNATURE_PATTERN.test(signature)) {
    return {
      valid: false,
      filePath,
      reason: `Field "signature" must match kebab-case pattern /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/ (got: "${signature}")`,
    };
  }

  const rationale = fm.rationale;
  if (rationale.length > MAX_TEXT_LENGTH) {
    return {
      valid: false,
      filePath,
      reason: `Field "rationale" exceeds ${MAX_TEXT_LENGTH} characters (got: ${rationale.length})`,
    };
  }

  const evidence = fm.evidence;
  if (evidence.length > MAX_TEXT_LENGTH) {
    return {
      valid: false,
      filePath,
      reason: `Field "evidence" exceeds ${MAX_TEXT_LENGTH} characters (got: ${evidence.length})`,
    };
  }

  let impact = null;
  if (fm.impact !== undefined) {
    if (typeof fm.impact !== 'string') {
      return { valid: false, filePath, reason: 'Field "impact" must be a string' };
    }
    if (fm.impact.includes('\n')) {
      return { valid: false, filePath, reason: 'Field "impact" must be a single line (no newlines)' };
    }
    if (fm.impact.includes('`')) {
      return { valid: false, filePath, reason: 'Field "impact" must not contain a backtick character' };
    }
    if (fm.impact.length > MAX_IMPACT_LENGTH) {
      return {
        valid: false,
        filePath,
        reason: `Field "impact" exceeds ${MAX_IMPACT_LENGTH} characters (got: ${fm.impact.length})`,
      };
    }
    impact = fm.impact;
  }

  return { valid: true, signature, rationale, evidence, impact, filePath };
}

// ---------------------------------------------------------------------------
// filterRejected
// ---------------------------------------------------------------------------

/**
 * Remove entries whose signature is in the rejected list (exact string match).
 *
 * @param {Array<object>} parsed
 * @param {string[]} rejectedSignatures
 * @returns {Array<object>}
 */
function filterRejected(parsed, rejectedSignatures) {
  const rejectedSet = new Set(rejectedSignatures);
  return parsed.filter((item) => !rejectedSet.has(item.signature));
}

// ---------------------------------------------------------------------------
// groupBySignature
// ---------------------------------------------------------------------------

/**
 * Group parsed entries by signature.
 *
 * @param {Array<object>} parsed
 * @returns {Map<string, Array<object>>}
 */
function groupBySignature(parsed) {
  const groups = new Map();
  for (const item of parsed) {
    const key = item.signature;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// selectEligible
// ---------------------------------------------------------------------------

/**
 * Split signature groups into those meeting the eligibility threshold and
 * those still waiting for more corroborating files.
 *
 * Impact reduction rule (R16): each eligible group carries a single impact
 * value, taken as the first file's impact (in array order) that is
 * non-null; null (renders as "unscored") if none of the group's files set
 * one.
 *
 * @param {Map<string, Array<object>>} groups
 * @param {number} [threshold=3]
 * @returns {{eligible: Array<{signature:string, files:string[], impact:string|null}>, waiting: Array<{signature:string, count:number}>}}
 */
function selectEligible(groups, threshold = DEFAULT_THRESHOLD) {
  const eligible = [];
  const waiting = [];

  for (const [signature, items] of groups) {
    if (items.length >= threshold) {
      let impact = null;
      for (const item of items) {
        if (item.impact != null) {
          impact = item.impact;
          break;
        }
      }
      eligible.push({
        signature,
        files: items.map((item) => item.filePath),
        impact,
      });
    } else {
      waiting.push({ signature, count: items.length });
    }
  }

  return { eligible, waiting };
}

module.exports = {
  parsePendingFile,
  filterRejected,
  groupBySignature,
  selectEligible,
  REQUIRED_FRONTMATTER_FIELDS,
  SIGNATURE_PATTERN,
};
