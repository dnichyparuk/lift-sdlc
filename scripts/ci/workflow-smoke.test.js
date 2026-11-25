'use strict';

/**
 * workflow-smoke.test.js
 * Hermetic, offline smoke tests for all 4 Antigravity Python workflows:
 *   - skills/ship-sdlc/workflows/ship.py
 *   - skills/execute-plan-sdlc/workflows/execute.py
 *   - skills/review-sdlc/workflows/review.py
 *   - skills/received-review-sdlc/workflows/verify.py
 *
 * Verifies:
 *   1. `python3 -m py_compile` succeeds on all 4 workflow files (and cleans `__pycache__`).
 *   2. Deterministic helper functions (`_parse_run_command_output`, `run_cmd` with mocked
 *      `call_tool("run_command", ...)`, `initial_model_for_task`, `_resolve_sub_dispatch_model`,
 *      `to_agy_model`, `group_threads_by_file`, `model_for_group`, `_compute_verdict`)
 *      behave deterministically offline with mocked `call_tool` / `agent` / `args`.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const WORKFLOW_FILES = [
  'skills/ship-sdlc/workflows/ship.py',
  'skills/execute-plan-sdlc/workflows/execute.py',
  'skills/review-sdlc/workflows/review.py',
  'skills/received-review-sdlc/workflows/verify.py',
];

function cleanPycache(relFiles) {
  for (const rel of relFiles) {
    const pycacheDir = path.join(REPO_ROOT, path.dirname(rel), '__pycache__');
    if (fs.existsSync(pycacheDir)) {
      fs.rmSync(pycacheDir, { recursive: true, force: true });
    }
  }
}

describe('workflow-smoke (all 4 Python workflows)', () => {
  it('python3 -m py_compile passes on all 4 workflows and cleans __pycache__', () => {
    const absFiles = WORKFLOW_FILES.map((rel) => path.join(REPO_ROOT, rel));
    try {
      const res = spawnSync('python3', ['-m', 'py_compile', ...absFiles], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(
        res.status,
        0,
        `py_compile failed (exit ${res.status}):\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
      );
    } finally {
      cleanPycache(WORKFLOW_FILES);
    }
  });

  it('Python harness validates mocked call_tool("run_command", ...), agent(), and helpers across all 4 workflows', () => {
    const pyScript = `
import asyncio
import inspect
import json
import subprocess
import sys
import tempfile
from pathlib import Path

repo_root = Path(sys.argv[1])
workflow_paths = {
    "ship": repo_root / "skills/ship-sdlc/workflows/ship.py",
    "execute": repo_root / "skills/execute-plan-sdlc/workflows/execute.py",
    "review": repo_root / "skills/review-sdlc/workflows/review.py",
    "verify": repo_root / "skills/received-review-sdlc/workflows/verify.py",
}

def load_workflow(path, extra_globals=None):
    ns = {
        "__name__": "__workflow_smoke__",
        "__file__": str(path),
        "args": {},
        "log": lambda *parts: None,
        "phase": lambda name: None,
    }
    if extra_globals:
        ns.update(extra_globals)
    code = path.read_text(encoding="utf-8")
    exec(compile(code, str(path), "exec"), ns)
    return ns

async def run_checks():
    # 1. Verify _parse_run_command_output and mocked run_cmd across all 4 workflows
    for name, wf_path in workflow_paths.items():
        calls = []

        async def mock_call_tool(tool_name, **kwargs):
            calls.append((tool_name, kwargs))
            cmd = kwargs.get("CommandLine", "")
            if cmd == "bg-slow":
                return "Tool is running as a background task (task_id=abc123)."
            if cmd == "fail-cmd":
                return "Command exited with code 2.\\nCommand output:\\nboom error\\n"
            return "Command exited with code 0.\\nCommand output:\\nok-payload\\n"

        ns = load_workflow(wf_path, {"call_tool": mock_call_tool})

        rc, out, err = ns["_parse_run_command_output"]("Command exited with code 0.\\nCommand output:\\nhello\\nworld\\n")
        assert rc == 0 and out == "hello\\nworld" and err == "", f"{name}: ok parse failed: {(rc, out, err)}"

        rc, out, err = ns["_parse_run_command_output"]("Command exited with code 1.\\nCommand output:\\nfail text")
        assert rc == 1 and out == "fail text", f"{name}: nonzero parse failed: {(rc, out, err)}"

        rc, out, err = ns["_parse_run_command_output"]("Tool is running as a background task (id=42)")
        assert rc == 124 and "background task" in out and "WaitMsBeforeAsync" in err, f"{name}: bg parse failed: {(rc, out, err)}"

        # Exercise async run_cmd via mocked call_tool("run_command", ...)
        rc, out, err = await ns["run_cmd"]("echo ok", summary="smoke ok")
        assert rc == 0 and out == "ok-payload", f"{name}: run_cmd ok failed: {(rc, out, err)}"

        rc, out, err = await ns["run_cmd"]("fail-cmd", summary="smoke fail")
        assert rc == 2 and out == "boom error", f"{name}: run_cmd fail failed: {(rc, out, err)}"

        rc, out, err = await ns["run_cmd"]("bg-slow", summary="smoke bg")
        assert rc == 124 and "background task" in out, f"{name}: run_cmd bg failed: {(rc, out, err)}"

        assert len(calls) == 3 and all(c[0] == "run_command" for c in calls), f"{name}: unexpected call_tool calls: {calls}"

    # 2. execute.py helper checks
    ex_ns = load_workflow(workflow_paths["execute"])
    init_model = ex_ns["initial_model_for_task"]
    assert init_model({"risk": "High", "complexity": "Trivial"}, "balanced") == "pro"
    assert init_model({"risk": "Low", "complexity": "Trivial"}, "balanced") == "flash"
    assert init_model({"risk": "Low", "complexity": "Standard"}, "balanced", "inherit") == "inherit"
    assert init_model({"risk": "Low", "complexity": "Standard"}, "minimal") == "flash"
    assert init_model({"risk": "Low", "complexity": "Standard"}, "full") == "pro"
    assert ex_ns["next_escalated_model"]("flash_lite") == "flash"
    assert ex_ns["next_escalated_model"]("flash") == "pro"
    assert ex_ns["next_escalated_model"]("pro") == "pro"

    sample_plan = (
        "# Demo Plan\\n\\n"
        "### Task 1: First\\n**Complexity:** Trivial\\n**Risk:** Low\\n**Depends on:** none\\n"
        "**Files:**\\n- Create: \`a.js\`\\n\\n"
        "### Task 2: Second\\n**Complexity:** Standard\\n**Risk:** Low\\n**Depends on:** Task 1\\n"
        "**Files:**\\n- Modify: \`a.js\`\\n"
    )
    tasks, _ = ex_ns["parse_plan_markdown"](sample_plan, str(repo_root))
    waves = ex_ns["schedule_waves"](tasks)
    assert len(tasks) == 2 and len(waves) == 2, f"execute.py wave scheduling failed: {waves}"

    # 3. ship.py helper checks
    sh_ns = load_workflow(workflow_paths["ship"])
    assert sh_ns["to_agy_model"]("gemini-4-hydrogen-low") == "flash_lite"
    assert sh_ns["to_agy_model"]("gemini-4-hydrogen-medium") == "flash"
    assert sh_ns["to_agy_model"]("gemini-4-neon-medium") == "pro"
    assert sh_ns["to_agy_model"]("inherit") == "inherit"
    assert sh_ns["to_agy_model"]("") == "inherit"

    step_meta = {
        "loop": {
            "subDispatch": [
                {"skill": "verify-pipeline-sdlc", "model": "gemini-4-neon-medium"},
                {"skill": "commit-sdlc", "agyModel": "flash"},
            ]
        }
    }
    assert sh_ns["_resolve_sub_dispatch_model"](step_meta, "verify-pipeline-sdlc") == "pro"
    assert sh_ns["_resolve_sub_dispatch_model"](step_meta, "commit-sdlc") == "flash"
    assert sh_ns["_resolve_sub_dispatch_model"](step_meta, "unknown-skill", fallback="flash_lite") == "flash_lite"

    # 4. review.py helper + mocked agent() end-to-end check
    with tempfile.TemporaryDirectory() as tmpdir:
        diff_file = Path(tmpdir) / "security.diff"
        diff_file.write_text("+console.log('ok')\\n", encoding="utf-8")
        manifest_file = Path(tmpdir) / "manifest.json"
        manifest_file.write_text(json.dumps({
            "scope": "branch",
            "diff_dir": tmpdir,
            "current_branch": "feat/smoke",
            "plugin_version": "0.27.2",
            "dimensions": [
                {
                    "name": "security",
                    "status": "ACTIVE",
                    "severity": "high",
                    "model": "gemini-4-argon-low",
                    "matched_files": ["a.js"],
                    "diff_file": str(diff_file),
                }
            ],
        }), encoding="utf-8")

        agent_calls = []

        async def mock_review_agent(**kwargs):
            agent_calls.append(kwargs)
            if kwargs.get("role") == "Consolidate review findings":
                return {
                    "assessment": "Clean smoke diff.",
                    "dimensions": [{"name": "security", "findings": []}],
                }
            return {"no_findings": True, "findings": [], "notes": None}

        rev_ns = load_workflow(workflow_paths["review"], {
            "args": {"manifest_file": str(manifest_file), "cwd": tmpdir},
            "agent": mock_review_agent,
        })
        assert rev_ns["to_agy_model"]("gemini-3.8-flash-low") == "flash_lite"
        assert rev_ns["to_agy_model"]("gemini-4-argon-low") == "pro"
        assert rev_ns["_compute_verdict"]({"critical": 1, "high": 0, "medium": 0, "low": 0, "info": 0}) == "CHANGES REQUESTED"
        assert rev_ns["_compute_verdict"]({"critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0}) == "APPROVED"

        rev_res = await rev_ns["main"]()
        assert rev_res["status"] == "completed" and rev_res["verdict"] == "APPROVED"
        assert len(agent_calls) == 2 and agent_calls[0]["model"] == "pro"
        assert Path(rev_res["comment_file"]).is_file()

    # 5. verify.py helper + mocked agent() end-to-end check
    with tempfile.TemporaryDirectory() as tmpdir:
        manifest_file = Path(tmpdir) / "threads.json"
        manifest_file.write_text(json.dumps({
            "pr": {"number": 42},
            "threads": [
                {
                    "id": "T1",
                    "status": "outstanding",
                    "path": "src/app.js",
                    "line": 10,
                    "severity": "high",
                    "firstComment": {"body": "Potential null deref"},
                }
            ],
        }), encoding="utf-8")

        async def mock_verify_agent(**kwargs):
            assert kwargs["model"] == "pro"
            return {
                "findings": [
                    {
                        "id": "T1",
                        "verificationStatus": "confirmed",
                        "evidence": ["src/app.js:10"],
                        "rippleEffects": [],
                        "reasoning": "Verified null deref",
                        "detail": "Full detail",
                    }
                ]
            }

        ver_ns = load_workflow(workflow_paths["verify"], {
            "args": {"manifest_file": str(manifest_file), "cwd": tmpdir},
            "agent": mock_verify_agent,
        })
        assert ver_ns["model_for_group"]([{"severity": "high"}]) == "pro"
        assert ver_ns["model_for_group"]([{"severity": "low"}]) == "flash"
        assert len(ver_ns["group_threads_by_file"]([{"path": "a.js"}] * 5)) == 2

        ver_res = await ver_ns["main"]()
        assert ver_res["status"] == "completed" and len(ver_res["findings"]) == 1
        assert ver_res["findings"][0]["id"] == "T1"
        assert Path(ver_res["reportFile"]).is_file()

    # 6. Reusable coroutine exports & namespace-isolated exec() (Phase 2 Task 5)
    assert inspect.iscoroutinefunction(ex_ns["run_execute"]), "execute.py must export async def run_execute"
    assert inspect.iscoroutinefunction(rev_ns["run_review"]), "review.py must export async def run_review"
    assert inspect.iscoroutinefunction(ver_ns["run_verify"]), "verify.py must export async def run_verify"

    # Namespace-isolated invocation with poisoned globals["args"] to verify isolation
    with tempfile.TemporaryDirectory() as tmpdir:
        diff_file = Path(tmpdir) / "quality.diff"
        diff_file.write_text("+const x = 1;\\n", encoding="utf-8")
        rev_manifest = Path(tmpdir) / "rev-manifest.json"
        rev_manifest.write_text(json.dumps({
            "scope": "working",
            "diff_dir": tmpdir,
            "current_branch": "feat/iso",
            "plugin_version": "0.27.2",
            "dimensions": [
                {
                    "name": "quality",
                    "status": "ACTIVE",
                    "severity": "medium",
                    "matched_files": ["x.js"],
                    "diff_file": str(diff_file),
                }
            ],
        }), encoding="utf-8")
        ver_manifest = Path(tmpdir) / "ver-manifest.json"
        ver_manifest.write_text(json.dumps({
            "pr": {"number": 99},
            "threads": [
                {
                    "id": "TR1",
                    "status": "outstanding",
                    "path": "x.js",
                    "line": 1,
                    "severity": "low",
                    "firstComment": {"body": "Nit"},
                }
            ],
        }), encoding="utf-8")

        async def mock_iso_review_agent(**kwargs):
            if kwargs.get("role") == "Consolidate review findings":
                return {"assessment": "Clean.", "dimensions": [{"name": "quality", "findings": []}]}
            return {"no_findings": True, "findings": [], "notes": None}

        async def mock_iso_verify_agent(**kwargs):
            assert kwargs["model"] == "flash"
            return {
                "findings": [
                    {
                        "id": "TR1",
                        "verificationStatus": "incorrect",
                        "evidence": ["x.js:1"],
                        "rippleEffects": [],
                        "reasoning": "False positive",
                    }
                ]
            }

        iso_rev_ns = load_workflow(workflow_paths["review"], {
            "args": {"manifest_file": "/nonexistent-poison.json", "cwd": "/nonexistent"},
            "agent": mock_iso_review_agent,
        })
        iso_rev_res = await iso_rev_ns["run_review"](
            wf_args={"manifest_file": str(rev_manifest)},
            cwd=tmpdir,
            plugin_root=str(repo_root),
        )
        assert iso_rev_res["status"] == "completed" and iso_rev_res["verdict"] == "APPROVED"

        iso_ver_ns = load_workflow(workflow_paths["verify"], {
            "args": {"manifest_file": "/nonexistent-poison.json", "cwd": "/nonexistent"},
            "agent": mock_iso_verify_agent,
        })
        iso_ver_res = await iso_ver_ns["run_verify"](
            wf_args={"manifest_file": str(ver_manifest)},
            cwd=tmpdir,
            plugin_root=str(repo_root),
        )
        assert iso_ver_res["status"] == "completed" and iso_ver_res["findings"][0]["id"] == "TR1"

    # 7. execute.py standardWorkerEnum resolution via --meta (local override, error fallback, explicit override)
    with tempfile.TemporaryDirectory() as tmpdir:
        sdlc_dir = Path(tmpdir) / ".sdlc"
        sdlc_dir.mkdir(parents=True, exist_ok=True)
        (sdlc_dir / "config.json").write_text(json.dumps({
            "schemaVersion": 4,
            "execute": {
                "standardWorkerEnum": "pro",
                "guardrails": [{"id": "g-smoke", "description": "Keep clean", "severity": "error"}],
            },
        }), encoding="utf-8")
        (sdlc_dir / "local.json").write_text(json.dumps({
            "schemaVersion": 4,
            "execute": {"standardWorkerEnum": "inherit"},
        }), encoding="utf-8")

        plan_file = Path(tmpdir) / "smoke-plan.md"
        plan_file.write_text(
            "# Smoke Plan\\n\\n"
            "### Task 1: Implement module\\n"
            "**Complexity:** Standard\\n"
            "**Risk:** Low\\n"
            "**Depends on:** none\\n"
            "**Files:**\\n- Create: \`a.js\`\\n\\n"
            "**Description:**\\nCreate a.js.\\n",
            encoding="utf-8",
        )

        # Case 7a: wf_args omits standard_worker_enum -> resolves "inherit" from real --meta CLI output
        meta_cmds = []
        dispatched_models = []

        async def mock_exec_call_tool(tool_name, **kwargs):
            cmd = kwargs.get("CommandLine", "")
            if "execute-context-advisory.js" in cmd:
                meta_cmds.append(cmd)
                proc = subprocess.run(cmd, shell=True, cwd=tmpdir, capture_output=True, text=True)
                return f"Command exited with code {proc.returncode}.\\nCommand output:\\n{proc.stdout}"
            if "git ls-files" in cmd:
                return "Command exited with code 0.\\nCommand output:\\na.js\\n"
            if "git diff --stat" in cmd:
                return "Command exited with code 0.\\nCommand output:\\n a.js | 1 +\\n"
            return "Command exited with code 0.\\nCommand output:\\n"

        async def mock_exec_agent(**kwargs):
            if kwargs.get("type_name") == "task-implementer":
                dispatched_models.append(kwargs.get("model"))
                return {"task_id": "1", "status": "DONE", "files_touched": ["a.js"], "summary": "done"}
            return {"verdict": "COMPLIANT", "tasks": [{"task_id": "1", "compliant": True, "issues": []}], "summary": "ok"}

        iso_ex_ns = load_workflow(workflow_paths["execute"], {
            "args": {"plan_file": "/nonexistent-poison.md"},
            "call_tool": mock_exec_call_tool,
            "agent": mock_exec_agent,
        })
        res_inherit = await iso_ex_ns["run_execute"](
            wf_args={"plan_file": str(plan_file), "quality": "balanced", "branch": "feat/meta-smoke"},
            cwd=tmpdir,
            plugin_root=str(repo_root),
        )
        assert res_inherit["status"] == "completed", f"run_execute failed: {res_inherit}"
        assert any("--meta" in c for c in meta_cmds), f"Expected --meta call, got {meta_cmds}"
        assert dispatched_models == ["inherit"], f"Expected ['inherit'], got {dispatched_models}"

        # Case 7b: --meta command fails -> graceful fallback to "pro"
        dispatched_models.clear()

        async def mock_fail_meta_call_tool(tool_name, **kwargs):
            cmd = kwargs.get("CommandLine", "")
            if "execute-context-advisory.js" in cmd:
                return "Command exited with code 2.\\nCommand output:\\nscript crashed\\n"
            if "git ls-files" in cmd:
                return "Command exited with code 0.\\nCommand output:\\na.js\\n"
            return "Command exited with code 0.\\nCommand output:\\n"

        iso_ex_fail_ns = load_workflow(workflow_paths["execute"], {
            "call_tool": mock_fail_meta_call_tool,
            "agent": mock_exec_agent,
        })
        res_fallback = await iso_ex_fail_ns["run_execute"](
            wf_args={"plan_file": str(plan_file), "quality": "balanced", "branch": "feat/meta-smoke"},
            cwd=tmpdir,
            plugin_root=str(repo_root),
        )
        assert res_fallback["status"] == "completed"
        assert dispatched_models == ["pro"], f"Expected ['pro'] fallback, got {dispatched_models}"

        # Case 7c: explicit wf_args.standard_worker_enum overrides --meta
        dispatched_models.clear()
        res_override = await iso_ex_ns["run_execute"](
            wf_args={
                "plan_file": str(plan_file),
                "quality": "balanced",
                "branch": "feat/meta-smoke",
                "standard_worker_enum": "pro",
            },
            cwd=tmpdir,
            plugin_root=str(repo_root),
        )
        assert res_override["status"] == "completed"
        assert dispatched_models == ["pro"], f"Expected explicit ['pro'], got {dispatched_models}"

    print(json.dumps({"ok": True, "workflows_checked": sorted(workflow_paths.keys())}))

asyncio.run(run_checks())
`;

    const res = spawnSync('python3', ['-c', pyScript, REPO_ROOT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.equal(
      res.status,
      0,
      `Python workflow harness failed (exit ${res.status}):\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
    );
    const lines = res.stdout.trim().split(/\r?\n/);
    const summary = JSON.parse(lines[lines.length - 1]);
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.workflows_checked, ['execute', 'review', 'ship', 'verify']);
  });
});
