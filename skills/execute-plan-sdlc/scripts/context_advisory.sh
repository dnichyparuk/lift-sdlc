#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SDLC_LIB="$SDLC_ROOT/scripts/lib"
[ ! -f "$SDLC_LIB/config.js" ] && { echo "ERROR: Could not locate scripts/lib/config.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
node -e "
const { readSection } = require('$SDLC_LIB/config.js');
try {
  const advisory = require('$SDLC_LIB/context-advisory.js').getAdvisory({ skill: 'execute-plan-sdlc' });
  if (advisory) process.stderr.write(advisory + '\n');
} catch (_) { /* helper missing or sidecar unreadable — silent */ }
const execute = readSection(process.cwd(), 'execute');
console.log(JSON.stringify(execute?.guardrails || []));
"
