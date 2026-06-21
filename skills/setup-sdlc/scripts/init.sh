#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

INIT_SCRIPT="$SDLC_ROOT/scripts/skill/setup-init.js"
[ ! -f "$INIT_SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/setup-init.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }

# Replace <PROJECT_CONFIG_JSON> and <LOCAL_CONFIG_JSON> with the actual config objects
# assembled from Steps 3a–3f. Only include sections that were configured (not skipped).
INIT_OUTPUT_FILE=$(node "$INIT_SCRIPT" --output-file --project-config '<PROJECT_CONFIG_JSON>' --local-config '<LOCAL_CONFIG_JSON>')
EXIT_CODE=$?

echo "INIT_OUTPUT_FILE: $INIT_OUTPUT_FILE"
echo "STATUS: $EXIT_CODE"