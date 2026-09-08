#!/usr/bin/env node
/**
 * parse-proposal.js
 *
 * Node port of skills/jira-sdlc/scripts/parse_proposal.sh, which itself was
 * a thin wrapper around an inline `node -e` one-liner:
 *
 *   node -e "let d=''; process.stdin.on('data',c=>d+=c).on('end',
 *     ()=>process.stdout.write(String(JSON.parse(d).proposal['$1'] || '')))"
 *
 * Reads a JSON object from stdin shaped like { "proposal": { <field>: ... } }
 * and writes proposal[<field>] to stdout -- falling back to '' for any
 * falsy value (missing key, '', null, 0, false), exactly like the shell
 * original's `|| ''` lookup. Writes with NO trailing newline, matching the
 * original's raw process.stdout.write.
 *
 * Usage:
 *   printf '%s' "$ANALYZE_JSON" | node parse-proposal.js <field>
 *
 * Exit codes:
 *   0 = field extracted (or defaulted to '') and written to stdout
 *   2 = missing <field> argument, stdin was not valid JSON, or stdin JSON
 *       had no "proposal" object to index into
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const field = args[0];
  const errors = [];
  if (!field) {
    errors.push('Missing field');
  }
  return { field, errors };
}

// ---------------------------------------------------------------------------
// Core (injectable for tests)
// ---------------------------------------------------------------------------

function readStdin(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');

    const onData = (chunk) => { data += chunk; };
    const onEnd = () => settle(() => resolve(data));
    const onError = (err) => settle(() => reject(err));

    function settle(action) {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      action();
    }

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.resume();
  });
}

/**
 * Exact key-lookup shape of the original `node -e`: JSON.parse(input)
 * .proposal[field] || ''. Throws if input is not valid JSON, or if the
 * parsed value has no `proposal` to index into -- callers catch this.
 *
 * @param {string} field
 * @param {string} input  raw JSON string read from stdin
 * @returns {string}
 */
function extractProposalField(field, input) {
  const parsed = JSON.parse(input);
  return String(parsed.proposal[field] || '');
}

/**
 * @param {string[]} argv  Full argv (process.argv shape).
 * @param {{stdin?:NodeJS.ReadableStream}} [deps]
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string|null}>}
 */
async function runParseProposal(argv, { stdin = process.stdin } = {}) {
  const { field, errors } = parseArgs(argv);
  if (errors.length > 0) {
    return { exitCode: 2, stdout: '', stderr: 'ERROR: Missing field\n' };
  }

  const input = await readStdin(stdin);

  let value;
  try {
    value = extractProposalField(field, input);
  } catch (e) {
    return { exitCode: 2, stdout: '', stderr: `ERROR: ${e.message}\n` };
  }

  return { exitCode: 0, stdout: value, stderr: null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv) {
  const { exitCode, stdout, stderr } = await runParseProposal(argv);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

module.exports = { parseArgs, extractProposalField, runParseProposal, readStdin };

if (require.main === module) {
  main(process.argv);
}
