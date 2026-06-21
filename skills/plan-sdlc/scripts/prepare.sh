#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/skill/plan.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/plan.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }

PLAN_OUTPUT_FILE=$(node "$SCRIPT" --output-file)
EXIT_CODE=$?

echo "PLAN_OUTPUT_FILE: $PLAN_OUTPUT_FILE"
echo "STATUS: $EXIT_CODE"