'use strict';

/**
 * model-tiers.js
 * Canonical Gemini 4 model tiers and Antigravity (`agy`) subagent model enum mapping.
 * Zero external dependencies — Node.js built-ins only.
 */

const GEMINI4_MODELS = Object.freeze([
  'gemini-4-hydrogen-low',
  'gemini-4-hydrogen-medium',
  'gemini-4-hydrogen-high',
  'gemini-4-hydrogen-xhigh',
  'gemini-4-neon-low',
  'gemini-4-neon-medium',
  'gemini-4-neon-high',
  'gemini-4-neon-xhigh',
  'gemini-4-argon-low',
  'gemini-4-argon-medium',
  'gemini-4-argon-high',
  'gemini-4-carbon-low',
  'gemini-4-carbon-medium',
  'gemini-4-carbon-high',
]);

const VALID_AGY_ENUMS = Object.freeze([
  'inherit',
  'flash_lite',
  'flash',
  'pro',
]);

/**
 * Map a Gemini 4 tier, legacy Gemini 3.x tier, or agy enum to a valid agy model enum.
 *
 * Mapping:
 *   - valid agy enums (`inherit`, `flash_lite`, `flash`, `pro`) -> passed through
 *   - `*-hydrogen-low`, legacy `*-flash-low` -> `flash_lite`
 *   - `*-hydrogen-medium/high/xhigh`, legacy `*-flash-medium/high` -> `flash`
 *   - `*-neon-*`, `*-argon-*`, `*-carbon-*`, legacy `*-pro-*` -> `pro`
 *   - unknown / empty -> `flash`
 *
 * @param {string} tier
 * @returns {'inherit'|'flash_lite'|'flash'|'pro'}
 */
function toAgyModelEnum(tier) {
  if (typeof tier !== 'string') return 'flash';
  const normalized = tier.trim().toLowerCase();
  if (!normalized) return 'flash';

  if (VALID_AGY_ENUMS.includes(normalized)) {
    return normalized;
  }

  if (/-hydrogen-low$/.test(normalized) || /-flash-low$/.test(normalized)) {
    return 'flash_lite';
  }

  if (
    /-hydrogen-(medium|high|xhigh)$/.test(normalized) ||
    /-flash-(medium|high|xhigh)$/.test(normalized) ||
    normalized === 'gemini-4-hydrogen' ||
    normalized === 'gemini-3.8-flash'
  ) {
    return 'flash';
  }

  if (
    /-(neon|argon|carbon)(-(low|medium|high|xhigh))?$/.test(normalized) ||
    /-pro(-(low|medium|high|xhigh))?$/.test(normalized)
  ) {
    return 'pro';
  }

  return 'flash';
}

/**
 * Escalate an agy model enum by one tier:
 *   flash_lite -> flash -> pro -> pro
 *
 * @param {string} currentEnum
 * @returns {'flash'|'pro'}
 */
function escalateAgyModel(currentEnum) {
  if (currentEnum === 'flash_lite') return 'flash';
  if (currentEnum === 'flash') return 'pro';
  return 'pro';
}

const LOGICAL_ESCALATION_LADDER = Object.freeze({
  'gemini-4-hydrogen-low': 'gemini-4-hydrogen-medium',
  'gemini-4-hydrogen-medium': 'gemini-4-hydrogen-high',
  'gemini-4-hydrogen-high': 'gemini-4-neon-low',
  'gemini-4-hydrogen-xhigh': 'gemini-4-neon-low',
  'gemini-4-neon-low': 'gemini-4-argon-low',
  'gemini-4-neon-medium': 'gemini-4-argon-medium',
  'gemini-4-argon-low': 'gemini-4-neon-high',
  'gemini-4-argon-medium': 'gemini-4-carbon-medium',
  'gemini-4-argon-high': 'gemini-4-carbon-medium',
  'gemini-4-neon-high': 'gemini-4-carbon-medium',
  'gemini-4-neon-xhigh': 'gemini-4-carbon-medium',
  'gemini-4-carbon-low': 'gemini-4-carbon-medium',
  'gemini-4-carbon-medium': 'gemini-4-carbon-high',
  'gemini-4-carbon-high': 'gemini-4-carbon-high',
});

/**
 * Failure-aware logical model escalation along the Gemini 4 ladder.
 *
 * - `NEEDS_CONTEXT`: keep the same tier (inject missing context instead).
 * - `SPEC_GAP`: escalate directly to `gemini-4-argon-low`, or
 *   `gemini-4-carbon-medium` if already Argon / Neon-high / Carbon
 *   (preserving `gemini-4-carbon-high`).
 * - `FAILED_TESTS` / `FAILED_BUILD` / `BLOCKED` (default): advance one rung
 *   along `LOGICAL_ESCALATION_LADDER`.
 *
 * @param {string} currentTier
 * @param {string} [errorCode='FAILED_TESTS']
 * @returns {string}
 */
function escalateLogicalModel(currentTier, errorCode = 'FAILED_TESTS') {
  const code = typeof errorCode === 'string' ? errorCode.trim().toUpperCase() : 'FAILED_TESTS';
  if (code === 'NEEDS_CONTEXT') {
    return currentTier;
  }

  const tier = typeof currentTier === 'string' ? currentTier.trim().toLowerCase() : '';

  if (code === 'SPEC_GAP') {
    if (tier === 'gemini-4-carbon-high') {
      return 'gemini-4-carbon-high';
    }
    if (
      tier.startsWith('gemini-4-argon-') ||
      tier === 'gemini-4-neon-high' ||
      tier === 'gemini-4-neon-xhigh' ||
      tier.startsWith('gemini-4-carbon-')
    ) {
      return 'gemini-4-carbon-medium';
    }
    return 'gemini-4-argon-low';
  }

  if (Object.prototype.hasOwnProperty.call(LOGICAL_ESCALATION_LADDER, tier)) {
    return LOGICAL_ESCALATION_LADDER[tier];
  }

  return 'gemini-4-neon-low';
}

module.exports = {
  GEMINI4_MODELS,
  VALID_AGY_ENUMS,
  toAgyModelEnum,
  escalateAgyModel,
  escalateLogicalModel,
};
