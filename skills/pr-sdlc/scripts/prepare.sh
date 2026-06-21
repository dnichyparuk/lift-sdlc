#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/skill/pr.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/pr.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }

PR_CONTEXT_FILE=$(node "$SCRIPT" --output-file $ARGUMENTS)
EXIT_CODE=$?
# the manifest is removed even if a PR creation/update path errors out.

echo "PR_CONTEXT_FILE: $PR_CONTEXT_FILE"
echo "STATUS: $EXIT_CODE"

