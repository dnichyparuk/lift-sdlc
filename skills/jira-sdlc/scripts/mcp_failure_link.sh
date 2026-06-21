#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

HELPER="$SDLC_ROOT/scripts/skill/mcp-failure.js"
[ ! -f "$HELPER" ] && { echo "ERROR: Could not locate scripts/skill/mcp-failure.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
# telemetry block is echoed to terminal for user visibility (intentional)
[ -n "$HELPER" ] && node "$HELPER" --telemetry --class link-verification --tool "jira.js --validate-body" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "link verification abort: $LINK_EXIT" --recovered no
