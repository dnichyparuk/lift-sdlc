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

NAME=""

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --change|--name) NAME="$2"; shift ;;
    *) echo "Unknown parameter passed: $1" >&2; exit 1 ;;
  esac
  shift
done

if [ -z "$NAME" ]; then
  echo "ERROR: --change or --name is required" >&2
  exit 1
fi

OPENSPEC_LIB="$LIB" \
OPENSPEC_TASKS_PATH="openspec/changes/$NAME/tasks.md" \
node -e "
const fs = require('fs');
const { parseTasks } = require(process.env.OPENSPEC_LIB);
if (!fs.existsSync(process.env.OPENSPEC_TASKS_PATH)) {
  console.error('ERROR: file does not exist: ' + process.env.OPENSPEC_TASKS_PATH);
  process.exit(1);
}
const content = fs.readFileSync(process.env.OPENSPEC_TASKS_PATH, 'utf8');
console.log(JSON.stringify(parseTasks(content)));
"
