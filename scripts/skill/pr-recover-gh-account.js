#!/usr/bin/env node
/**
 * pr-recover-gh-account.js
 *
 * Post-failure gh-account-switch recovery helper for pr-sdlc Step 6 (issue #184).
 *
 * Purpose:
 *   When `gh pr create` fails with a "does not have the correct permissions
 *   to execute CreatePullRequest" error, this script decides whether the
 *   active gh account can be transparently switched to one that owns the
 *   target repo. Pure matching/decision logic lives in `lib/git.js`
 *   (`selectAccountForOwner`, `recoverGhAccountForRepo`, `isGhCreatePrPermissionError`).
 *   This script is a thin CLI wrapper.
 *
 * Inputs:
 *   --error-file <path>             Read stderr text from <path>. Required unless --error is passed.
 *   --error <string>                Inline error text (alternative to --error-file).
 *   --project-root <path>           Override project root (defaults to process.cwd()).
 *   --dry-run                       Skip the live `gh auth switch`; require --accounts-file and --owner.
 *   --accounts-file <path>          Read accounts JSON from file (used with --dry-run for hermetic tests).
 *                                   Format: [{"login":"alice","active":true}, ...]
 *   --fallback-accounts-file <path> Read fallback accounts JSON from file (used with --dry-run only).
 *                                   Injected as `opts.fallbackAccounts` so the github.com fallback branch
 *                                   in recoverGhAccountForRepo runs hermetically without a live gh call.
 *                                   Only relevant when --host is not "github.com" (if --host is "github.com",
 *                                   no fallback runs and this flag is ignored).
 *                                   Format: [{"login":"alice","active":false}, ...]
 *   --owner <login>                 Override repo owner detection (used with --dry-run).
 *   --host <host>                   Override remote host (used with --dry-run, default "github.com").
 *
 * Output:
 *   Single-line JSON to stdout. Exit code 0 on every documented branch
 *   (recovered or not). Exit code non-zero only on internal/IO error.
 *
 * Examples:
 *   echo "...permission error..." | node pr-recover-gh-account.js --error-file -
 *   node pr-recover-gh-account.js --dry-run --accounts-file ./accounts.json --owner Cleeng \
 *     --error "GraphQL: ... does not have the correct permissions to execute `CreatePullRequest`"
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { recoverGhAccountForRepo } = require('../lib/git');
const { writeJsonLine } = require('../lib/output');
const { resolveSdlcRoot } = require('../lib/config');

function parseArgs(argv) {
  const args = {
    errorFile: null,
    errorInline: null,
    // C-projectroot (#360): default to the main-worktree .sdlc/ root, not cwd.
    projectRoot: resolveSdlcRoot(),
    dryRun: false,
    accountsFile: null,
    fallbackAccountsFile: null,
    owner: null,
    host: 'github.com',
  };

  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--error-file':
        args.errorFile = next;
        i++;
        break;
      case '--error':
        args.errorInline = next;
        i++;
        break;
      case '--project-root':
        args.projectRoot = path.resolve(next);
        i++;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--accounts-file':
        args.accountsFile = next;
        i++;
        break;
      case '--fallback-accounts-file':
        args.fallbackAccountsFile = next;
        i++;
        break;
      case '--owner':
        args.owner = next;
        i++;
        break;
      case '--host':
        args.host = next;
        i++;
        break;
      default:
        // unknown flag — ignored to keep script forward-compatible
        break;
    }
  }
  return args;
}

function readErrorText(args) {
  if (typeof args.errorInline === 'string' && args.errorInline.length > 0) {
    return args.errorInline;
  }
  if (!args.errorFile) {
    throw new Error('Missing required input: --error or --error-file');
  }
  if (args.errorFile === '-') {
    // read all of stdin synchronously
    return fs.readFileSync(0, 'utf8');
  }
  return fs.readFileSync(args.errorFile, 'utf8');
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    process.stderr.write(`pr-recover-gh-account: arg parse error: ${e.message}\n`);
    process.exit(2);
  }

  let errorText;
  try {
    errorText = readErrorText(args);
  } catch (e) {
    process.stderr.write(`pr-recover-gh-account: ${e.message}\n`);
    process.exit(2);
  }

  const opts = {};
  if (args.dryRun) {
    opts.dryRun = true;
    if (!args.accountsFile || !args.owner) {
      process.stderr.write(
        'pr-recover-gh-account: --dry-run requires --accounts-file and --owner\n'
      );
      process.exit(2);
    }
    let accounts;
    try {
      accounts = JSON.parse(fs.readFileSync(args.accountsFile, 'utf8'));
    } catch (e) {
      process.stderr.write(
        `pr-recover-gh-account: could not read accounts file: ${e.message}\n`
      );
      process.exit(2);
    }
    if (!Array.isArray(accounts)) {
      process.stderr.write('pr-recover-gh-account: accounts file must contain a JSON array\n');
      process.exit(2);
    }
    opts.accounts = accounts;
    opts.remote = { host: args.host, owner: args.owner, repo: 'unknown' };

    if (args.fallbackAccountsFile) {
      let fallbackAccounts;
      try {
        fallbackAccounts = JSON.parse(fs.readFileSync(args.fallbackAccountsFile, 'utf8'));
      } catch (e) {
        process.stderr.write(
          `pr-recover-gh-account: could not read fallback accounts file: ${e.message}\n`
        );
        process.exit(2);
      }
      if (!Array.isArray(fallbackAccounts)) {
        process.stderr.write(
          'pr-recover-gh-account: fallback accounts file must contain a JSON array\n'
        );
        process.exit(2);
      }
      opts.fallbackAccounts = fallbackAccounts;
    }
  }

  const result = recoverGhAccountForRepo(args.projectRoot, errorText, opts);
  writeJsonLine(result);
}

main();
