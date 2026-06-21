#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/skill/ship.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/ship.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
   [ -z "$SCRIPT" ] && [ -f "plugins/lift-sdlc/scripts/skill/ship.js" ] && SCRIPT="plugins/lift-sdlc/scripts/skill/ship.js"
   [ -z "$SCRIPT" ] && { echo "ERROR: Could not locate skill/ship.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
   PLAN_MODE_OUTPUT_FILE=$(node "$SCRIPT" --output-file --plan-mode-blocked $ARGUMENTS)
   PLAN_MODE_EXIT=$?
   echo "PLAN_MODE_OUTPUT_FILE=$PLAN_MODE_OUTPUT_FILE"
   echo "PLAN_MODE_EXIT=$PLAN_MODE_EXIT"

echo "PLAN_MODE_OUTPUT_FILE: $PLAN_MODE_OUTPUT_FILE"
echo "STATUS: $PLAN_MODE_EXIT"