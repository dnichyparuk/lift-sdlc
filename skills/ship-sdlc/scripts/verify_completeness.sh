#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

STATE_FILE=""
PLAN_FILE=""

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --state-file) STATE_FILE="$2"; shift ;;
    --plan-file) PLAN_FILE="$2"; shift ;;
    *) echo "Unknown parameter passed: $1" >&2; exit 1 ;;
  esac
  shift
done

if [ -z "$STATE_FILE" ] || [ -z "$PLAN_FILE" ]; then
  echo "ERROR: --state-file and --plan-file are required" >&2
  exit 1
fi

EXECUTE_STATE_SCRIPT="$SDLC_ROOT/scripts/state/execute.js"
if [ ! -f "$EXECUTE_STATE_SCRIPT" ] && [ -f "$SDLC_ROOT/plugins/lift-sdlc/scripts/state/execute.js" ]; then
  EXECUTE_STATE_SCRIPT="$SDLC_ROOT/plugins/lift-sdlc/scripts/state/execute.js"
fi

if [ ! -f "$EXECUTE_STATE_SCRIPT" ]; then
  echo "ERROR: Could not locate scripts/state/execute.js" >&2
  exit 2
fi

set +e
node "$EXECUTE_STATE_SCRIPT" verify-completeness
COMPLETENESS_EXIT=$?
set -e

if [ "$COMPLETENESS_EXIT" -ne 0 ]; then
  echo "ERROR: execute-plan-sdlc returned but planned tasks are unaccounted. Pipeline halted." >&2
  # Mark execute step failed and halt — do NOT advance to commit/review/version/pr
  "$SCRIPT_DIR/todos_wrapper.sh" --state-file "$STATE_FILE" --plan-file "$PLAN_FILE" --event execute --fail-step execute
  exit "$COMPLETENESS_EXIT"
fi
