#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/skill/jira.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/jira.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }

JIRA_CONTEXT_FILE=$(node "$SCRIPT" --output-file $ARGUMENTS --check)
EXIT_CODE=$?

echo "JIRA_CONTEXT_FILE: $JIRA_CONTEXT_FILE"
echo "STATUS: $EXIT_CODE"

