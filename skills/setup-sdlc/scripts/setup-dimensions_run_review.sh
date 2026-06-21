#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PREP="$SDLC_ROOT/scripts/skill/review.js"
[ ! -f "$PREP" ] && { echo "ERROR: Could not locate scripts/skill/review.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
[ -z "$PREP" ] && [ -f "plugins/lift-sdlc/scripts/skill/review.js" ] && PREP="plugins/lift-sdlc/scripts/skill/review.js"
[ -n "$PREP" ] && node "$PREP" --project-root . --json 2>/dev/null
