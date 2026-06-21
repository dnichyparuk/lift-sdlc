#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PR_PREPARE="$SDLC_ROOT/scripts/skill/pr.js"
[ ! -f "$PR_PREPARE" ] && { echo "ERROR: Could not locate scripts/skill/pr.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
[ -z "$PR_PREPARE" ] && [ -f "plugins/lift-sdlc/scripts/skill/pr.js" ] && PR_PREPARE="plugins/lift-sdlc/scripts/skill/pr.js"
printf '%s' "$body" | node "$PR_PREPARE" --validate-body
LINK_EXIT=$?
