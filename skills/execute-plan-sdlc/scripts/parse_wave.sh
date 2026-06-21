#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

LIB="$SDLC_ROOT/scripts/lib/wave-summary.js"
[ ! -f "$LIB" ] && { echo "ERROR: Could not locate scripts/lib/wave-summary.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
   [ -z "$LIB" ] && [ -f "plugins/lift-sdlc/scripts/lib/wave-summary.js" ] && LIB="plugins/lift-sdlc/scripts/lib/wave-summary.js"
   PARSE_RESULT=$(node -e "
   const { parseWaveSummary } = require('$LIB');
   const text = require('fs').readFileSync('/dev/stdin','utf8');
   const dispatched = JSON.parse(process.env.DISPATCHED_IDS || '[]');
   const r = parseWaveSummary(text, dispatched);
   process.stdout.write(JSON.stringify(r));
   " <<< "$WAVE_RUNNER_OUTPUT")
