/**
 * dimensions.js
 * Shared utilities for reading and validating review dimension files.
 * Zero external dependencies — Node.js built-ins only.
 *
 * Exports: extractFrontmatter, extractBody, parseSimpleYaml,
 *          isValidGlob, KNOWN_FIELDS, VALID_SEVERITIES,
 *          validateDimensionFile, validateAll
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { extractFrontmatter, extractBody, parseSimpleYaml } = require('./yaml.js');

// ---------------------------------------------------------------------------
// Glob syntax validation (lightweight — no minimatch)
// ---------------------------------------------------------------------------

function isValidGlob(pattern) {
  if (typeof pattern !== 'string') return false;
  if (!pattern.trim()) return false;
  // No triple stars
  if (/\*{3,}/.test(pattern)) return false;
  // Balanced brackets
  let depth = 0;
  for (const ch of pattern) {
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth < 0) return false; }
  }
  if (depth !== 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Levenshtein distance (for typo suggestions)
// ---------------------------------------------------------------------------

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ---------------------------------------------------------------------------
// Known frontmatter fields
// ---------------------------------------------------------------------------

const KNOWN_FIELDS = new Set([
  'name', 'description', 'triggers', 'skip-when',
  'severity', 'max-files', 'requires-full-diff', 'model',
]);

const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const VALID_MODELS = new Set([
  'gemini-3.8-flash-low',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-high',
  'gemini-3.1-pro-low',
  'gemini-3.1-pro-high',
]);

/**
 * Canonical severity vocabulary for plan/execute guardrails (R17).
 * See lib/dimensions.js::GUARDRAIL_SEVERITIES for the source of truth.
 */
const GUARDRAIL_SEVERITIES = new Set(['error', 'warning']);

/**
 * Returns the canonical severity vocabulary Set for the given surface name.
 * - 'review-dimensions' → VALID_SEVERITIES
 * - 'plan-guardrails' | 'execute-guardrails' → GUARDRAIL_SEVERITIES
 * - anything else (e.g. 'copilot-instructions') → null
 *
 * Reserved for programmatic callers (e.g. orchestrator surface-dispatch logic).
 * Not currently used by any script in this repo — exported intentionally as part
 * of the R17 severity-vocab API surface.
 *
 * @param {string} surface
 * @returns {Set<string>|null}
 */
function severityForSurface(surface) {
  if (surface === 'review-dimensions') return VALID_SEVERITIES;
  if (surface === 'plan-guardrails' || surface === 'execute-guardrails') return GUARDRAIL_SEVERITIES;
  return null;
}

// ---------------------------------------------------------------------------
// Validate a single dimension file
// ---------------------------------------------------------------------------

function validateDimensionFile(filePath) {
  const errors = [];
  const warnings = [];

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    errors.push({ check: 'D0', message: `Cannot read file: ${err.message}`, line: null });
    return { errors, warnings, parsed: null };
  }

  // D1 — Frontmatter present
  const rawFm = extractFrontmatter(content);
  if (!rawFm) {
    errors.push({ check: 'D1', message: 'Missing YAML frontmatter block (--- delimiters)', line: null });
    return { errors, warnings, parsed: null };
  }

  const fm = parseSimpleYaml(rawFm);

  // D11 — Unknown fields (check before required-field checks so typo suggestions appear early)
  for (const key of Object.keys(fm)) {
    if (!KNOWN_FIELDS.has(key)) {
      // Typo suggestion using Levenshtein distance
      const suggestions = [...KNOWN_FIELDS].filter(f => levenshtein(f, key) <= 2);
      const hint = suggestions.length > 0 ? ` (did you mean: ${suggestions.join(', ')}?)` : '';
      warnings.push({ check: 'D11', message: `Unknown frontmatter field: "${key}"${hint}`, line: null });
    }
  }

  // D2 — name
  if (!fm.name && fm.name !== 0) {
    errors.push({ check: 'D2', message: 'Missing required field: name', line: null });
  } else if (typeof fm.name !== 'string') {
    errors.push({ check: 'D2', message: 'Field "name" must be a string', line: null });
  } else if (!/^[a-z0-9-]+$/.test(fm.name)) {
    errors.push({ check: 'D2', message: `Field "name" must be lowercase letters, digits, and hyphens only (got: "${fm.name}")`, line: null });
  } else if (fm.name.length > 64) {
    errors.push({ check: 'D2', message: `Field "name" exceeds 64 characters (got: ${fm.name.length})`, line: null });
  }

  // D3 — description
  if (!fm.description) {
    errors.push({ check: 'D3', message: 'Missing required field: description', line: null });
  } else if (typeof fm.description !== 'string') {
    errors.push({ check: 'D3', message: 'Field "description" must be a string', line: null });
  } else if (fm.description.trim().length === 0) {
    errors.push({ check: 'D3', message: 'Field "description" must not be empty', line: null });
  } else if (fm.description.length > 256) {
    errors.push({ check: 'D3', message: `Field "description" exceeds 256 characters (got: ${fm.description.length})`, line: null });
  }

  // D4 — triggers
  if (!fm.triggers) {
    errors.push({ check: 'D4', message: 'Missing required field: triggers (must be a non-empty array of glob patterns)', line: null });
  } else if (!Array.isArray(fm.triggers)) {
    errors.push({ check: 'D4', message: 'Field "triggers" must be an array of strings', line: null });
  } else if (fm.triggers.length === 0) {
    errors.push({ check: 'D4', message: 'Field "triggers" must contain at least one pattern', line: null });
  } else {
    // D5 — glob syntax
    for (const pattern of fm.triggers) {
      if (!isValidGlob(pattern)) {
        errors.push({ check: 'D5', message: `Invalid glob pattern in triggers: "${pattern}"`, line: null });
      }
    }
  }

  // D6 — severity (optional)
  if (fm.severity !== undefined) {
    if (!VALID_SEVERITIES.has(fm.severity)) {
      warnings.push({ check: 'D6', message: `Field "severity" must be one of: critical, high, medium, low, info (got: "${fm.severity}")`, line: null });
    }
  }

  // D7 — max-files (optional)
  if (fm['max-files'] !== undefined) {
    if (!Number.isInteger(fm['max-files']) || fm['max-files'] <= 0) {
      warnings.push({ check: 'D7', message: `Field "max-files" must be a positive integer (got: ${JSON.stringify(fm['max-files'])})`, line: null });
    }
  }

  // D8 — skip-when (optional)
  if (fm['skip-when'] !== undefined) {
    if (!Array.isArray(fm['skip-when'])) {
      warnings.push({ check: 'D8', message: 'Field "skip-when" must be an array of strings', line: null });
    } else {
      for (const pattern of fm['skip-when']) {
        if (!isValidGlob(pattern)) {
          warnings.push({ check: 'D8', message: `Invalid glob pattern in skip-when: "${pattern}"`, line: null });
        }
      }
    }
  }

  // D9 — body non-empty
  const body = extractBody(content);
  if (body.length < 10) {
    errors.push({ check: 'D9', message: `Body must contain at least 10 characters of review instructions (got: ${body.length})`, line: null });
  }

  // D12 — requires-full-diff (optional)
  if (fm['requires-full-diff'] !== undefined) {
    if (typeof fm['requires-full-diff'] !== 'boolean') {
      warnings.push({ check: 'D12', message: `Field "requires-full-diff" must be a boolean (got: ${JSON.stringify(fm['requires-full-diff'])})`, line: null });
    }
  }

  // D13 — model (optional)
  if (fm.model !== undefined) {
    if (typeof fm.model !== 'string' || fm.model.trim().length === 0) {
      warnings.push({ check: 'D13', message: `Field "model" must be a non-empty string (got: ${JSON.stringify(fm.model)})`, line: null });
    } else if (!VALID_MODELS.has(fm.model)) {
      warnings.push({ check: 'D13', message: `Field "model" should be one of: ${Array.from(VALID_MODELS).join(', ')} (got: "${fm.model}")`, line: null });
    }
  }

  return { errors, warnings, parsed: fm };
}

// ---------------------------------------------------------------------------
// Main validation runner
// ---------------------------------------------------------------------------

// Issue #231: prefer .sdlc/review-dimensions/, fall back to legacy review-dimensions/
// with one-time stderr deprecation warning.
let _legacyDimensionsWarningEmitted = false;

function resolveDimensionsDir(projectRoot) {
  const newPath = path.join(projectRoot, '.sdlc', 'review-dimensions');
  const legacyPath = path.join(projectRoot, 'review-dimensions');
  if (fs.existsSync(newPath)) return newPath;
  if (fs.existsSync(legacyPath)) {
    if (!_legacyDimensionsWarningEmitted) {
      _legacyDimensionsWarningEmitted = true;
      process.stderr.write(
        `Deprecation: review-dimensions/ is the legacy review-dimensions location. ` +
        `Run /setup-sdlc --migrate to move dimensions to ${path.join('.sdlc', 'review-dimensions')}.\n`
      );
    }
    return legacyPath;
  }
  return newPath; // doesn't exist; readdirSync will fail and return zero files
}

function validateAll(projectRoot) {
  const dimensionsDir = resolveDimensionsDir(projectRoot);

  let files = [];
  try {
    const entries = fs.readdirSync(dimensionsDir);
    files = entries
      .filter(f => f.endsWith('.md'))
      .map(f => path.join(dimensionsDir, f));
  } catch (err) {
    // Directory doesn't exist — not an error for this script, just zero results
    files = [];
  }

  const results = [];
  const seenNames = new Map(); // name -> first file

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const { errors: fileErrors, warnings, parsed } = validateDimensionFile(filePath);
    const errors = [...fileErrors]; // copy to avoid mutating the returned array
    const name = parsed ? parsed.name || null : null;

    // D10 — name uniqueness (cross-file check)
    if (name && seenNames.has(name)) {
      errors.push({
        check: 'D10',
        message: `Duplicate dimension name "${name}" — also used in ${path.basename(seenNames.get(name))}`,
        line: null,
      });
    } else if (name) {
      seenNames.set(name, filePath);
    }

    const status = errors.length > 0 ? 'FAIL' : 'PASS';
    results.push({ file: fileName, name, status, errors, warnings });
  }

  const totalErrors = results.reduce((s, r) => s + r.errors.length, 0);
  const totalWarnings = results.reduce((s, r) => s + r.warnings.length, 0);
  const passCount = results.filter(r => r.status === 'PASS').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;

  let overall;
  if (failCount > 0) overall = 'HAS_ISSUES';
  else if (totalWarnings > 0) overall = 'HAS_WARNINGS';
  else overall = 'PASS';

  return {
    timestamp: new Date().toISOString(),
    dimensions_dir: path.relative(projectRoot, dimensionsDir),
    dimensions: results,
    summary: {
      total: results.length,
      pass: passCount,
      fail: failCount,
      total_errors: totalErrors,
      total_warnings: totalWarnings,
    },
    overall,
  };
}

module.exports = {
  extractFrontmatter,
  extractBody,
  parseSimpleYaml,
  isValidGlob,
  KNOWN_FIELDS,
  VALID_SEVERITIES,
  VALID_MODELS,
  GUARDRAIL_SEVERITIES,
  severityForSurface,
  validateDimensionFile,
  validateAll,
  resolveDimensionsDir,
};
