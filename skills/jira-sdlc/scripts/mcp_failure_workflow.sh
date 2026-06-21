#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

HELPER="$SDLC_ROOT/scripts/skill/mcp-failure.js"
[ ! -f "$HELPER" ] && { echo "ERROR: Could not locate scripts/skill/mcp-failure.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
[ -n "$HELPER" ] && node "$HELPER" --telemetry --class workflow --tool "getTransitionsForJiraIssue" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "$TRANSITION_ERROR" --recovered no
[ -n "$HELPER" ] && ANALYZE_JSON=$(node "$HELPER" --analyze --class workflow --tool "getTransitionsForJiraIssue" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "$TRANSITION_ERROR" --recovered no --r-path R14)
