#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/skill/version.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/version.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }

VERSION_CONTEXT_FILE=$(node "$SCRIPT" --output-file $ARGUMENTS)
EXIT_CODE=$?
# the manifest is removed even if the release is cancelled or errors out.

echo "VERSION_CONTEXT_FILE: $VERSION_CONTEXT_FILE"
echo "STATUS: $EXIT_CODE"

