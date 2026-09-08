'use strict';

/**
 * wave-split.js
 * Pure utility for splitting a CONTEXT_OVERFLOW wave into sub-waves.
 *
 * When the wave-runner's WAVE_SUMMARY is missing dispatched task IDs
 * (CONTEXT_OVERFLOW), main context calls splitWave() to partition
 * the ORIGINAL dispatched set (not just the missing IDs) into two
 * roughly-equal halves, each of which is re-dispatched independently.
 *
 * Splitting the FULL dispatched set — not just the missing IDs — is critical:
 * splitting only missing risks re-overflow if dependencies were needed in-wave.
 *
 * The splitter is deterministic: same {dispatched, splitDepth} → same partition,
 * enabling resume-after-crash to produce the identical split tree.
 *
 * No I/O. Zero npm dependencies.
 *
 * Implements R-CONTEXT_OVERFLOW, T8, #432.
 */

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

class MaxSplitDepthExceededError extends Error {
  constructor(depth, maxSplitDepth) {
    super(
      `MaxSplitDepthExceededError: splitDepth ${depth} exceeds maxSplitDepth ${maxSplitDepth}. ` +
      `Manual escalation required — call ask_question with the set of unresolved task IDs.`
    );
    this.name = 'MaxSplitDepthExceededError';
    this.depth = depth;
    this.maxSplitDepth = maxSplitDepth;
  }
}

// ---------------------------------------------------------------------------
// Core split logic
// ---------------------------------------------------------------------------

/**
 * Split a dispatched task ID set into two halves for CONTEXT_OVERFLOW recovery.
 *
 * @param {object} opts
 * @param {string[]} opts.dispatched      - ALL task IDs that were dispatched in the overflowing wave
 * @param {string[]} [opts.missingIds]    - IDs absent from WAVE_SUMMARY (diagnostic only; not used for split boundary)
 * @param {number}   [opts.splitDepth=0]  - current recursion depth (0 = first split)
 * @param {number}   [opts.maxSplitDepth=3] - ceiling; throws MaxSplitDepthExceededError when depth exceeds this
 *
 * @returns {{ halves: Array<{ tasks: string[], depth: number }>, dispatched: string[], missingIds: string[] }}
 *   - halves: exactly 2 sub-wave descriptors (tasks[] may be empty if dispatched.length <= 1)
 *   - dispatched: original dispatched set (passthrough for caller convenience)
 *   - missingIds: original missingIds (passthrough)
 *
 * @throws {MaxSplitDepthExceededError} when splitDepth + 1 would exceed maxSplitDepth
 */
function splitWave({ dispatched = [], missingIds = [], splitDepth = 0, maxSplitDepth = 3 }) {
  // Validate inputs
  if (!Array.isArray(dispatched)) {
    throw new TypeError('dispatched must be an array of task ID strings');
  }
  if (!Array.isArray(missingIds)) {
    throw new TypeError('missingIds must be an array of task ID strings');
  }

  // Depth ceiling: throw before attempting a split that would exceed the limit
  if (splitDepth >= maxSplitDepth) {
    throw new MaxSplitDepthExceededError(splitDepth, maxSplitDepth);
  }

  const nextDepth = splitDepth + 1;

  // Edge case: empty or single-element set — return both halves, one possibly empty
  if (dispatched.length === 0) {
    return {
      halves: [
        { tasks: [], depth: nextDepth },
        { tasks: [], depth: nextDepth },
      ],
      dispatched: [],
      missingIds: [...missingIds],
    };
  }

  if (dispatched.length === 1) {
    // Cannot split a single task — put it in first half, second half is empty
    return {
      halves: [
        { tasks: [dispatched[0]], depth: nextDepth },
        { tasks: [],              depth: nextDepth },
      ],
      dispatched: [dispatched[0]],
      missingIds: [...missingIds],
    };
  }

  // Deterministic split: sort lexicographically then divide at midpoint.
  // Sorting ensures same inputs always produce same partition (idempotency).
  const sorted = [...dispatched].sort();
  const mid = Math.ceil(sorted.length / 2);
  const firstHalf  = sorted.slice(0, mid);
  const secondHalf = sorted.slice(mid);

  return {
    halves: [
      { tasks: firstHalf,  depth: nextDepth },
      { tasks: secondHalf, depth: nextDepth },
    ],
    dispatched: [...dispatched],
    missingIds: [...missingIds],
  };
}

/**
 * Recursively split a wave set until each sub-wave fits, or maxSplitDepth is exceeded.
 *
 * This is a convenience wrapper for callers that need the full split tree
 * (e.g. state persistence for resume-after-crash). Each call recurses at most once;
 * re-dispatch of each half re-calls splitWave if the half itself overflows.
 *
 * @param {object} opts — same shape as splitWave
 * @returns same shape as splitWave
 * @throws {MaxSplitDepthExceededError}
 */
function splitWaveRecursive(opts) {
  return splitWave(opts);
}

module.exports = { splitWave, splitWaveRecursive, MaxSplitDepthExceededError };
