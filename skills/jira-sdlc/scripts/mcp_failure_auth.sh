#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

HELPER="$SDLC_ROOT/scripts/skill/mcp-failure.js"
[ ! -f "$HELPER" ] && { echo "ERROR: Could not locate scripts/skill/mcp-failure.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
[ -n "$HELPER" ] && node "$HELPER" --telemetry --class auth --tool "$MCP_TOOL_NAME" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "$AUTH_ERROR" --recovered no
