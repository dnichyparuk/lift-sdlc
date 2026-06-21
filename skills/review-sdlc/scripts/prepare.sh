#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/skill/review.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/review.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }

MANIFEST_FILE=$(node "$SCRIPT" --output-file $ARGUMENTS --json)
EXIT_CODE=$?
# the manifest is removed even if dispatch errors or the agent crashes.

echo "MANIFEST_FILE: $MANIFEST_FILE"
echo "STATUS: $EXIT_CODE"