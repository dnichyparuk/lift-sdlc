#!/usr/bin/env node
/**
 * session-start.js
 * SessionStart hook — outputs plugin version, skill count, and project
 * context (pipeline resume, OpenSpec, git status, Jira cache, ship config)
 * into the system-reminder context.
 *
 * Lazy-loads ../scripts/lib/state.js and ../scripts/lib/git.js for project
 * context phases. Falls back gracefully if unavailable.
 *
 * Exit codes:
 *   0 = success (always — graceful degradation on errors)
 */

'use strict';

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { HOUR_MS, DAY_MS } = require('../scripts/lib/time-constants');

const pluginRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// SessionStart matcher source (Fixes #392 / R36)
// Stdin payload shape (Antigravity Code SessionStart hook): { hook_event_name: 'SessionStart', source: 'startup' | 'clear' | 'compact' | 'resume', ... }
// Source determines whether the execute-state line is emitted as the legacy
// `Active execution:` (byte-stable for startup/clear; protects prompt-cache)
// or as the new `Active execution (post-compact):` signal that execute-plan-sdlc
// Step 0 treats as implicit --resume.
// ---------------------------------------------------------------------------

let matcherSource = 'startup';
try {
  const stdinRaw = fs.readFileSync(0, 'utf8');
  if (stdinRaw) {
    const envelope = JSON.parse(stdinRaw);
    if (envelope && typeof envelope.source === 'string') {
      matcherSource = envelope.source;
    }
  }
} catch {
  // Stdin unreadable or non-JSON — keep default 'startup' (byte-stable
  // legacy emission); graceful degradation per advisory-only contract.
}

// ---------------------------------------------------------------------------
// Read plugin version
// ---------------------------------------------------------------------------

let version = 'unknown';
try {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8')
  );
  if (manifest.version) version = manifest.version;
} catch {
  // Graceful degradation — version stays 'unknown'
}

// ---------------------------------------------------------------------------
// Count user-invocable skills
// ---------------------------------------------------------------------------

let skillCount = 0;
const skillsDir = path.join(pluginRoot, 'skills');

try {
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
    try {
      const content = fs.readFileSync(skillPath, 'utf8');
      // Extract frontmatter between first and second ---
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch && /user-invocable:\s*true/.test(fmMatch[1])) {
        skillCount++;
      }
    } catch {
      // No SKILL.md in this subdirectory — skip
    }
  }
} catch {
  // skills directory unreadable — count stays 0
}

// ---------------------------------------------------------------------------
// Pipeline resume detection
// ---------------------------------------------------------------------------

const resumeLines = [];

try {
  const { slugifyBranch, findStateFile, readState } = require('../scripts/lib/state');
  const { exec } = require('../scripts/lib/git');
  const branch = exec('git branch --show-current');
  if (branch) {
    const branchSlug = slugifyBranch(branch);

    // Check for ship state file
    const shipFound = findStateFile('ship', branchSlug);
    if (shipFound) {
      const shipState = readState('ship', branchSlug);
      if (shipState && shipState.data && Array.isArray(shipState.data.steps)) {
        const steps = shipState.data.steps;
        const inProgress = steps.find(s => s.status === 'in_progress');
        const lastCompleted = [...steps].reverse().find(s => s.status === 'completed');
        const currentStep = inProgress || lastCompleted;
        if (currentStep) {
          const stepIndex = steps.indexOf(currentStep) + 1;
          const stepName = currentStep.name || currentStep.id || 'unknown';
          const label = inProgress ? `paused at step ${stepIndex}: ${stepName}` : `last completed step ${stepIndex}: ${stepName}`;
          resumeLines.push(`Active pipeline: ship-sdlc on ${branch} (${label})`);
          resumeLines.push('  Resume with: /ship-sdlc --resume');
        }
      }
    }

    // Check for execute state file
    const executeFound = findStateFile('execute', branchSlug);
    if (executeFound) {
      const executeState = readState('execute', branchSlug);
      if (executeState && executeState.data && Array.isArray(executeState.data.waves)) {
        const waves = executeState.data.waves;
        const completedWaves = waves.filter(w => w.status === 'completed').length;
        const totalWaves = waves.length;
        // Fixes #392 / R36: emit a distinct `Active execution (post-compact):`
        // line on compact matcher so execute-plan-sdlc Step 0 can treat it as
        // implicit --resume. The legacy `Active execution:` line is preserved
        // byte-stable for startup/clear/resume matchers — protects prompt-cache and
        // avoids breaking existing fast-path consumers (prompt-cache-hit-ratio
        // guardrail). The hook is layer-agnostic: when both ship and execute
        // states exist on compact, both lines are emitted; the consumer
        // (SKILL.md Step 0) discriminates (ship-sdlc owns recovery).
        if (matcherSource === 'compact') {
          resumeLines.push(`Active execution (post-compact): execute-plan-sdlc on ${branch} (wave ${completedWaves} of ${totalWaves} complete)`);
        } else {
          resumeLines.push(`Active execution: execute-plan-sdlc on ${branch} (wave ${completedWaves} of ${totalWaves} complete)`);
        }
        resumeLines.push('  Resume with: /execute-plan-sdlc --resume');
      }
    }
  }
} catch {
  // Graceful degradation — skip resume detection on any error
}

// ---------------------------------------------------------------------------
// Compact recovery (re-inject state after context compaction)
// ---------------------------------------------------------------------------

try {
  let recoveryDir;
  let branchSlug = null;
  let maxAgeMs;
  try {
    const stateLib = require('../scripts/lib/state');
    const { exec } = require('../scripts/lib/git');
    recoveryDir = stateLib.resolveStateDir();
    const branch = exec('git branch --show-current');
    if (branch) branchSlug = stateLib.slugifyBranch(branch);
    maxAgeMs = stateLib.COMPACT_RECOVERY_TTL_MS;
  } catch {
    // R-projectroot: main-worktree-rooted resolution (#360).
    const { resolveSdlcRoot } = require('../scripts/lib/config');
    recoveryDir = path.join(resolveSdlcRoot(), '.sdlc', 'execution');
    // Fallback when state lib is unreachable — match the canonical TTL.
    maxAgeMs = HOUR_MS;
  }
  // Defensive: if the lib returned something unexpected, fall back to 1h.
  if (typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    maxAgeMs = HOUR_MS;
  }

  // Per-branch recovery file (issue #256). Read only the file matching the
  // current branch — never scan-and-filter across branches. branchSlug is null
  // when not in a git repo or no current branch; in that case skip the read.
  let consumedRecoveryPath = null;
  if (branchSlug) {
    const recoveryPath = path.join(recoveryDir, `.compact-recovery-${branchSlug}.json`);
    if (fs.existsSync(recoveryPath)) {
      const raw = fs.readFileSync(recoveryPath, 'utf8');
      const recovery = JSON.parse(raw);

      const ageMs = Date.now() - new Date(recovery.savedAt).getTime();

      if (ageMs <= maxAgeMs) {
        resumeLines.push('Pipeline state recovered after compaction:');

        if (recovery.pipeline === 'ship-sdlc') {
          resumeLines.push(`  Pipeline: ship-sdlc on ${recovery.branch}`);
          if (recovery.currentStep) {
            resumeLines.push(`  Current step: ${recovery.currentStep}`);
          }
          if (recovery.reviewVerdict) {
            const findings = recovery.deferredFindings
              ? ` (${recovery.deferredFindings} deferred)`
              : '';
            resumeLines.push(`  Review verdict: ${recovery.reviewVerdict}${findings}`);
          }
        } else if (recovery.pipeline === 'execute-plan-sdlc') {
          resumeLines.push(`  Pipeline: execute-plan-sdlc on ${recovery.branch}`);
          resumeLines.push(`  Progress: wave ${recovery.completedWaves} of ${recovery.totalWaves} complete`);
        }
      }

      // Delete after reading — single-use
      fs.unlinkSync(recoveryPath);
      consumedRecoveryPath = recoveryPath;
    }
  }

  // Stale-sweep pass: remove `.compact-recovery-*.json` files older than 24h
  // (issue #334). These are orphaned files left by sessions where the single-use
  // unlink never fired (JSON parse error, permission failure, session kill, etc.).
  // The sweep threshold (24h) is an order of magnitude beyond the freshness gate
  // (1h), so the sweep cannot delete a file the consume path above would still want.
  const staleThresholdMs = DAY_MS;
  try {
    const sweepEntries = fs.readdirSync(recoveryDir);
    for (const entry of sweepEntries) {
      // Only target per-branch compact-recovery files
      if (!/^\.compact-recovery-.+\.json$/.test(entry)) continue;
      const entryPath = path.join(recoveryDir, entry);
      // Skip the file we just consumed above — avoid double-unlink
      if (entryPath === consumedRecoveryPath) continue;
      try {
        const stat = fs.statSync(entryPath);
        if (Date.now() - stat.mtimeMs > staleThresholdMs) {
          fs.unlinkSync(entryPath);
        }
      } catch (sweepErr) {
        console.error('[sdlc/session-start] stale compact-recovery sweep error:', sweepErr.message);
      }
    }
  } catch (sweepErr) {
    console.error('[sdlc/session-start] stale compact-recovery sweep error:', sweepErr.message);
  }

  // Legacy `.compact-recovery.json` (no branch suffix, pre-#256 layout).
  // Unlink ONLY when older than the freshness gate to avoid destroying a
  // fresh file written by an even-older plugin version on a concurrent
  // session. Never re-inject — that ship has sailed.
  const legacyPath = path.join(recoveryDir, '.compact-recovery.json');
  if (fs.existsSync(legacyPath)) {
    try {
      const stat = fs.statSync(legacyPath);
      if (Date.now() - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(legacyPath);
      }
    } catch (legacyErr) {
      console.error('[sdlc/session-start] legacy compact-recovery cleanup error:', legacyErr.message);
    }
  }
} catch (err) {
  // Graceful degradation — skip compact recovery on any error
  console.error('[sdlc/session-start] compact-recovery consumption failed:', err.message);
}

// ---------------------------------------------------------------------------
// OpenSpec context injection
// ---------------------------------------------------------------------------

try {
  // R-projectroot: main-worktree-rooted resolution (#360).
  const { resolveSdlcRoot } = require('../scripts/lib/config');
  const projectRoot = resolveSdlcRoot();
  const { detectActiveChanges, STAGE_LABELS } = require('../scripts/lib/openspec');
  const openspec = detectActiveChanges(projectRoot);

  if (!openspec.present) {
    // No openspec/config.yaml — skip
  } else if (openspec.activeChanges.length === 0) {
    const specPlural = openspec.specsCount !== 1 ? 's' : '';
    resumeLines.push(`OpenSpec: INITIALIZED — verified via openspec/config.yaml (${openspec.specsCount} spec${specPlural}, 0 active changes)`);
  } else if (openspec.activeChanges.length === 1) {
    const change = openspec.activeChanges[0];
    const stageLabel = typeof STAGE_LABELS[change.stage] === 'function'
      ? STAGE_LABELS[change.stage](change)
      : STAGE_LABELS[change.stage];
    const specLabel = `${change.deltaSpecCount} delta spec${change.deltaSpecCount !== 1 ? 's' : ''}`;
    const specPlural = openspec.specsCount !== 1 ? 's' : '';
    resumeLines.push(`OpenSpec: INITIALIZED (openspec/config.yaml, ${openspec.specsCount} spec${specPlural}) · active: change "${change.name}" (${stageLabel}, ${specLabel})`);

    // Branch match (from shared module)
    if (openspec.branchMatch === change.name) {
      try {
        const { exec } = require('../scripts/lib/git');
        const branch = exec('git branch --show-current');
        if (branch) {
          resumeLines.push(`  Branch match: ${branch} -> auto-linked`);
        }
      } catch {
        // Graceful degradation — skip branch display
      }
    }

    // Stage-aware SDLC suggestions
    switch (change.stage) {
      case 'spec-in-progress':
        resumeLines.push('  Continue spec: /opsx:continue or /opsx:ff');
        break;
      case 'ready-for-plan':
        resumeLines.push(`  Plan with: /plan-sdlc --from-openspec ${change.name}`);
        resumeLines.push('  Or full pipeline: /ship-sdlc (after planning)');
        break;
      case 'implementation-in-progress':
        resumeLines.push('  Continue: /opsx:apply');
        resumeLines.push('  Or commit progress: /commit-sdlc');
        break;
      case 'tasks-complete':
        resumeLines.push('  Ship: /ship-sdlc (commit -> review -> PR)');
        resumeLines.push('  Verify first: /opsx:verify');
        break;
    }
  } else {
    const names = openspec.activeChanges.map(c => c.name).join(', ');
    const specPlural = openspec.specsCount !== 1 ? 's' : '';
    resumeLines.push(`OpenSpec: INITIALIZED (openspec/config.yaml, ${openspec.specsCount} spec${specPlural}) · active: ${openspec.activeChanges.length} changes (${names})`);
    resumeLines.push('  Pass --spec or --from-openspec <name> to select');
  }
} catch {
  // Graceful degradation — skip OpenSpec context injection on any error
}

// ---------------------------------------------------------------------------
// Git context (Phase 1c)
// ---------------------------------------------------------------------------

try {
  const { checkGitState, detectBaseBranch, exec } = require('../scripts/lib/git');
  // KEEP: pure git op — do not change to resolveSdlcRoot()
  const projectRoot = process.cwd();
  const gitState = checkGitState(projectRoot);
  const { currentBranch, dirtyFiles } = gitState;

  const dirtyCount = dirtyFiles.length;
  const dirtyLabel = dirtyCount > 0 ? `${dirtyCount} file${dirtyCount !== 1 ? 's' : ''} modified` : 'clean';

  let aheadLabel = null;
  try {
    const baseBranch = detectBaseBranch(projectRoot);
    const aheadRaw = exec(`git rev-list --count origin/${baseBranch}..HEAD`, { cwd: projectRoot });
    if (aheadRaw !== null) {
      const aheadCount = parseInt(aheadRaw, 10);
      if (!isNaN(aheadCount) && aheadCount > 0) {
        aheadLabel = `ahead of ${baseBranch} by ${aheadCount}`;
      }
    }
  } catch {
    // Graceful degradation — omit ahead count if base branch detection fails
  }

  const statusParts = [dirtyLabel];
  if (aheadLabel) statusParts.push(aheadLabel);
  resumeLines.push(`Git: branch ${currentBranch} (${statusParts.join(', ')}) [snapshot]`);
} catch {
  // Graceful degradation — skip git context on any error
}

// ---------------------------------------------------------------------------
// Jira cache (Phase 1d)
// ---------------------------------------------------------------------------

try {
  // Home-cache layout: ~/.sdlc-cache/jira/<sanitizedSiteHost>/<PROJECT_KEY>.json
  const homeRoot = path.join(os.homedir(), '.sdlc-cache', 'jira');
  const entries = [];
  if (fs.existsSync(homeRoot)) {
    let siteDirs;
    try {
      siteDirs = fs.readdirSync(homeRoot, { withFileTypes: true });
    } catch {
      siteDirs = [];
    }
    for (const siteEntry of siteDirs) {
      if (!siteEntry.isDirectory()) continue;
      const siteDir = path.join(homeRoot, siteEntry.name);
      let cacheFiles;
      try {
        cacheFiles = fs.readdirSync(siteDir).filter(f => f.endsWith('.json'));
      } catch {
        continue;
      }
      for (const cacheFile of cacheFiles) {
        const projectKey = path.basename(cacheFile, '.json');
        const fullPath = path.join(siteDir, cacheFile);
        try {
          const cacheData = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          entries.push({
            projectKey,
            site:        siteEntry.name,
            lastUpdated: cacheData.lastUpdated,
            maxAgeHours: cacheData.maxAgeHours,
          });
        } catch {
          // Graceful degradation — skip this cache file on parse error
        }
      }
    }
  }

  for (const entry of entries) {
    const { projectKey, site, lastUpdated, maxAgeHours } = entry;
    if (!lastUpdated) continue;

    const ageMs = Date.now() - new Date(lastUpdated).getTime();
    const ageHours = ageMs / HOUR_MS;

    let ageDisplay;
    if (ageHours < 1) {
      ageDisplay = 'less than 1h ago';
    } else if (ageHours < 24) {
      const h = Math.round(ageHours);
      ageDisplay = `${h}h ago`;
    } else {
      const d = Math.round(ageHours / 24);
      ageDisplay = `${d} day${d !== 1 ? 's' : ''} ago`;
    }

    const label = `${projectKey}@${site}`;
    if (maxAgeHours === 0) {
      resumeLines.push(`Jira cache: ${label} (last updated ${ageDisplay}, permanent)`);
    } else if (ageHours > maxAgeHours) {
      resumeLines.push(`Jira cache: ${label} (stale — ${ageDisplay}, TTL ${maxAgeHours}h) — refresh with /jira-sdlc --force-refresh`);
    } else {
      resumeLines.push(`Jira cache: ${label} (last updated ${ageDisplay}, TTL ${maxAgeHours}h)`);
    }
  }
} catch {
  // Graceful degradation — skip Jira cache detection on any error
}

// ---------------------------------------------------------------------------
// Ship config (Phase 1e)
// ---------------------------------------------------------------------------

try {
  const { readSection, normalizePreset, resolveSdlcRoot } = require(path.join(__dirname, '..', 'scripts', 'lib', 'config.js'));
  // R-projectroot: main-worktree-rooted resolution (#360).
  const projectRoot = resolveSdlcRoot();
  const shipConfig = readSection(projectRoot, 'ship');
  if (shipConfig) {
    // Note: steps[] is the v2 canonical field. preset/skip are legacy v1
    // fields and only appear here when readSection returns a non-migrated
    // raw config (shouldn't happen on a v2-migrated read, but kept for
    // defensive backward compatibility).
    const steps     = Array.isArray(shipConfig.steps) ? `steps ${JSON.stringify(shipConfig.steps)}` : null;
    const preset    = shipConfig.preset    !== undefined ? `preset ${normalizePreset(shipConfig.preset)}` : null;
    const skip      = shipConfig.skip      !== undefined ? `skip ${JSON.stringify(shipConfig.skip)}` : null;
    const bump      = shipConfig.bump      !== undefined ? `bump ${shipConfig.bump}` : null;
    const threshold = shipConfig.reviewThreshold !== undefined ? `threshold ${shipConfig.reviewThreshold}` : null;
    const parts = [steps, preset, skip, bump, threshold].filter(Boolean);
    if (parts.length > 0) {
      resumeLines.push(`Ship config: ${parts.join(', ')}`);
    }
  }
} catch {
  // Graceful degradation — skip ship config on any error
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const outputLines = [
  `sdlc: v${version} (${skillCount} skills loaded)`,
  'Plan mode routing: always invoke plan-sdlc via the Skill tool when plan mode is active.',
  ...resumeLines,
];

process.stdout.write(JSON.stringify({
  injectSteps: [
    { type: 'ephemeralMessage', content: outputLines.join('\n') }
  ]
}) + '\n');
