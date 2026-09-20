'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');

const { parseArgs, runParseWave, readStdin } = require('./parse-wave');

const SCRIPT = path.join(__dirname, 'parse-wave.js');

test('parseArgs: --dispatched-ids flag', () => {
  assert.deepEqual(
    parseArgs(['node', 'parse-wave.js', '--dispatched-ids', '["1","2"]']),
    { dispatchedIdsRaw: '["1","2"]', showHelp: false }
  );
});

test('parseArgs: no flags -> dispatchedIdsRaw is null', () => {
  assert.deepEqual(parseArgs(['node', 'parse-wave.js']), { dispatchedIdsRaw: null, showHelp: false });
});

test('parseArgs: --help sets showHelp', () => {
  assert.deepEqual(
    parseArgs(['node', 'parse-wave.js', '--help']),
    { dispatchedIdsRaw: null, showHelp: true }
  );
});

test('parseArgs: -h sets showHelp', () => {
  assert.deepEqual(
    parseArgs(['node', 'parse-wave.js', '-h']),
    { dispatchedIdsRaw: null, showHelp: true }
  );
});

test('runParseWave: success path — delegates to parseWaveSummary with parsed dispatched-ids array', () => {
  let calledWith = null;
  const parseWaveSummaryFn = (text, dispatched) => {
    calledWith = { text, dispatched };
    return { schemaOk: true, dispatched, returned: ['1', '2'], missingIds: [], extraIds: [], parsed: {}, violations: [], tokenFound: true };
  };

  const { json, exitCode } = runParseWave('WAVE_SUMMARY: {}', '["1","2"]', { parseWaveSummaryFn });

  assert.deepEqual(calledWith, { text: 'WAVE_SUMMARY: {}', dispatched: ['1', '2'] });
  assert.equal(exitCode, 0);
  assert.equal(json.schemaOk, true);
});

test('runParseWave: success path — no --dispatched-ids defaults to an empty array', () => {
  let calledWith = null;
  const parseWaveSummaryFn = (text, dispatched) => {
    calledWith = { text, dispatched };
    return { schemaOk: true, dispatched: [], returned: [], missingIds: [], extraIds: [], parsed: {}, violations: [], tokenFound: true };
  };

  const { exitCode } = runParseWave('WAVE_SUMMARY: {}', null, { parseWaveSummaryFn });

  assert.deepEqual(calledWith.dispatched, []);
  assert.equal(exitCode, 0);
});

test('runParseWave: error path — --dispatched-ids is not valid JSON', () => {
  const parseWaveSummaryFn = () => {
    throw new Error('should not be called');
  };

  const { json, exitCode } = runParseWave('WAVE_SUMMARY: {}', 'not-json', { parseWaveSummaryFn });

  assert.equal(exitCode, 1);
  assert.equal(json.schemaOk, false);
  assert.match(json.error, /not valid JSON/);
});

test('runParseWave: error path — --dispatched-ids is valid JSON but not an array', () => {
  const parseWaveSummaryFn = () => {
    throw new Error('should not be called');
  };

  const { json, exitCode } = runParseWave('WAVE_SUMMARY: {}', '{"a":1}', { parseWaveSummaryFn });

  assert.equal(exitCode, 1);
  assert.equal(json.schemaOk, false);
  assert.match(json.error, /must be a JSON array/);
});

// ---------------------------------------------------------------------------
// CLI integration — verifies stdin is read via process.stdin (not /dev/stdin)
// ---------------------------------------------------------------------------

test('CLI: reads wave-runner text from stdin and writes a JSON line to stdout', () => {
  const waveSummaryText = 'WAVE_SUMMARY: {"wave":1,"status":"completed","tasks":[{"id":"1","status":"DONE","filesTouched":[]}],"escalationsUsed":0}';

  const res = spawnSync(process.execPath, [SCRIPT, '--dispatched-ids', '["1"]'], {
    input: waveSummaryText,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.schemaOk, true);
  assert.equal(parsed.tokenFound, true);
  assert.deepEqual(parsed.missingIds, []);
});

test('CLI: exits 1 with a JSON error when --dispatched-ids is malformed', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--dispatched-ids', 'nope'], {
    input: 'WAVE_SUMMARY: {}',
    encoding: 'utf8',
  });

  assert.equal(res.status, 1);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.schemaOk, false);
});

// ---------------------------------------------------------------------------
// CLI --help fast-path — must exit without reading stdin. Uses async `spawn`
// (not `spawnSync`) and deliberately never writes to or ends `child.stdin`,
// so a regression that calls `readStdin()` before the `showHelp` check would
// hang the child forever; the race against a 5s timer turns that hang into a
// bounded test failure instead of a suite-wide hang.
// ---------------------------------------------------------------------------

function runHelpLeavingStdinOpen(flag) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, flag], { cwd: __dirname });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ timedOut: true, code: null, stdout });
    }, 5000);

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ timedOut: false, code, stdout });
    });
    // Intentionally never call child.stdin.end() — stdin is left open.
  });
}

test('CLI: --help prints Usage and exits 0 without reading stdin (stdin left open)', async () => {
  const res = await runHelpLeavingStdinOpen('--help');

  assert.equal(res.timedOut, false, 'process did not exit within 5s — showHelp is not checked before readStdin()');
  assert.equal(res.code, 0);
  assert.match(res.stdout, /^Usage:/);
});

test('CLI: -h prints Usage and exits 0 without reading stdin (stdin left open)', async () => {
  const res = await runHelpLeavingStdinOpen('-h');

  assert.equal(res.timedOut, false, 'process did not exit within 5s — showHelp is not checked before readStdin()');
  assert.equal(res.code, 0);
  assert.match(res.stdout, /^Usage:/);
});

// ---------------------------------------------------------------------------
// readStdin — listener hygiene
// ---------------------------------------------------------------------------

test('readStdin: removes its data/end/error listeners from the stream on settle', async () => {
  const stream = new PassThrough();
  const promise = readStdin(stream);
  stream.end('WAVE_SUMMARY: {}');
  const result = await promise;
  assert.equal(result, 'WAVE_SUMMARY: {}');
  assert.equal(stream.listenerCount('data'), 0);
  assert.equal(stream.listenerCount('end'), 0);
  assert.equal(stream.listenerCount('error'), 0);
});

test('CLI: exits 0 and prints usage on --help without waiting for stdin', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--help'], {
    encoding: 'utf8',
    timeout: 2000,
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage:/);
  assert.match(res.stdout, /--dispatched-ids/);
});

test('CLI: exits 0 and prints usage on -h without waiting for stdin', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '-h'], {
    encoding: 'utf8',
    timeout: 2000,
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage:/);
});

test('main: exits 1 when stdin.isTTY is true', async () => {
  const { main } = require('./parse-wave');
  let exitCode = null;
  let stderrOutput = '';
  await main([], {
    stdin: { isTTY: true },
    stdout: { write: () => {} },
    stderr: { write: (msg) => { stderrOutput += msg; } },
    exit: (code) => { exitCode = code; },
  });
  assert.equal(exitCode, 1);
  assert.match(stderrOutput, /expects input piped via stdin/);
});

