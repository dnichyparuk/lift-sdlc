#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SDLC_LIB="$SDLC_ROOT/scripts/lib"
[ ! -f "$SDLC_LIB/config.js" ] && { echo "ERROR: Could not locate scripts/lib/config.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }

node -e "
const { writeSection } = require('$SDLC_LIB/config.js');
const guardrails = JSON.parse(process.argv[1]);
writeSection(process.cwd(), 'execute', { guardrails });
console.log('Wrote ' + guardrails.length + ' execution guardrails to .sdlc/config.json');
" '<GUARDRAILS_JSON>'
