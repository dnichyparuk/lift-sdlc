#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/skill/received-review.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/received-review.js. Is the sdlc plugin installed?" >&2; exit 2; }

if [ -n "$SCRIPT" ]; then
  MANIFEST_FILE=$(node "$SCRIPT" --output-file $ARGUMENTS)
  EXIT_CODE=$?
  echo "MANIFEST_FILE=$MANIFEST_FILE"
  echo "EXIT_CODE=$EXIT_CODE"
  # Single canonical cleanup: trap fires unconditionally on EXIT/INT/TERM.
fi

echo "MANIFEST_FILE: $MANIFEST_FILE"
echo "STATUS: $EXIT_CODE"