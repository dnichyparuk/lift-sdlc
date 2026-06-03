#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SDLC_LIB="$SDLC_ROOT/scripts/lib"

if [ ! -f "$SDLC_LIB/config.js" ]; then
  echo '{"status": "error", "error": "Could not locate scripts/lib/config.js"}'
  exit 2
fi

WORKSPACE_MODE_FLAG=""
PREPARE_OUTPUT_FILE=""
LOGICAL_TYPE=""
DERIVED_SLUG=""

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --workspace-flag) WORKSPACE_MODE_FLAG="$2"; shift ;;
    --prepare-output-file) PREPARE_OUTPUT_FILE="$2"; shift ;;
    --logical-type) LOGICAL_TYPE="$2"; shift ;;
    --derived-slug) DERIVED_SLUG="$2"; shift ;;
    *) echo "Unknown parameter passed: $1" >&2; exit 1 ;;
  esac
  shift
done

# 1. Resolve workspace mode
if [ -z "$WORKSPACE_MODE_FLAG" ]; then
  WORKSPACE_MODE=$(node -e "
    const {readSection,resolveSdlcRoot}=require('$SDLC_LIB/config');
    const ws=readSection(resolveSdlcRoot(),'workspace')||{};
    process.stdout.write(ws.mode||'');
  ")
else
  WORKSPACE_MODE="$WORKSPACE_MODE_FLAG"
fi

if [ -z "$WORKSPACE_MODE" ]; then
  echo '{"status": "error", "error": "Workspace mode not set. Pass --workspace-flag branch|worktree|continue or set workspace.mode in .sdlc/local.json."}'
  exit 1
fi

# 2. Default-branch guard
DEFAULT_BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
[ -z "$DEFAULT_BRANCH" ] && DEFAULT_BRANCH="main"
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" = "$DEFAULT_BRANCH" ] && [ "$WORKSPACE_MODE" = "continue" ]; then
  echo "{\"status\": \"error\", \"error\": \"Cannot ship on default branch '$DEFAULT_BRANCH'. Pass --workspace-flag branch or --workspace-flag worktree.\"}"
  exit 1
fi

# 3. Cwd assertion
if [ -n "$PREPARE_OUTPUT_FILE" ] && [ -f "$PREPARE_OUTPUT_FILE" ]; then
  REQUIRE_MAIN_CWD=$(F="$PREPARE_OUTPUT_FILE" node -e "const d=JSON.parse(require('fs').readFileSync(process.env.F,'utf8'));process.stdout.write(String((d.assertions&&d.assertions.requireMainWorktreeCwd)===true))")
  EXPECTED_ROOT=$(F="$PREPARE_OUTPUT_FILE" node -e "const d=JSON.parse(require('fs').readFileSync(process.env.F,'utf8'));process.stdout.write((d.assertions&&d.assertions.expectedMainWorktreeRoot)||'')")
  
  if [ "$REQUIRE_MAIN_CWD" = "true" ] && [ -n "$EXPECTED_ROOT" ]; then
    ACTUAL_CWD=$(git rev-parse --show-toplevel 2>/dev/null)
    if [ "$ACTUAL_CWD" != "$EXPECTED_ROOT" ]; then
      echo "{\"status\": \"error\", \"error\": \"ship-sdlc cwd assertion failed. actual cwd: $ACTUAL_CWD, expected root: $EXPECTED_ROOT. ship.workspace: $WORKSPACE_MODE.\"}"
      exit 1
    fi
  fi
fi

# 4. Resolve branch name
EXECUTE_BRANCH=$(LOGICAL_TYPE="$LOGICAL_TYPE" DERIVED_SLUG="$DERIVED_SLUG" node -e "
  const {resolveBranchName}=require('$SDLC_LIB/branch-name');
  const {readSection,resolveSdlcRoot}=require('$SDLC_LIB/config');
  const cfg=(readSection(resolveSdlcRoot(),'workspace')||{}).branch||{};
  process.stdout.write(resolveBranchName({
    type: process.env.LOGICAL_TYPE || 'feature',
    slug: process.env.DERIVED_SLUG || 'feature-branch',
    config: cfg
  }));
")

# 5. Pre-execute ship state migration
STATE_SCRIPT="$SDLC_ROOT/scripts/state/ship.js"
if [ ! -f "$STATE_SCRIPT" ] && [ -f "$SDLC_ROOT/plugins/sdlc-utilities/scripts/state/ship.js" ]; then
  STATE_SCRIPT="$SDLC_ROOT/plugins/sdlc-utilities/scripts/state/ship.js"
fi

if [ -f "$STATE_SCRIPT" ]; then
  STATE_BRANCH=$(node "$STATE_SCRIPT" read 2>/dev/null | node -e "process.stdin.on('data',d=>{try{process.stdout.write(JSON.parse(d).branch||'')}catch(_){}})" || true)
  if [ -n "$STATE_BRANCH" ] && [ "$EXECUTE_BRANCH" != "$STATE_BRANCH" ]; then
    FROM_SLUG=$(echo "$STATE_BRANCH" | sed 's|[^a-zA-Z0-9-]|-|g')
    # Run migration and ignore error/output or print to stderr
    node "$STATE_SCRIPT" migrate --from "$FROM_SLUG" --to "$EXECUTE_BRANCH" >/dev/null 2>&1 || true
  fi
fi

# 6. Branch/worktree creation
WORKTREE_PATH=""
if [ "$WORKSPACE_MODE" = "branch" ]; then
  git checkout "$EXECUTE_BRANCH" >/dev/null 2>&1 || git checkout -b "$EXECUTE_BRANCH" >/dev/null 2>&1
elif [ "$WORKSPACE_MODE" = "worktree" ]; then
  WORKTREE_CREATE_SCRIPT="$SDLC_ROOT/scripts/util/worktree-create.js"
  if [ ! -f "$WORKTREE_CREATE_SCRIPT" ] && [ -f "$SDLC_ROOT/plugins/sdlc-utilities/scripts/util/worktree-create.js" ]; then
    WORKTREE_CREATE_SCRIPT="$SDLC_ROOT/plugins/sdlc-utilities/scripts/util/worktree-create.js"
  fi
  if [ ! -f "$WORKTREE_CREATE_SCRIPT" ]; then
    echo '{"status": "error", "error": "Could not locate scripts/util/worktree-create.js"}'
    exit 2
  fi
  result=$(node "$WORKTREE_CREATE_SCRIPT" --name "$EXECUTE_BRANCH" 2>/dev/null || true)
  if [ -n "$result" ]; then
    WORKTREE_PATH=$(echo "$result" | node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).path||'')}catch(_){}")
    EXECUTE_BRANCH=$(echo "$result" | node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).branch||'')}catch(_){}")
  fi
fi

echo "{\"status\": \"success\", \"workspaceMode\": \"$WORKSPACE_MODE\", \"executeBranch\": \"$EXECUTE_BRANCH\", \"worktreePath\": \"$WORKTREE_PATH\"}"
