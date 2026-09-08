'use strict';

/**
 * time-constants.js
 * Shared millisecond duration constants for scripts and hooks that compute
 * freshness windows, TTLs, and staleness thresholds (e.g. compact-recovery
 * TTL in scripts/lib/state.js, recovery-file freshness/sweep thresholds in
 * hooks/session-start.js). Replaces scattered inline `60 * 60 * 1000`-style
 * magic numbers with named constants.
 *
 * Zero npm dependencies — Node.js built-ins only.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

module.exports = { SECOND_MS, MINUTE_MS, HOUR_MS, DAY_MS };
