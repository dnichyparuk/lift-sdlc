#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LIB="$SDLC_ROOT/scripts/lib/config.js"
[ ! -f "$LIB" ] && { echo "ERROR: Could not locate config.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
node -e "
const { readSection, writeSection } = require('$LIB');
const root = process.cwd();
const current = readSection(root, 'pr') || {};
const next = { ...current, labels: JSON.parse(process.argv[1]) };
writeSection(root, 'pr', next);
console.log('Wrote pr.labels to .sdlc/config.json');
" "$1"
