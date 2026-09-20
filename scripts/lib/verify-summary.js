'use strict';

/**
 * verify-summary.js
 * Parser for the VERIFY_SUMMARY token produced by a received-review verifier
 * subagent.
 *
 * Detects CONTEXT_OVERFLOW by comparing returned finding IDs against the
 * manifest-known dispatched ID set (mirrors wave-summary.js's
 * parseWaveSummary / CONTEXT_OVERFLOW handling).
 *
 * Finding IDs are GitHub GraphQL thread node IDs (opaque strings), so — unlike
 * wave-summary.js's task IDs — they are compared verbatim with no
 * normalization: normalizeTaskId's "strip a leading T/t" behaviour would
 * corrupt these comparisons.
 *
 * No I/O. Zero npm dependencies.
 */

const { extractFinalLineToken } = require('./token-line');

// Bounded per-finding verificationStatus enum
const VALID_VERIFICATION_STATUSES = new Set([
  'confirmed',
  'confirmed-incomplete',
  'incorrect',
  'partially-correct',
  'cannot-verify',
]);

// Bounded top-level summary status enum
const VALID_SUMMARY_STATUSES = new Set([
  'completed',
  'partial',
  'failed',
]);

const MAX_EVIDENCE = 5;
const MAX_RIPPLE = 3;
const MAX_REASONING_CHARS = 240;

/**
 * Validate a single per-finding entry against the bounded schema.
 * Returns an array of violation strings (empty = valid).
 *
 * @param {object} finding
 * @returns {string[]}
 */
function validateFindingEntry(finding) {
  const violations = [];

  if (typeof finding !== 'object' || finding === null) {
    violations.push('finding is not an object');
    return violations;
  }

  if (typeof finding.id !== 'string' || finding.id.length === 0) {
    violations.push('finding missing required string field: id');
  }

  if (!VALID_VERIFICATION_STATUSES.has(finding.verificationStatus)) {
    violations.push(`finding.verificationStatus "${finding.verificationStatus}" not in bounded enum`);
  }

  if (!Array.isArray(finding.evidence)) {
    violations.push('finding.evidence must be an array');
  } else if (finding.evidence.length > MAX_EVIDENCE) {
    violations.push(`finding.evidence exceeds max of ${MAX_EVIDENCE} entries`);
  }

  if (!Array.isArray(finding.rippleEffects)) {
    violations.push('finding.rippleEffects must be an array');
  } else if (finding.rippleEffects.length > MAX_RIPPLE) {
    violations.push(`finding.rippleEffects exceeds max of ${MAX_RIPPLE} entries`);
  }

  if (typeof finding.reasoning !== 'string') {
    violations.push('finding.reasoning must be a string');
  } else if (finding.reasoning.length > MAX_REASONING_CHARS) {
    violations.push(`finding.reasoning exceeds max of ${MAX_REASONING_CHARS} chars`);
  }

  return violations;
}

/**
 * Extract and parse the VERIFY_SUMMARY token from a verifier subagent's
 * output.
 *
 * The token MUST appear as the final line of the output in the form:
 *   VERIFY_SUMMARY: <single-line-json>
 *
 * @param {string} text          - full verifier subagent response text
 * @param {string[]} [dispatched] - finding (thread) IDs that were dispatched
 *                                  to this verifier (for overflow detection)
 *
 * @returns {{
 *   schemaOk: boolean,
 *   dispatched: string[],
 *   returned: string[],
 *   missingIds: string[],
 *   extraIds: string[],
 *   parsed: object|null,
 *   violations: string[],
 *   tokenFound: boolean,
 * }}
 */
function parseVerifySummary(text, dispatched = []) {
  const result = {
    schemaOk: false,
    dispatched: [...dispatched],
    returned: [],
    missingIds: [],
    extraIds: [],
    parsed: null,
    violations: [],
    tokenFound: false,
  };

  if (typeof text !== 'string') {
    result.violations.push('input text is not a string');
    result.missingIds = [...dispatched];
    return result;
  }

  // Find VERIFY_SUMMARY token — must be on the final non-empty line
  const token = extractFinalLineToken(text, 'VERIFY_SUMMARY:');
  if (!token.found) {
    result.violations.push('VERIFY_SUMMARY token not found as final non-blank line of output');
    result.missingIds = [...dispatched];
    return result;
  }

  result.tokenFound = true;

  // Extract JSON payload
  const jsonStr = token.payload;

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    result.violations.push(`VERIFY_SUMMARY JSON parse error: ${err.message}`);
    result.missingIds = [...dispatched];
    return result;
  }

  result.parsed = parsed;

  // Validate top-level schema
  if (!VALID_SUMMARY_STATUSES.has(parsed.status)) {
    result.violations.push(`parsed.status "${parsed.status}" not in bounded enum (completed|partial|failed)`);
  }

  if (typeof parsed.reportFile !== 'string') {
    result.violations.push('parsed.reportFile must be a string');
  }

  if (!Array.isArray(parsed.findings)) {
    result.violations.push('parsed.findings must be an array');
    result.missingIds = [...dispatched];
    return result;
  }

  // Validate per-finding entries
  for (const finding of parsed.findings) {
    const findingViolations = validateFindingEntry(finding);
    result.violations.push(...findingViolations);
  }

  // Extract returned IDs
  result.returned = parsed.findings
    .filter(f => typeof f === 'object' && f !== null && typeof f.id === 'string' && f.id.length > 0)
    .map(f => f.id);

  // Compute missing and extra IDs relative to dispatched set.
  // Thread IDs are opaque GitHub GraphQL node IDs: compared verbatim, no
  // normalization (see file-header note).
  if (dispatched.length > 0) {
    const dispatchedSet = new Set(dispatched);
    const returnedSet = new Set(result.returned);

    result.missingIds = dispatched.filter(id => !returnedSet.has(id));
    result.extraIds = result.returned.filter(id => !dispatchedSet.has(id));

    // Missing IDs indicate CONTEXT_OVERFLOW — always a schema violation
    if (result.missingIds.length > 0) {
      result.violations.push(
        `CONTEXT_OVERFLOW: ${result.missingIds.length} dispatched finding(s) absent from VERIFY_SUMMARY: ${result.missingIds.join(', ')}`
      );
    }

    if (result.extraIds.length > 0) {
      result.violations.push(
        `extra finding IDs in VERIFY_SUMMARY not in dispatched set: ${result.extraIds.join(', ')}`
      );
    }
  }

  result.schemaOk = result.violations.length === 0;

  return result;
}

module.exports = {
  parseVerifySummary,
  VALID_VERIFICATION_STATUSES,
  VALID_SUMMARY_STATUSES,
  MAX_EVIDENCE,
  MAX_RIPPLE,
  MAX_REASONING_CHARS,
};
