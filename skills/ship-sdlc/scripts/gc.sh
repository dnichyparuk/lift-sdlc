#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/skill/ship.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/ship.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
[ -z "$SCRIPT" ] && [ -f "plugins/lift-sdlc/scripts/skill/ship.js" ] && SCRIPT="plugins/lift-sdlc/scripts/skill/ship.js"
PREPARE_OUTPUT_FILE=$(node "$SCRIPT" --output-file --gc)  # add --ttl-days <N> when provided
