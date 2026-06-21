#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

LIB="$SDLC_ROOT/scripts/lib/openspec.js"
if [ ! -f "$LIB" ] && [ -f "$SDLC_ROOT/plugins/lift-sdlc/scripts/lib/openspec.js" ]; then
  LIB="$SDLC_ROOT/plugins/lift-sdlc/scripts/lib/openspec.js"
fi

if [ ! -f "$LIB" ]; then
  echo "ERROR: Could not locate scripts/lib/openspec.js" >&2
  exit 2
fi

CHANGE=""
REF=""
LINE=""
TITLE=""

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --change) CHANGE="$2"; shift ;;
    --ref) REF="$2"; shift ;;
    --line) LINE="$2"; shift ;;
    --title) TITLE="$2"; shift ;;
    *) echo "Unknown parameter passed: $1" >&2; exit 1 ;;
  esac
  shift
done

OPENSPEC_LIB="$LIB" \
OPENSPEC_CHANGE="$CHANGE" \
OPENSPEC_REF="$REF" \
OPENSPEC_LINE="$LINE" \
OPENSPEC_TITLE="$TITLE" \
node -e "
const { markTaskDone } = require(process.env.OPENSPEC_LIB);
const line = process.env.OPENSPEC_LINE ? Number(process.env.OPENSPEC_LINE) : undefined;
const r = markTaskDone(process.env.OPENSPEC_CHANGE, process.env.OPENSPEC_REF, { line, title: process.env.OPENSPEC_TITLE });
console.log(JSON.stringify(r));
"
