#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

GIT_LIB="$SDLC_ROOT/scripts/skill/git.js"
[ ! -f "$GIT_LIB" ] && { echo "ERROR: Could not locate scripts/skill/git.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
node -e "
const { fetchPrChecks, fetchFailedCheckLogs } = require(process.argv[1]);
const checks = fetchPrChecks(process.argv[2]);
const failed = checks.find(c => c && c.bucket === 'fail');
if (!failed || !failed.link) { process.stderr.write('no failed check found\n'); process.exit(0); }
const m = failed.link.match(/\/actions\/runs\/(\d+)/);
if (!m) { process.stderr.write('no runId in link\n'); process.exit(0); }
const out = fetchFailedCheckLogs(m[1], { maxLines: 200 });
if (out.ok) process.stdout.write(out.excerpt);
" "$GIT_LIB" "$PR_NUMBER"
