#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/skill/error-report-prepare.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/error-report-prepare.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }

ERROR_CONTEXT_FILE=$(node "$SCRIPT" \
  --skill "$SKILL_NAME" \
  --step "$STEP_NAME" \
  --operation "$OPERATION" \
  --error-text "$ERROR_TEXT" \
  --exit-or-http-code "$EXIT_OR_HTTP_CODE" \
  --error-type "$ERROR_TYPE" \
  --user-intent "$USER_INTENT" \
  --args-string "$ARGS_STRING" \
  --suggested-investigation "$SUGGESTED_INVESTIGATION" \
  --output-file)
EXIT_CODE=$?
# the manifest is removed even if the caller cancels or errors out before
# reaching the explicit cleanup branches.
