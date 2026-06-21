#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

LIB_CONFIG="$SDLC_ROOT/scripts/lib/config.js"
[ ! -f "$LIB_CONFIG" ] && { echo "ERROR: Could not locate scripts/lib/config.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
[ -z "$LIB_CONFIG" ] && [ -f "plugins/lift-sdlc/scripts/lib/config.js" ] && LIB_CONFIG="plugins/lift-sdlc/scripts/lib/config.js"

# Write JSON snapshots to temp files to avoid shell quoting hazards with
# embedded quotes and newlines inside $BEFORE_JSON / $AFTER_JSON.
BEFORE_TMP=$(mktemp)
AFTER_TMP=$(mktemp)
printf '%s' "$BEFORE_JSON" > "$BEFORE_TMP"
printf '%s' "$AFTER_JSON" > "$AFTER_TMP"

DIFF_JSON=$(LIB_CONFIG="$LIB_CONFIG" BEFORE_TMP="$BEFORE_TMP" AFTER_TMP="$AFTER_TMP" node -e "
const { computeConfigDiff } = require(process.env.LIB_CONFIG);
const before = JSON.parse(require('fs').readFileSync(process.env.BEFORE_TMP, 'utf8'));
const after  = JSON.parse(require('fs').readFileSync(process.env.AFTER_TMP,  'utf8'));
console.log(JSON.stringify(computeConfigDiff(before, after)));
")
rm -f "$BEFORE_TMP" "$AFTER_TMP"
