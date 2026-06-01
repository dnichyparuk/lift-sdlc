'use strict';

/**
 * dispatch-budget.js
 * Pure utility for computing the max concurrent tasks per wave dispatch.
 *
 * Replaces the static wave-size cap table with a byte-budget computation
 * that accounts for template scaffolding, guardrails, per-task fact-sheet
 * sizes, and prior-wave context (R-BYTE-BUDGET, #432).
 *
 * No I/O. Zero npm dependencies.
 */

// ---------------------------------------------------------------------------
// Model context limits (conservative byte ceiling = token limit × 4 bytes/token)
// Using 75% of budget for inputs; 25% reserved for sub-agent reasoning + output.
// Claude 4 family: all models have 200K token input limit.
// ---------------------------------------------------------------------------
const MODEL_MAX_INPUT_BYTES = {
  'gemini-3.5-flash': Math.floor(1_000_000 * 4 * 0.75),
  'gemini-3.1-pro': Math.floor(2_000_000 * 4 * 0.75),
};

// Static wave-size cap table (tasks 4-8 → 4, 9-15 → 5, 16+ → 6).
// Complex tasks count as 2. computeWaveBudget MUST return ≤ this cap.
const STATIC_CAP_TABLE = [
  { minTasks: 1,  maxTasks: 3,  cap: Infinity },
  { minTasks: 4,  maxTasks: 8,  cap: 4 },
  { minTasks: 9,  maxTasks: 15, cap: 5 },
  { minTasks: 16, maxTasks: Infinity, cap: 6 },
];

/**
 * Look up the static cap for a given total remaining task count.
 * @param {number} totalRemainingTasks
 * @returns {number} cap (Infinity when no cap applies)
 */
function staticCap(totalRemainingTasks) {
  for (const row of STATIC_CAP_TABLE) {
    if (totalRemainingTasks >= row.minTasks && totalRemainingTasks <= row.maxTasks) {
      return row.cap;
    }
  }
  // Note: the Infinity row above covers counts 1-3, and the final explicit row covers 16+.
  // This fallback is unreachable given the current STATIC_CAP_TABLE (the last row uses
  // maxTasks: Infinity, so every count ≥ 16 matches). Kept as a defensive guard in case
  // the table is edited to use a finite upper bound in the future.
  return 6; // unreachable with current table; defensive fallback
}

/**
 * Compute the byte-budget-aware max concurrent tasks for a wave.
 *
 * @param {object} opts
 * @param {number}   opts.templateBytes            - bytes for prompt template scaffolding
 * @param {number}   opts.guardrailsBytes           - bytes for rendered guardrails block
 * @param {number[]} opts.perTaskFactSheetBytes      - array of fact-sheet sizes, one per candidate task
 * @param {number}   opts.priorWaveContextBytes      - bytes for prior-wave context summary
 * @param {string}   opts.model                     - "haiku" | "sonnet" | "opus"
 * @param {number}   [opts.modelMaxInputBytes]       - override model limit (for testing)
 * @param {number}   [opts.totalRemainingTasks]      - used for static-cap lookup (default: perTaskFactSheetBytes.length)
 *
 * @returns {{ maxConcurrentTasks: number, perTaskCeiling: number, totalReservedBytes: number }}
 */
function computeWaveBudget({
  templateBytes = 0,
  guardrailsBytes = 0,
  perTaskFactSheetBytes = [],
  priorWaveContextBytes = 0,
  model = 'gemini-3.5-flash',
  modelMaxInputBytes: modelMaxInputBytesOverride,
  totalRemainingTasks,
}) {
  const maxInputBytes = modelMaxInputBytesOverride != null
    ? modelMaxInputBytesOverride
    : (MODEL_MAX_INPUT_BYTES[model] || MODEL_MAX_INPUT_BYTES['gemini-3.5-flash']);

  const numCandidates = perTaskFactSheetBytes.length;
  const totalRemaining = totalRemainingTasks != null ? totalRemainingTasks : numCandidates;

  // Static cap for this task count
  const cap = staticCap(totalRemaining);
  const effectiveCap = cap === Infinity ? numCandidates : cap;

  // Fixed bytes consumed regardless of task count
  const fixedBytes = templateBytes + guardrailsBytes + priorWaveContextBytes;

  // Available bytes for task fact-sheets
  const availableForTasks = maxInputBytes - fixedBytes;

  if (availableForTasks <= 0) {
    // No budget at all — can run at most 1 task (minimum viable)
    return { maxConcurrentTasks: 1, perTaskCeiling: 0, totalReservedBytes: fixedBytes };
  }

  // Sort fact-sheet sizes ascending to pack as many tasks as possible
  const sortedSizes = [...perTaskFactSheetBytes].sort((a, b) => a - b);

  let maxConcurrent = 0;
  let usedBytes = 0;

  for (let i = 0; i < sortedSizes.length && maxConcurrent < effectiveCap; i++) {
    if (usedBytes + sortedSizes[i] <= availableForTasks) {
      usedBytes += sortedSizes[i];
      maxConcurrent++;
    } else {
      break;
    }
  }

  // Guarantee at least 1 if there are any candidates
  if (maxConcurrent === 0 && numCandidates > 0) {
    maxConcurrent = 1;
  }

  // perTaskCeiling: average bytes available per task slot
  const perTaskCeiling = maxConcurrent > 0 ? Math.floor(availableForTasks / maxConcurrent) : 0;

  return {
    maxConcurrentTasks: maxConcurrent,
    perTaskCeiling,
    totalReservedBytes: fixedBytes + usedBytes,
  };
}

module.exports = { computeWaveBudget, staticCap, MODEL_MAX_INPUT_BYTES };
