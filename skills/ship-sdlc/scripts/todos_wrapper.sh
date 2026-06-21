#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SHIP_TODOS="$SDLC_ROOT/scripts/lib/ship-todos.js"
if [ ! -f "$SHIP_TODOS" ] && [ -f "$SDLC_ROOT/plugins/lift-sdlc/scripts/lib/ship-todos.js" ]; then
  SHIP_TODOS="$SDLC_ROOT/plugins/lift-sdlc/scripts/lib/ship-todos.js"
fi

if [ ! -f "$SHIP_TODOS" ]; then
  echo "ERROR: Could not locate scripts/lib/ship-todos.js" >&2
  exit 2
fi

node "$SHIP_TODOS" "$@"
