#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/skill/setup.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/setup.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }

PREPARE_OUTPUT_FILE=$(node "$SCRIPT" --output-file $ARGUMENTS)
EXIT_CODE=$?

echo "PREPARE_OUTPUT_FILE: $PREPARE_OUTPUT_FILE"
echo "STATUS: $EXIT_CODE"