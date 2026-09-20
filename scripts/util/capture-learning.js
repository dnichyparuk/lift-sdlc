#!/usr/bin/env node
/**
 * capture-learning.js
 *
 * Zero-dependency, injection-safe utility for capturing pending learnings
 * changesets into .sdlc/learnings/pending/.
 *
 * Usage:
 *   # Via stdin
 *   echo '{"signature":"auth-layer-raw-sql","rationale":"...","evidence":"..."}' | node capture-learning.js --stdin
 *
 *   # Via JSON file
 *   node capture-learning.js --file /path/to/payload.json
 *
 * Guardrails & Invariants:
 *   - Never accepts arbitrary text via CLI flag arguments (prevents shell injection).
 *   - Negative cache check: suppresses capture if signature is in config.rejected_guardrails.
 *   - Directory cap: max 100 pending files in .sdlc/learnings/pending/ (prevents unbounded disk growth).
 *   - Deduplication: skips capture if pending changeset with identical signature & content exists.
 *   - Atomic write: writes to temporary sibling before rename.
 *
 * Exit codes:
 *   0 = successfully captured, or safely suppressed (rejected/cap/duplicate)
 *   1 = validation or input error
 *   2 = unexpected script crash
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LIB = path.join(__dirname, '..', 'lib');
const { resolveSdlcRoot, readSection } = require(path.join(LIB, 'config'));
const {
  SIGNATURE_PATTERN,
  MAX_TEXT_LENGTH,
  MAX_IMPACT_LENGTH,
  parsePendingFile,
} = require(path.join(LIB, 'learnings'));

const PENDING_REL_PATH = path.join('.sdlc', 'learnings', 'pending');
const MAX_PENDING_FILES = 100;

const USAGE = `Usage:
  node capture-learning.js --stdin
  node capture-learning.js --file <path-to-json>

Options:
  --stdin             Read JSON payload from standard input
  --file <path>       Read JSON payload from a file
  --help, -h          Show this help message and exit

Exit codes:
  0 = capture succeeded or safely suppressed (rejected guardrail, directory cap, duplicate)
  1 = input or validation error
  2 = unexpected crash
`;

function parseArgs(argv = process.argv) {
  const args = Array.isArray(argv)
    ? (argv[0]?.endsWith('node') || (argv[1] && argv[1].endsWith('.js')) ? argv.slice(2) : argv)
    : [];
  let mode = null;
  let filePath = null;
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      showHelp = true;
    } else if (arg === '--stdin') {
      mode = 'stdin';
    } else if (arg === '--file') {
      mode = 'file';
      filePath = args[++i];
    }
  }

  return { mode, filePath, showHelp };
}

function readStream(stream) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { data += chunk; });
    stream.on('end', () => resolve(data));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Validate learning payload schema and constraints.
 * Returns { valid: true, payload } or { valid: false, error: string }.
 */
function validatePayload(rawPayload) {
  if (typeof rawPayload !== 'object' || rawPayload === null || Array.isArray(rawPayload)) {
    return { valid: false, error: 'Payload must be a non-null JSON object' };
  }

  const { signature, rationale, evidence, impact, sourceSkill, sourceRef } = rawPayload;

  if (typeof signature !== 'string' || !signature.trim()) {
    return { valid: false, error: 'Field "signature" is required and must be a non-empty string' };
  }

  if (!SIGNATURE_PATTERN.test(signature.trim())) {
    return {
      valid: false,
      error: `Field "signature" must match kebab-case pattern /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/ (got: "${signature}")`,
    };
  }

  if (typeof rationale !== 'string' || !rationale.trim()) {
    return { valid: false, error: 'Field "rationale" is required and must be a non-empty string' };
  }

  if (rationale.length > MAX_TEXT_LENGTH) {
    return {
      valid: false,
      error: `Field "rationale" exceeds maximum length of ${MAX_TEXT_LENGTH} characters (got: ${rationale.length})`,
    };
  }

  if (typeof evidence !== 'string' || !evidence.trim()) {
    return { valid: false, error: 'Field "evidence" is required and must be a non-empty string' };
  }

  if (evidence.length > MAX_TEXT_LENGTH) {
    return {
      valid: false,
      error: `Field "evidence" exceeds maximum length of ${MAX_TEXT_LENGTH} characters (got: ${evidence.length})`,
    };
  }

  if (impact !== undefined && impact !== null) {
    if (typeof impact !== 'string') {
      return { valid: false, error: 'Field "impact" must be a string if provided' };
    }
    if (impact.includes('\n')) {
      return { valid: false, error: 'Field "impact" must be a single line (no newlines)' };
    }
    if (impact.includes('`')) {
      return { valid: false, error: 'Field "impact" must not contain backtick characters' };
    }
    if (impact.length > MAX_IMPACT_LENGTH) {
      return {
        valid: false,
        error: `Field "impact" exceeds maximum length of ${MAX_IMPACT_LENGTH} characters (got: ${impact.length})`,
      };
    }
  }

  if (sourceSkill !== undefined && sourceSkill !== null) {
    if (typeof sourceSkill !== 'string' || sourceSkill.includes('\n')) {
      return { valid: false, error: 'Field "sourceSkill" must be a single-line string if provided' };
    }
  }

  if (sourceRef !== undefined && sourceRef !== null) {
    if (typeof sourceRef !== 'string' || sourceRef.includes('\n')) {
      return { valid: false, error: 'Field "sourceRef" must be a single-line string if provided' };
    }
  }

  return {
    valid: true,
    payload: {
      signature: signature.trim(),
      rationale: rationale.trim(),
      evidence: evidence.trim(),
      impact: impact != null ? impact.trim() : null,
      sourceSkill: sourceSkill != null ? sourceSkill.trim() : null,
      sourceRef: sourceRef != null ? sourceRef.trim() : null,
    },
  };
}

/**
 * Core capture logic.
 *
 * @param {object} payload
 * @param {object} [deps]
 * @returns {{ captured: boolean, suppressed: boolean, reason?: string, filePath?: string }}
 */
function captureLearning(payload, deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const fsImpl = deps.fs || fs;
  const projectRoot = deps.projectRoot || resolveSdlcRoot({ cwd }) || cwd;

  // 1. Negative cache check
  const rejected = deps.rejectedGuardrails !== undefined
    ? deps.rejectedGuardrails
    : (readSection(projectRoot, 'rejected_guardrails') || []);

  if (Array.isArray(rejected) && rejected.includes(payload.signature)) {
    return {
      captured: false,
      suppressed: true,
      reason: `signature '${payload.signature}' is in rejected_guardrails`,
    };
  }

  // 2. Directory cap check
  const pendingDir = path.join(projectRoot, PENDING_REL_PATH);
  fsImpl.mkdirSync(pendingDir, { recursive: true });

  const existingFiles = fsImpl.readdirSync(pendingDir)
    .filter((name) => !name.startsWith('.'));

  if (existingFiles.length >= MAX_PENDING_FILES) {
    return {
      captured: false,
      suppressed: true,
      reason: `pending directory cap reached (>= ${MAX_PENDING_FILES} files)`,
    };
  }

  // 3. Deduplication check
  const sanitizedRationale = payload.rationale.replace(/\r?\n+/g, ' ').trim();
  const sanitizedEvidence = payload.evidence.replace(/\r?\n+/g, ' ').trim();

  for (const filename of existingFiles) {
    const fullPath = path.join(pendingDir, filename);
    try {
      const content = fsImpl.readFileSync(fullPath, 'utf8');
      const parsed = parsePendingFile(content, fullPath);
      if (
        parsed.valid &&
        parsed.signature === payload.signature &&
        parsed.rationale === sanitizedRationale &&
        parsed.evidence === sanitizedEvidence
      ) {
        return {
          captured: false,
          suppressed: true,
          reason: `duplicate pending learning exists for signature '${payload.signature}'`,
          filePath: fullPath,
        };
      }
    } catch {
      // Ignore unreadable or corrupt pending files during dedup
    }
  }

  // 4. Construct canonical pending markdown
  const lines = [
    '---',
    `signature: ${payload.signature}`,
    `rationale: ${sanitizedRationale}`,
    `evidence: ${sanitizedEvidence}`,
  ];
  if (payload.impact) {
    lines.push(`impact: ${payload.impact}`);
  }
  if (payload.sourceSkill) {
    lines.push(`sourceSkill: ${payload.sourceSkill}`);
  }
  lines.push('---');
  lines.push('');
  lines.push('## Learning Captured');
  lines.push('');
  lines.push(`- **Signature:** ${payload.signature}`);
  if (payload.sourceSkill) {
    lines.push(`- **Source Skill:** ${payload.sourceSkill}`);
  }
  if (payload.sourceRef) {
    lines.push(`- **Source Ref:** ${payload.sourceRef}`);
  }
  lines.push(`- **Captured At:** ${new Date().toISOString()}`);
  lines.push('');
  lines.push('### Rationale');
  lines.push(payload.rationale);
  lines.push('');
  lines.push('### Evidence');
  lines.push(payload.evidence);
  lines.push('');

  const fileContent = lines.join('\n');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}-${payload.signature}.md`;
  const destPath = path.join(pendingDir, filename);

  const tmpPath = path.join(pendingDir, `.${filename}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fsImpl.writeFileSync(tmpPath, fileContent, 'utf8');
  fsImpl.renameSync(tmpPath, destPath);

  return {
    captured: true,
    suppressed: false,
    filePath: destPath,
  };
}

async function runCaptureLearning(argv, deps = {}) {
  const stdout = deps.stdout || process.stdout;
  const stderr = deps.stderr || process.stderr;
  const stdin  = deps.stdin  || process.stdin;
  const exit   = deps.exit   || process.exit;
  const fsImpl = deps.fs     || fs;

  const { mode, filePath, showHelp } = parseArgs(argv);

  if (showHelp) {
    stdout.write(USAGE);
    return exit(0);
  }

  if (!mode) {
    stderr.write('Error: Either --stdin or --file <path> must be specified.\n\n');
    stderr.write(USAGE);
    return exit(1);
  }

  let rawJson = '';

  if (mode === 'stdin') {
    if (stdin.isTTY) {
      stderr.write('Error: capture-learning.js --stdin expects input piped via stdin, but stdin is an interactive TTY.\n\n');
      stderr.write(USAGE);
      return exit(1);
    }
    rawJson = await readStream(stdin);
  } else if (mode === 'file') {
    if (!filePath) {
      stderr.write('Error: --file requires a file path argument.\n');
      return exit(1);
    }
    const resolvedPath = path.resolve(deps.cwd || process.cwd(), filePath);
    if (!fsImpl.existsSync(resolvedPath)) {
      stderr.write(`Error: File not found: "${resolvedPath}"\n`);
      return exit(1);
    }
    try {
      rawJson = fsImpl.readFileSync(resolvedPath, 'utf8');
    } catch (err) {
      stderr.write(`Error: Failed to read file "${resolvedPath}": ${err.message}\n`);
      return exit(1);
    }
  }

  let parsedJson;
  try {
    parsedJson = JSON.parse(rawJson);
  } catch (err) {
    stderr.write(`Error: Invalid JSON payload: ${err.message}\n`);
    return exit(1);
  }

  const validation = validatePayload(parsedJson);
  if (!validation.valid) {
    stderr.write(`Error: ${validation.error}\n`);
    return exit(1);
  }

  const result = captureLearning(validation.payload, deps);

  if (result.suppressed) {
    if (result.reason && result.reason.includes('rejected_guardrails')) {
      stdout.write(`[learning-capture] Suppressed: ${result.reason}.\n`);
    } else if (result.reason && result.reason.includes('cap reached')) {
      stdout.write(`[learning-capture] Warning: ${result.reason}. Skipping capture.\n`);
    } else {
      stdout.write(`[learning-capture] Skipped: ${result.reason}.\n`);
    }
    return exit(0);
  }

  const rel = path.relative(deps.cwd || process.cwd(), result.filePath);
  stdout.write(`[learning-capture] Captured pending learning: ${rel}\n`);
  return exit(0);
}

async function main() {
  try {
    await runCaptureLearning(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Unexpected error: ${err.stack || err.message}\n`);
    process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  captureLearning,
  runCaptureLearning,
  validatePayload,
  parseArgs,
  MAX_PENDING_FILES,
};
