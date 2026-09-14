'use strict';

/**
 * wave-summary.js
 * Parser for the WAVE_SUMMARY token produced by the wave-runner Agent.
 *
 * Detects CONTEXT_OVERFLOW by comparing returned task IDs against the
 * manifest-known dispatched ID set (R-CONTEXT_OVERFLOW, R-BOUNDED-RETURN, #432).
 *
 * No I/O. Zero npm dependencies.
 */

const { extractFinalLineToken } = require('./token-line');

/**
 * Normalize a task ID to its canonical numeric form (R-IDNORM).
 * Strips a single leading 'T' or 't' and trims whitespace.
 * "T1" → "1", "t2" → "2", "3" → "3".
 * Comparison-only: persisted IDs retain their wire form.
 *
 * @param {string} id
 * @returns {string}
 */
function normalizeTaskId(id) {
  if (typeof id !== 'string') return id;
  return id.trim().replace(/^[Tt](?=\d)/, '');
}

// Bounded errorCode enum (R-BOUNDED-RETURN, #432)
const VALID_ERROR_CODES = new Set([
  'OVERFLOW',
  'TIMEOUT',
  'FAILED_TESTS',
  'FAILED_BUILD',
  'BLOCKED',
  'NEEDS_CONTEXT',
]);

const VALID_STATUSES = new Set([
  'DONE',
  'DONE_WITH_CONCERNS',
  'NEEDS_CONTEXT',
  'BLOCKED',
  'FAILED',
]);

const VALID_WAVE_STATUSES = new Set([
  'completed',
  'failed',
  'partial',
]);

/**
 * Validate a single per-task entry against the bounded schema.
 * Returns an array of violation strings (empty = valid).
 *
 * @param {object} task
 * @returns {string[]}
 */
function validateTaskEntry(task) {
  const violations = [];

  if (typeof task !== 'object' || task === null) {
    violations.push('task is not an object');
    return violations;
  }

  if (typeof task.id !== 'string' || task.id.length === 0) {
    violations.push('task missing required string field: id');
  }

  if (!VALID_STATUSES.has(task.status)) {
    violations.push(`task.status "${task.status}" not in bounded enum`);
  }

  if (!Array.isArray(task.filesTouched)) {
    violations.push('task missing required array field: filesTouched');
  }

  // errorCode is optional but MUST be within the bounded enum if present
  if (task.errorCode !== undefined && task.errorCode !== null) {
    if (!VALID_ERROR_CODES.has(task.errorCode)) {
      violations.push(`task.errorCode "${task.errorCode}" not in bounded enum (free-text error strings are forbidden)`);
    }
  }

  // sha is optional; no type constraint beyond null/string
  if (task.sha !== undefined && task.sha !== null && typeof task.sha !== 'string') {
    violations.push('task.sha must be null or a string');
  }

  // Disallow fields that were dropped from the bounded schema
  const droppedFields = ['name', 'complexity', 'risk', 'finalModel', 'attempts', 'filesChanged', 'error', 'verification'];
  for (const f of droppedFields) {
    if (task[f] !== undefined) {
      violations.push(`task contains dropped field "${f}" (bounded schema R-BOUNDED-RETURN)`);
    }
  }

  return violations;
}

/**
 * Extract and parse the WAVE_SUMMARY token from wave-runner output.
 *
 * The token MUST appear as the final line of the output in the form:
 *   WAVE_SUMMARY: <single-line-json>
 *
 * @param {string} text          - full wave-runner Agent response text
 * @param {string[]} [dispatched] - task IDs that were dispatched (for overflow detection)
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
function parseWaveSummary(text, dispatched = []) {
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

  // Find WAVE_SUMMARY token — must be on the final non-empty line
  const token = extractFinalLineToken(text, 'WAVE_SUMMARY:');
  if (!token.found) {
    result.violations.push('WAVE_SUMMARY token not found as final non-blank line of output');
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
    result.violations.push(`WAVE_SUMMARY JSON parse error: ${err.message}`);
    result.missingIds = [...dispatched];
    return result;
  }

  result.parsed = parsed;

  // Validate top-level schema
  if (typeof parsed.wave !== 'number') {
    result.violations.push('parsed.wave must be a number');
  }

  if (!VALID_WAVE_STATUSES.has(parsed.status)) {
    result.violations.push(`parsed.status "${parsed.status}" not in bounded enum (completed|failed|partial)`);
  }

  if (!Array.isArray(parsed.tasks)) {
    result.violations.push('parsed.tasks must be an array');
    result.missingIds = [...dispatched];
    return result;
  }

  if (typeof parsed.escalationsUsed !== 'number') {
    result.violations.push('parsed.escalationsUsed must be a number');
  }

  // Validate per-task entries
  for (const task of parsed.tasks) {
    const taskViolations = validateTaskEntry(task);
    result.violations.push(...taskViolations);
  }

  // Extract returned IDs
  result.returned = parsed.tasks
    .filter(t => typeof t === 'object' && t !== null && typeof t.id === 'string' && t.id.length > 0)
    .map(t => t.id);

  // Compute missing and extra IDs relative to dispatched set.
  // Normalize both sides (R-IDNORM): strip leading T/t so "T1" == "1".
  if (dispatched.length > 0) {
    const dispatchedSet = new Set(dispatched.map(normalizeTaskId));
    const returnedSet = new Set(result.returned.map(normalizeTaskId));

    result.missingIds = dispatched.filter(id => !returnedSet.has(normalizeTaskId(id)));
    result.extraIds = result.returned.filter(id => !dispatchedSet.has(normalizeTaskId(id)));

    // Missing IDs indicate CONTEXT_OVERFLOW — always a schema violation
    if (result.missingIds.length > 0) {
      result.violations.push(
        `CONTEXT_OVERFLOW: ${result.missingIds.length} dispatched task(s) absent from WAVE_SUMMARY: ${result.missingIds.join(', ')}`
      );
    }

    if (result.extraIds.length > 0) {
      result.violations.push(
        `extra task IDs in WAVE_SUMMARY not in dispatched set: ${result.extraIds.join(', ')}`
      );
    }
  }

  result.schemaOk = result.violations.length === 0;

  return result;
}

module.exports = { parseWaveSummary, normalizeTaskId, extractFinalLineToken, VALID_ERROR_CODES, VALID_STATUSES, VALID_WAVE_STATUSES };
