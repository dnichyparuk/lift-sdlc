#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/skill/ship-init.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/ship-init.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }

INIT_OUTPUT_FILE=$(node "$SCRIPT" --output-file --steps execute,commit,review,archive-openspec,pr --bump patch --auto --threshold high --workspace prompt)
EXIT_CODE=$?

echo "INIT_OUTPUT_FILE: $INIT_OUTPUT_FILE"
echo "STATUS: $EXIT_CODE"