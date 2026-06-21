#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

CLASSIFY_SCRIPT="$SDLC_ROOT/scripts/skill/verify-pipeline-sdlc-classify.js"
[ ! -f "$CLASSIFY_SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/verify-pipeline-sdlc-classify.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
echo "$LOGS" | node "$CLASSIFY_SCRIPT"
