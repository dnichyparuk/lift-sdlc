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
    assert ex_ns["next_escalated_model"]("flash_lite", "NEEDS_CONTEXT") == "flash_lite"
    assert ex_ns["next_escalated_model"]("flash", "NEEDS_CONTEXT") == "flash"
    assert ex_ns["next_escalated_model"]("inherit", "NEEDS_CONTEXT") == "inherit"

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
        reviewer_models = []

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
            if kwargs.get("type_name") == "spec-compliance-reviewer":
                reviewer_models.append(kwargs.get("model"))
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
        assert res_inherit["completeness_verified"] is False, "small_plan skips execute state"
        assert any("--meta" in c for c in meta_cmds), f"Expected --meta call, got {meta_cmds}"
        assert dispatched_models == ["inherit"], f"Expected ['inherit'], got {dispatched_models}"
        assert reviewer_models == ["pro"], f"P1-1: spec-compliance-reviewer must always use 'pro', got {reviewer_models}"

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

        # Case 7d: P0-1 completeness_verified, P1-1 reviewer_model=='pro', P1-2 NEEDS_CONTEXT holds tier, P0-3 skip_high_risk
        nc_plan = Path(tmpdir) / "nc-plan.md"
        nc_plan.write_text(
            "# Multi Plan\\n\\n"
            "### Task 1: Context task\\n**Complexity:** Trivial\\n**Risk:** Low\\n**Depends on:** none\\n**Files:**\\n- Create: \`t1.js\`\\n\\n**Description:**\\nCreate t1.js.\\n\\n"
            "### Task 2: Error code context task\\n**Complexity:** Trivial\\n**Risk:** Low\\n**Depends on:** Task 1\\n**Files:**\\n- Create: \`t2.js\`\\n\\n**Description:**\\nCreate t2.js.\\n\\n"
            "### Task 3: Failing test escalation task\\n**Complexity:** Trivial\\n**Risk:** Low\\n**Depends on:** Task 2\\n**Files:**\\n- Create: \`t3.js\`\\n\\n**Description:**\\nCreate t3.js.\\n\\n"
            "### Task 4: Standard reviewed task\\n**Complexity:** Standard\\n**Risk:** Low\\n**Depends on:** Task 3\\n**Files:**\\n- Create: \`t4.js\`\\n\\n**Description:**\\nCreate t4.js.\\n",
            encoding="utf-8",
        )
        task_attempts = {"1": [], "2": [], "3": [], "4": []}
        nc_prompts = []
        nc_reviewer_models = []
        nc_state_cmds = []

        async def mock_nc_call_tool(tool_name, **kwargs):
            cmd = kwargs.get("CommandLine", "")
            nc_state_cmds.append(cmd)
            if "execute-context-advisory.js" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"guardrails":[],"standardWorkerEnum":"pro"}'
            if "state/execute.js" in cmd and " read " in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"startedAt":"2026-11-25T00:00:00Z","waves":[]}'
            if "git ls-files" in cmd:
                return "Command exited with code 0.\\nCommand output:\\nt1.js\\nt2.js\\nt3.js\\nt4.js\\n"
            if "git diff --stat" in cmd:
                return "Command exited with code 0.\\nCommand output:\\n t1.js | 1 +\\n t2.js | 1 +\\n t3.js | 1 +\\n t4.js | 1 +\\n"
            return "Command exited with code 0.\\nCommand output:\\n{}"

        async def mock_nc_agent(**kwargs):
            if kwargs.get("type_name") == "spec-compliance-reviewer":
                nc_reviewer_models.append(kwargs.get("model"))
                return {"verdict": "COMPLIANT", "tasks": [{"task_id": "4", "compliant": True, "issues": []}], "summary": "ok"}
            role = kwargs.get("role", "")
            tid = role.split(":")[0].replace("Task ", "").strip()
            task_attempts[tid].append(kwargs.get("model"))
            if tid == "1" and len(task_attempts["1"]) == 1:
                return {"task_id": "1", "status": "NEEDS_CONTEXT", "files_touched": [], "concerns": ["missing schema path"], "summary": "Need schema path"}
            if tid == "2" and len(task_attempts["2"]) == 1:
                return {"task_id": "2", "status": "BLOCKED", "error_code": "NEEDS_CONTEXT", "files_touched": [], "summary": "Need API types"}
            if tid == "3" and len(task_attempts["3"]) == 1:
                return {"task_id": "3", "status": "BLOCKED", "error_code": "FAILED_TESTS", "files_touched": [], "summary": "Test failed"}
            if tid == "1":
                nc_prompts.append(kwargs.get("prompt", ""))
            return {"task_id": tid, "status": "DONE", "files_touched": [f"t{tid}.js"], "summary": f"done {tid}"}

        nc_ns = load_workflow(workflow_paths["execute"], {
            "call_tool": mock_nc_call_tool,
            "agent": mock_nc_agent,
        })
        nc_res = await nc_ns["run_execute"](
            wf_args={"plan_file": str(nc_plan), "quality": "balanced", "branch": "feat/nc-smoke"},
            cwd=tmpdir,
            plugin_root=str(repo_root),
        )
        assert nc_res["status"] == "completed", f"nc_res failed: {nc_res}"
        assert nc_res["completeness_verified"] is True, f"P0-1: expected completeness_verified=True: {nc_res}"
        assert nc_reviewer_models == ["pro"], f"P1-1: expected ['pro'], got {nc_reviewer_models}"
        assert task_attempts["1"] == ["flash", "flash"], f"P1-2: NEEDS_CONTEXT must hold tier, got {task_attempts['1']}"
        assert task_attempts["2"] == ["flash", "flash"], f"P1-2: error_code=NEEDS_CONTEXT must hold tier, got {task_attempts['2']}"
        assert task_attempts["3"] == ["flash", "pro"], f"FAILED_TESTS must escalate flash->pro, got {task_attempts['3']}"
        assert nc_res["escalations_used"] == 1, f"Only Task 3 should count as escalation, got {nc_res['escalations_used']}"
        assert nc_prompts and "Need schema path" in nc_prompts[0] and "missing schema path" in nc_prompts[0]
        assert any("state/execute.js" in c and "verify-completeness" in c for c in nc_state_cmds)

        # Case 7e: P0-3 skip_high_risk in execute.py (mixed wave plan continues; all-high-risk returns skipped)
        shr_plan = Path(tmpdir) / "shr-plan.md"
        shr_plan.write_text(
            "# Skip High Risk Plan\\n\\n"
            "### Task 1: Safe prep\\n**Complexity:** Trivial\\n**Risk:** Low\\n**Depends on:** none\\n**Files:**\\n- Create: \`safe.js\`\\n\\n**Description:**\\nCreate safe.js.\\n\\n"
            "### Task 2: Risky migration\\n**Complexity:** Trivial\\n**Risk:** High\\n**Depends on:** Task 1\\n**Files:**\\n- Create: \`risky.sql\`\\n\\n**Description:**\\nCreate risky.sql.\\n",
            encoding="utf-8",
        )
        shr_cmds = []
        shr_agents = []

        async def mock_shr_call_tool(tool_name, **kwargs):
            cmd = kwargs.get("CommandLine", "")
            shr_cmds.append(cmd)
            if "execute-context-advisory.js" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"guardrails":[],"standardWorkerEnum":"pro"}'
            if "state/execute.js" in cmd and " read " in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"startedAt":"2026-11-25T00:00:00Z","waves":[]}'
            if "git ls-files" in cmd:
                return "Command exited with code 0.\\nCommand output:\\nsafe.js\\n"
            if "git diff --stat" in cmd:
                return "Command exited with code 0.\\nCommand output:\\n safe.js | 1 +\\n"
            return "Command exited with code 0.\\nCommand output:\\n{}"

        async def mock_shr_agent(**kwargs):
            shr_agents.append(kwargs)
            return {"task_id": "1", "status": "DONE", "files_touched": ["safe.js"], "summary": "done safe"}

        shr_ns = load_workflow(workflow_paths["execute"], {
            "call_tool": mock_shr_call_tool,
            "agent": mock_shr_agent,
        })
        shr_res = await shr_ns["run_execute"](
            wf_args={"plan_file": str(shr_plan), "quality": "balanced", "branch": "feat/shr", "auto": False, "skip_high_risk": True},
            cwd=tmpdir,
            plugin_root=str(repo_root),
        )
        assert shr_res["status"] == "completed", f"Expected completed with Wave 2 skipped, got: {shr_res}"
        assert shr_res["completeness_verified"] is True
        assert shr_res["tasks_skipped"] == 1 and shr_res["skipped_task_ids"] == ["2"]
        assert shr_res["waves"][1]["status"] == "skipped"
        assert len(shr_agents) == 1
        assert any("task-fail" in c and "--skipped-dependency" in c for c in shr_cmds)

        # All-high-risk plan with skip_high_risk=True returns status=='skipped' cleanly
        all_hr_plan = Path(tmpdir) / "all-hr-plan.md"
        all_hr_plan.write_text(
            "# All High Risk\\n\\n"
            "### Task 1: Risky only\\n**Complexity:** Trivial\\n**Risk:** High\\n**Depends on:** none\\n**Files:**\\n- Create: \`drop.sql\`\\n\\n**Description:**\\nRisky.\\n",
            encoding="utf-8",
        )
        shr_cmds.clear()
        shr_agents.clear()
        all_hr_res = await shr_ns["run_execute"](
            wf_args={"plan_file": str(all_hr_plan), "quality": "balanced", "branch": "feat/all-hr", "auto": False, "skip_high_risk": True},
            cwd=tmpdir,
            plugin_root=str(repo_root),
        )
        assert all_hr_res["status"] == "skipped", f"Expected skipped when all waves skipped, got: {all_hr_res}"
        assert all_hr_res["completeness_verified"] is True
        assert len(shr_agents) == 0

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

  it('ship.py executes execute, review, and await-remote-review at Depth 1, propagates high_risk_wave consent, and deterministically classifies CI logs', () => {
    const pyScript = `
import asyncio
import json
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

repo_root = Path(sys.argv[1])
ship_path = repo_root / "skills/ship-sdlc/workflows/ship.py"

def load_ship(extra_globals=None):
    ns = {
        "__name__": "__workflow_smoke_ship__",
        "__file__": str(ship_path),
        "args": {},
        "log": lambda *parts: None,
        "phase": lambda name: None,
    }
    if extra_globals:
        ns.update(extra_globals)
    code = ship_path.read_text(encoding="utf-8")
    exec(compile(code, str(ship_path), "exec"), ns)
    return ns

async def run_ship_tests():
    # 8a. _load_subworkflow isolation & primitive inheritance
    sentinel_ct = object()
    sentinel_ag = object()
    sentinel_par = object()
    sentinel_pipe = object()
    sentinel_log = lambda *a: None
    sentinel_args = {"ship_only": True}
    iso_ship = load_ship({
        "call_tool": sentinel_ct,
        "agent": sentinel_ag,
        "parallel": sentinel_par,
        "pipeline": sentinel_pipe,
        "log": sentinel_log,
        "args": sentinel_args,
    })
    orig_main = iso_ship["main"]
    sub_ns = iso_ship["_load_subworkflow"]("skills/execute-plan-sdlc/workflows/execute.py", repo_root)
    assert sub_ns["__name__"] == "sdlc_subwf"
    assert sub_ns["__file__"] == str(repo_root / "skills/execute-plan-sdlc/workflows/execute.py")
    assert sub_ns["call_tool"] is sentinel_ct
    assert sub_ns["agent"] is sentinel_ag
    assert sub_ns["parallel"] is sentinel_par
    assert sub_ns["pipeline"] is sentinel_pipe
    assert sub_ns["log"] is sentinel_log
    assert sub_ns["args"] is sentinel_args
    assert iso_ship["main"] is orig_main, "_load_subworkflow must not clobber ship.py globals"

    # 8b. End-to-end Depth-1 ship.py executing real execute.py, review.py, and verify.py
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        plan_file = tmp / "plan.md"
        plan_file.write_text(
            "# Depth1 Plan\\n\\n"
            "### Task 1: Build feature\\n"
            "**Complexity:** Standard\\n"
            "**Risk:** Low\\n"
            "**Depends on:** none\\n"
            "**Files:**\\n- Create: \`a.js\`\\n\\n"
            "**Description:**\\nCreate a.js.\\n",
            encoding="utf-8",
        )
        diff_file = tmp / "quality.diff"
        diff_file.write_text("+export const a = 1;\\n", encoding="utf-8")
        review_manifest = tmp / "review-manifest.json"
        review_manifest.write_text(json.dumps({
            "scope": "committed",
            "diff_dir": tmpdir,
            "current_branch": "feat/depth1",
            "plugin_version": "0.27.2",
            "dimensions": [
                {
                    "name": "quality",
                    "status": "ACTIVE",
                    "severity": "medium",
                    "matched_files": ["a.js"],
                    "diff_file": str(diff_file),
                }
            ],
        }), encoding="utf-8")
        verify_manifest = tmp / "verify-manifest.json"
        verify_manifest.write_text(json.dumps({
            "pr": {"number": 77},
            "threads": [
                {
                    "id": "T_REMOTE_1",
                    "status": "outstanding",
                    "path": "a.js",
                    "line": 1,
                    "severity": "high",
                    "firstComment": {"body": "Check null input"},
                }
            ],
        }), encoding="utf-8")
        prepare_file = tmp / "prepare.json"
        prepare_file.write_text(json.dumps({
            "flags": {"auto": True, "steps": ["execute", "commit", "review", "pr", "await-remote-review"], "workspace": "continue", "reviewThreshold": "high"},
            "context": {"currentBranch": "feat/depth1", "defaultBranch": "main", "expectedBranch": "feat/depth1", "planFile": str(plan_file), "worktree": {"inLinkedWorktree": False}},
            "resume": {"found": False},
            "steps": [
                {"name": "execute", "skill": "execute-plan-sdlc", "model": "inherit", "status": "will_run", "args": f'--plan-file "{plan_file}"'},
                {"name": "commit", "skill": "commit-sdlc", "model": "flash", "status": "will_run", "args": "--auto"},
                {"name": "review", "skill": "review-sdlc", "model": "flash", "status": "will_run", "args": "--committed"},
                {"name": "received-review", "skill": "received-review-sdlc", "model": "pro", "status": "conditional", "args": "--auto"},
                {"name": "commit-fixes", "skill": "commit-sdlc", "model": "flash", "status": "conditional", "args": "--auto"},
                {"name": "pr", "skill": "pr-sdlc", "model": "flash", "status": "will_run", "args": "--auto"},
                {"name": "await-remote-review", "skill": None, "model": None, "status": "will_run", "args": "--timeout 60", "loop": {"subDispatch": [{"skill": "received-review-sdlc", "model": "pro"}, {"skill": "commit-sdlc", "model": "flash"}]}},
                {"name": "cleanup", "skill": None, "model": None, "status": "will_run"},
            ],
        }), encoding="utf-8")

        cmds = []
        agent_calls = []

        async def mock_call_tool(tool_name, **kwargs):
            cmd = kwargs.get("CommandLine", "")
            cmds.append(cmd)
            if "verify-completeness.js" in cmd:
                raise AssertionError(f"P0-1: ship.py must NOT invoke verify-completeness.js: {cmd}")
            if "state/ship.js" in cmd and " init " in cmd:
                return f"Command exited with code 0.\\nCommand output:\\n{json.dumps({'filePath': str(tmp / 'ship-state.json')})}"
            if "state/ship.js" in cmd and "cleanup-pipeline" in cmd:
                return f"Command exited with code 0.\\nCommand output:\\n{json.dumps({'currentRun': {'valid': True, 'cleaned': True}, 'gc': {}})}"
            if "execute-context-advisory.js" in cmd:
                return "Command exited with code 0.\\nCommand output:\\n{\\"guardrails\\": [], \\"standardWorkerEnum\\": \\"pro\\"}"
            if "git diff --stat" in cmd:
                return "Command exited with code 0.\\nCommand output:\\n a.js | 1 +\\n"
            if "git ls-files" in cmd:
                return "Command exited with code 0.\\nCommand output:\\na.js\\n"
            if "ship-git-ops.js" in cmd and "stage-post-execute" in cmd:
                return "Command exited with code 0.\\nCommand output:\\n{\\"staged\\": [\\"a.js\\"]}"
            if "scripts/skill/review.js" in cmd:
                return f"Command exited with code 0.\\nCommand output:\\n{review_manifest}"
            if "review-cleanup.js" in cmd:
                proc = subprocess.run(cmd, shell=True, cwd=tmpdir, capture_output=True, text=True)
                return f"Command exited with code {proc.returncode}.\\nCommand output:\\n{proc.stdout}"
            if "await-review.js" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"status":"actionable","prNumber":77,"reviewer":"copilot[bot]"}'
            if "scripts/skill/received-review.js" in cmd:
                return f"Command exited with code 0.\\nCommand output:\\n{verify_manifest}"
            if "rebase-onto-base.js" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"status":"up_to_date"}'
            if "git status --porcelain" in cmd:
                return "Command exited with code 0.\\nCommand output:\\n"
            return "Command exited with code 0.\\nCommand output:\\n{}"

        async def mock_agent(**kwargs):
            agent_calls.append(kwargs)
            tname = kwargs.get("type_name")
            role = kwargs.get("role", "")
            if tname == "task-implementer":
                return {"task_id": "1", "status": "DONE", "files_touched": ["a.js"], "summary": "created a.js"}
            if tname == "spec-compliance-reviewer":
                return {"verdict": "COMPLIANT", "tasks": [{"task_id": "1", "compliant": True, "issues": []}], "summary": "ok"}
            if tname == "research" and role == "quality reviewer":
                return {"no_findings": True, "findings": [], "notes": None}
            if role == "Consolidate review findings":
                return {"assessment": "Clean.", "dimensions": [{"name": "quality", "findings": []}]}
            if tname == "research" and role.startswith("Verify "):
                return {"findings": [{"id": "T_REMOTE_1", "verificationStatus": "confirmed", "evidence": ["a.js:1"], "rippleEffects": [], "reasoning": "Verified null risk", "detail": "Full detail"}]}
            if role == "Ship: remote review fix/reply":
                assert "T_REMOTE_1" in kwargs["prompt"], "Pre-verified finding ID missing in lean remote fix prompt"
                assert ".verification.md" in kwargs["prompt"], "reportFile missing in lean remote fix prompt"
                assert "Skip Re-Verification" in kwargs["prompt"]
                return {"status": "success", "summary": "fixed and replied"}
            return {"status": "success", "pr_number": 77, "summary": f"{role} ok"}

        sh_ns = load_ship({
            "args": {"prepare_output_file": str(prepare_file), "cwd": tmpdir, "plugin_root": str(repo_root)},
            "call_tool": mock_call_tool,
            "agent": mock_agent,
        })
        res = await sh_ns["main"]()
        assert res["status"] == "completed", f"Expected completed ship result, got: {res}"

        self_roles = [c.get("role") for c in agent_calls if c.get("type_name") == "self"]
        assert "Ship: execute-plan-sdlc" not in self_roles, f"execute must not use agent(self): {self_roles}"
        assert "Ship: review-sdlc" not in self_roles, f"review must not use agent(self): {self_roles}"
        assert "Ship: remote received-review-sdlc" not in self_roles, f"remote verify must not use agent(self): {self_roles}"

        all_roles = [c.get("role") for c in agent_calls]
        assert any(r.startswith("Task 1:") for r in all_roles), f"execute.py task-implementer missing: {all_roles}"
        assert "quality reviewer" in all_roles, f"review.py dimension reviewer missing: {all_roles}"
        assert any(r.startswith("Verify a.js") for r in all_roles), f"verify.py thread verifier missing: {all_roles}"
        assert "Ship: remote review fix/reply" in all_roles, f"lean remote fix/reply agent missing: {all_roles}"

        assert any("decide --step review" in c and "Verdict: APPROVED" in c and "Counts:" in c for c in cmds), f"Missing decide --step review: {cmds}"
        assert not any("verify-completeness.js" in c for c in cmds), f"P0-1: ship.py must NOT call verify-completeness.js: {cmds}"
        assert any("review-cleanup.js" in c for c in cmds), f"review-cleanup.js must be invoked: {cmds}"
        assert not review_manifest.exists(), "review-cleanup.js should remove manifest file"
        assert tmp.is_dir(), "review-cleanup.js safety guard must preserve non-sdlc-review- dir"

    # 8c. high_risk_wave needs_consent propagation and --resume completion
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        hr_plan = tmp / "hr-plan.md"
        hr_plan.write_text(
            "# High Risk Plan\\n\\n"
            "### Task 1: Risky migration\\n"
            "**Complexity:** Trivial\\n"
            "**Risk:** High\\n"
            "**Depends on:** none\\n"
            "**Files:**\\n- Create: \`mig.sql\`\\n\\n"
            "**Description:**\\nCreate mig.sql.\\n",
            encoding="utf-8",
        )
        hr_prepare = tmp / "hr-prepare.json"
        hr_prepare.write_text(json.dumps({
            "flags": {"auto": False, "steps": ["execute", "commit"], "workspace": "branch"},
            "context": {"currentBranch": "feat/hr", "defaultBranch": "main", "expectedBranch": "feat/hr", "planFile": str(hr_plan), "worktree": {"inLinkedWorktree": False}},
            "resume": {"found": False},
            "steps": [
                {"name": "execute", "skill": "execute-plan-sdlc", "model": "inherit", "status": "will_run", "args": f'--plan-file "{hr_plan}"'},
                {"name": "commit", "skill": "commit-sdlc", "model": "flash", "status": "will_run", "args": ""},
                {"name": "cleanup", "skill": None, "model": None, "status": "will_run"},
            ],
        }), encoding="utf-8")

        hr_cmds = []
        hr_agents = []

        async def mock_hr_call_tool(tool_name, **kwargs):
            cmd = kwargs.get("CommandLine", "")
            hr_cmds.append(cmd)
            if "verify-completeness.js" in cmd:
                raise AssertionError(f"P0-1: ship.py must NOT invoke verify-completeness.js: {cmd}")
            if "state/ship.js" in cmd and " init " in cmd:
                return f"Command exited with code 0.\\nCommand output:\\n{json.dumps({'filePath': str(tmp / 'hr-ship.json')})}"
            if "ship-workspace-setup.js" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"status":"ok","executeBranch":"feat/hr"}'
            if "execute-context-advisory.js" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"guardrails":[],"standardWorkerEnum":"pro"}'
            if "state/execute.js" in cmd and "detect-resume" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"found":false,"waveShaStatus":[]}'
            if "state/execute.js" in cmd and " read " in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"startedAt":"2026-11-25T00:00:00Z","waves":[]}'
            if "git ls-files" in cmd:
                return "Command exited with code 0.\\nCommand output:\\nmig.sql\\n"
            if "ship-git-ops.js" in cmd and "stage-post-execute" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"staged":["mig.sql"]}'
            if "cleanup-pipeline" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"currentRun":{"valid":true,"cleaned":true},"gc":{}}'
            return "Command exited with code 0.\\nCommand output:\\n{}"

        async def mock_hr_agent(**kwargs):
            hr_agents.append(kwargs)
            if kwargs.get("type_name") == "task-implementer":
                return {"task_id": "1", "status": "DONE", "files_touched": ["mig.sql"], "summary": "migrated"}
            return {"status": "success", "summary": "committed"}

        hr_ns = load_ship({
            "args": {"prepare_output_file": str(hr_prepare), "cwd": tmpdir, "plugin_root": str(repo_root), "workspace_flag": "branch"},
            "call_tool": mock_hr_call_tool,
            "agent": mock_hr_agent,
        })
        hr_res = await hr_ns["main"]()
        assert hr_res["status"] == "needs_consent", f"Expected needs_consent, got: {hr_res}"
        assert hr_res["gate"] == "high_risk_wave", f"Expected high_risk_wave gate, got: {hr_res}"
        assert hr_res["wave"] == 1 and len(hr_res["high_risk_tasks"]) == 1
        assert len(hr_agents) == 0, f"No task agents should run before high_risk_wave approval: {hr_agents}"
        assert not any("verify-completeness.js" in c or "cleanup-pipeline" in c for c in hr_cmds)

        # Resume after user approves high_risk_wave
        hr_prepare_resume = tmp / "hr-prepare-resume.json"
        hr_prepare_resume.write_text(json.dumps({
            "flags": {"auto": False, "resume": True, "steps": ["execute", "commit"], "workspace": "branch"},
            "context": {"currentBranch": "feat/hr", "defaultBranch": "main", "expectedBranch": "feat/hr", "planFile": str(hr_plan), "worktree": {"inLinkedWorktree": False}},
            "resume": {"found": True, "fullPath": str(tmp / "hr-ship.json"), "nextPendingStep": "execute"},
            "steps": [
                {"name": "execute", "skill": "execute-plan-sdlc", "model": "inherit", "status": "will_run", "args": f'--plan-file "{hr_plan}"'},
                {"name": "commit", "skill": "commit-sdlc", "model": "flash", "status": "will_run", "args": ""},
                {"name": "cleanup", "skill": None, "model": None, "status": "will_run"},
            ],
        }), encoding="utf-8")

        async def mock_hr_resume_call_tool(tool_name, **kwargs):
            cmd = kwargs.get("CommandLine", "")
            if "state/ship.js" in cmd and " read" in cmd:
                return f"Command exited with code 0.\\nCommand output:\\n{json.dumps({'steps': [{'name': 'execute', 'status': 'in_progress'}, {'name': 'commit', 'status': 'pending'}], 'decisions': []})}"
            return await mock_hr_call_tool(tool_name, **kwargs)

        hr_cmds.clear()
        hr_agents.clear()
        hr_res_ns = load_ship({
            "args": {"prepare_output_file": str(hr_prepare_resume), "cwd": tmpdir, "plugin_root": str(repo_root), "approve_high_risk": True},
            "call_tool": mock_hr_resume_call_tool,
            "agent": mock_hr_agent,
        })
        hr_pause_commit = await hr_res_ns["main"]()
        assert hr_pause_commit["status"] == "needs_consent" and hr_pause_commit["gate"] == "commit", f"P0-3: expected commit consent gate when not auto, got: {hr_pause_commit}"
        assert any(c.get("type_name") == "task-implementer" for c in hr_agents)
        assert not any(c.get("role") == "Ship: commit-sdlc" for c in hr_agents), "commit-sdlc must not run before approve_commit"
        assert not any("verify-completeness.js" in c for c in hr_cmds)
        assert any("state/execute.js" in c and "verify-completeness" in c for c in hr_cmds)
        assert hr_pause_commit["artifacts"]["execute"]["completeness_verified"] is True

        # Second resume after user approves commit (injects --auto to leaf commit-sdlc)
        async def mock_hr_commit_resume_call_tool(tool_name, **kwargs):
            cmd = kwargs.get("CommandLine", "")
            if "state/ship.js" in cmd and " read" in cmd:
                return f"Command exited with code 0.\\nCommand output:\\n{json.dumps({'steps': [{'name': 'execute', 'status': 'completed'}, {'name': 'commit', 'status': 'pending'}], 'decisions': []})}"
            return await mock_hr_call_tool(tool_name, **kwargs)

        hr_cmds.clear()
        hr_agents.clear()
        hr_res_ns2 = load_ship({
            "args": {"prepare_output_file": str(hr_prepare_resume), "cwd": tmpdir, "plugin_root": str(repo_root), "approve_high_risk": True, "approve_commit": True},
            "call_tool": mock_hr_commit_resume_call_tool,
            "agent": mock_hr_agent,
        })
        hr_res2 = await hr_res_ns2["main"]()
        assert hr_res2["status"] == "completed", f"Expected completed on approved commit resume, got: {hr_res2}"
        commit_agents = [c for c in hr_agents if c.get("role") == "Ship: commit-sdlc"]
        assert len(commit_agents) == 1 and "--auto" in commit_agents[0]["prompt"], f"P0-3: commit-sdlc must receive --auto, got: {commit_agents}"
        assert not any("verify-completeness.js" in c for c in hr_cmds)

        # Resume with skip_high_risk=True skips execute without looping into needs_consent
        hr_cmds.clear()
        hr_agents.clear()
        hr_skip_ns = load_ship({
            "args": {"prepare_output_file": str(hr_prepare_resume), "cwd": tmpdir, "plugin_root": str(repo_root), "skip_high_risk": True, "approve_commit": True},
            "call_tool": mock_hr_resume_call_tool,
            "agent": mock_hr_agent,
        })
        hr_skip_res = await hr_skip_ns["main"]()
        assert hr_skip_res["status"] == "completed", f"P0-3: expected completed after skip_high_risk, got: {hr_skip_res}"
        assert not any(c.get("type_name") == "task-implementer" for c in hr_agents)
        assert hr_skip_res["steps"][0]["step"] == "execute" and hr_skip_res["steps"][0]["status"] == "skipped"

    # 8d. verify-pipeline deterministic classification (always-proposal skips LLM; actionable dispatches lean fix)
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        vp_prepare = tmp / "vp-prepare.json"
        vp_prepare.write_text(json.dumps({
            "flags": {"auto": True, "steps": ["verify-pipeline"], "workspace": "continue", "verifyPipelineMaxIterations": 2},
            "context": {"currentBranch": "feat/vp", "defaultBranch": "main", "expectedBranch": "feat/vp", "worktree": {"inLinkedWorktree": False}},
            "resume": {"found": False},
            "steps": [
                {"name": "verify-pipeline", "skill": None, "model": None, "status": "will_run", "args": "--timeout 60", "loop": {"subDispatch": [{"skill": "verify-pipeline-sdlc", "model": "pro"}, {"skill": "commit-sdlc", "model": "flash"}]}},
                {"name": "cleanup", "skill": None, "model": None, "status": "will_run"},
            ],
        }), encoding="utf-8")

        # 8d-1: always-proposal (build-error) -> 0 LLM agents spawned
        vp_cmds = []
        vp_agents = []

        async def mock_vp_proposal_call_tool(tool_name, **kwargs):
            cmd = kwargs.get("CommandLine", "")
            vp_cmds.append(cmd)
            if "state/ship.js" in cmd and " init " in cmd:
                return f"Command exited with code 0.\\nCommand output:\\n{json.dumps({'filePath': str(tmp / 'vp-ship.json')})}"
            if "verify-pipeline.js" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"status":"failed","prNumber":88,"failedChecks":[{"name":"build","conclusion":"fail"}]}'
            if "fetch-logs.js" in cmd:
                return "Command exited with code 0.\\nCommand output:\\nError: Cannot find module './missing-dep'\\n"
            if "verify-pipeline-sdlc-classify.js" in cmd:
                proc = subprocess.run(cmd, shell=True, cwd=tmpdir, capture_output=True, text=True)
                return f"Command exited with code {proc.returncode}.\\nCommand output:\\n{proc.stdout}"
            if "cleanup-pipeline" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"currentRun":{"valid":true,"cleaned":true},"gc":{}}'
            return "Command exited with code 0.\\nCommand output:\\n{}"

        async def mock_vp_agent(**kwargs):
            vp_agents.append(kwargs)
            return {"status": "success", "summary": "fixed"}

        vp_ns = load_ship({
            "args": {"prepare_output_file": str(vp_prepare), "cwd": tmpdir, "plugin_root": str(repo_root)},
            "call_tool": mock_vp_proposal_call_tool,
            "agent": mock_vp_agent,
        })
        vp_res = await vp_ns["main"]()
        assert vp_res["status"] == "completed", f"Expected completed on always-proposal, got: {vp_res}"
        assert len(vp_agents) == 0, f"always-proposal must NOT spawn an LLM agent: {vp_agents}"
        assert any("fetch-logs.js" in c for c in vp_cmds)
        assert any("verify-pipeline-sdlc-classify.js" in c for c in vp_cmds)
        proposal = vp_res["artifacts"].get("verify_pipeline_proposal") or {}
        assert proposal.get("status") == "proposal"
        assert proposal.get("category") == "build-error"
        assert proposal.get("routingBucket") == "always-proposal"

        # 8d-2: actionable (lint) -> spawns lean fix agent + commit agent, then goes green
        vp_poll_count = 0
        vp_agents.clear()

        async def mock_vp_actionable_call_tool(tool_name, **kwargs):
            nonlocal vp_poll_count
            cmd = kwargs.get("CommandLine", "")
            if "state/ship.js" in cmd and " init " in cmd:
                return f"Command exited with code 0.\\nCommand output:\\n{json.dumps({'filePath': str(tmp / 'vp2-ship.json')})}"
            if "verify-pipeline.js" in cmd:
                vp_poll_count += 1
                if vp_poll_count == 1:
                    return 'Command exited with code 0.\\nCommand output:\\n{"status":"failed","prNumber":88,"failedChecks":[{"name":"lint","conclusion":"fail"}]}'
                return 'Command exited with code 0.\\nCommand output:\\n{"status":"green","prNumber":88}'
            if "fetch-logs.js" in cmd:
                return "Command exited with code 0.\\nCommand output:\\nsrc/a.js:1:1 eslint 1 problem (1 error, 0 warnings)\\n"
            if "verify-pipeline-sdlc-classify.js" in cmd:
                proc = subprocess.run(cmd, shell=True, cwd=tmpdir, capture_output=True, text=True)
                return f"Command exited with code {proc.returncode}.\\nCommand output:\\n{proc.stdout}"
            if "cleanup-pipeline" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"currentRun":{"valid":true,"cleaned":true},"gc":{}}'
            return "Command exited with code 0.\\nCommand output:\\n{}"

        vp2_ns = load_ship({
            "args": {"prepare_output_file": str(vp_prepare), "cwd": tmpdir, "plugin_root": str(repo_root)},
            "call_tool": mock_vp_actionable_call_tool,
            "agent": mock_vp_agent,
        })
        vp2_res = await vp2_ns["main"]()
        assert vp2_res["status"] == "completed"
        assert len(vp_agents) == 2, f"Expected fix + commit agent on actionable CI failure, got: {vp_agents}"
        assert "lint" in vp_agents[0]["prompt"] and "actionable" in vp_agents[0]["prompt"]

    # 8e. Local pre-PR received-review against review-comment.md + deferred review-cleanup.js safety
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        review_dir = tmp / "sdlc-review-smoke"
        review_dir.mkdir(parents=True, exist_ok=True)
        comment_file = review_dir / "review-comment.md"
        comment_file.write_text("### [CRITICAL] Bug in auth\\n**File:** \`auth.js:12\`\\n", encoding="utf-8")
        rev_manifest = tmp / "local-rev-manifest.json"
        rev_manifest.write_text(json.dumps({"diff_dir": str(review_dir)}), encoding="utf-8")

        rr_prepare = tmp / "rr-prepare.json"
        rr_prepare.write_text(json.dumps({
            "flags": {"auto": False, "steps": ["review", "received-review"], "workspace": "continue", "reviewThreshold": "high"},
            "context": {"currentBranch": "feat/rr", "defaultBranch": "main", "expectedBranch": "feat/rr", "worktree": {"inLinkedWorktree": False}},
            "resume": {"found": False},
            "steps": [
                {"name": "review", "skill": "review-sdlc", "model": "flash", "status": "will_run", "args": "--committed"},
                {"name": "received-review", "skill": "received-review-sdlc", "model": "pro", "status": "conditional", "args": ""},
                {"name": "cleanup", "skill": None, "model": None, "status": "will_run"},
            ],
        }), encoding="utf-8")

        recorded_decisions = []
        rr_cmds = []

        async def mock_rr_call_tool(tool_name, **kwargs):
            cmd = kwargs.get("CommandLine", "")
            rr_cmds.append(cmd)
            if "state/ship.js" in cmd and " init " in cmd:
                return f"Command exited with code 0.\\nCommand output:\\n{json.dumps({'filePath': str(tmp / 'rr-ship.json')})}"
            if "state/ship.js" in cmd and " decide " in cmd:
                m = re.search(r"--text\\s+(.+)$", cmd)
                if m:
                    recorded_decisions.append({"step": "review", "text": shlex.split(m.group(1))[0]})
                return "Command exited with code 0.\\nCommand output:\\n{}"
            if "review-cleanup.js" in cmd:
                proc = subprocess.run(cmd, shell=True, cwd=tmpdir, capture_output=True, text=True)
                return f"Command exited with code {proc.returncode}.\\nCommand output:\\n{proc.stdout}"
            if "cleanup-pipeline" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"currentRun":{"valid":true,"cleaned":true},"gc":{}}'
            return "Command exited with code 0.\\nCommand output:\\n{}"

        async def mock_run_review(**kwargs):
            return {
                "status": "completed",
                "verdict": "CHANGES REQUESTED",
                "counts": {"critical": 1, "high": 0, "medium": 0, "low": 0, "info": 0},
                "total_findings": 1,
                "comment_file": str(comment_file),
                "manifest_file": str(rev_manifest),
            }

        rr_ns = load_ship({
            "args": {"prepare_output_file": str(rr_prepare), "cwd": tmpdir, "plugin_root": str(repo_root)},
            "call_tool": mock_rr_call_tool,
            "agent": lambda **kw: None,
        })
        rr_ns["_load_subworkflow"] = lambda rel, pr: {"run_review": mock_run_review}
        rr_pause = await rr_ns["main"]()
        assert rr_pause["status"] == "needs_consent" and rr_pause["gate"] == "received_review"
        assert rr_pause["review_comment_file"] == str(comment_file)
        assert comment_file.is_file(), "review-cleanup.js must NOT delete review-comment.md before received-review runs"
        assert not any("review-cleanup.js" in c for c in rr_cmds)

        # Resume after consent: lean fix agent reads review-comment.md, then review-cleanup.js cleans up
        rr_prepare_res = tmp / "rr-prepare-res.json"
        rr_prepare_res.write_text(json.dumps({
            "flags": {"auto": False, "resume": True, "steps": ["review", "received-review"], "workspace": "continue", "reviewThreshold": "high"},
            "context": {"currentBranch": "feat/rr", "defaultBranch": "main", "expectedBranch": "feat/rr", "worktree": {"inLinkedWorktree": False}},
            "resume": {"found": True, "fullPath": str(tmp / "rr-ship.json"), "nextPendingStep": "received-review"},
            "steps": [
                {"name": "review", "skill": "review-sdlc", "model": "flash", "status": "will_run", "args": "--committed"},
                {"name": "received-review", "skill": "received-review-sdlc", "model": "pro", "status": "conditional", "args": ""},
                {"name": "cleanup", "skill": None, "model": None, "status": "will_run"},
            ],
        }), encoding="utf-8")

        rr_agents = []

        async def mock_rr_resume_call_tool(tool_name, **kwargs):
            cmd = kwargs.get("CommandLine", "")
            if "state/ship.js" in cmd and " read" in cmd:
                return f"Command exited with code 0.\\nCommand output:\\n{json.dumps({'steps': [{'name': 'review', 'status': 'completed'}, {'name': 'received-review', 'status': 'pending'}], 'decisions': recorded_decisions})}"
            return await mock_rr_call_tool(tool_name, **kwargs)

        async def mock_rr_fix_agent(**kwargs):
            rr_agents.append(kwargs)
            return {"status": "success", "summary": "fixed auth bug"}

        rr_cmds.clear()
        rr2_ns = load_ship({
            "args": {"prepare_output_file": str(rr_prepare_res), "cwd": tmpdir, "plugin_root": str(repo_root), "approve_received_review": True},
            "call_tool": mock_rr_resume_call_tool,
            "agent": mock_rr_fix_agent,
        })
        rr_done = await rr2_ns["main"]()
        assert rr_done["status"] == "completed", f"Expected completed local received-review, got: {rr_done}"
        assert len(rr_agents) == 1 and str(comment_file) in rr_agents[0]["prompt"]
        assert "pre-PR local review" in rr_agents[0]["prompt"]
        assert any("review-cleanup.js" in c for c in rr_cmds)
        assert not rev_manifest.exists() and not review_dir.exists()

    # 8f. P0-3 leaf consent gates (commit-fixes, version, pr + --auto injection), skip_ci_fix, and P0-1 execute status checks
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        leaf_prepare = tmp / "leaf-prepare.json"
        leaf_prepare.write_text(json.dumps({
            "flags": {"auto": False, "resume": True, "steps": ["received-review", "commit-fixes", "version", "pr"], "workspace": "continue", "reviewThreshold": "high"},
            "context": {"currentBranch": "feat/leaf-gates", "defaultBranch": "main", "expectedBranch": "feat/leaf-gates", "worktree": {"inLinkedWorktree": False}},
            "resume": {"found": True, "fullPath": str(tmp / "leaf-ship.json"), "nextPendingStep": "commit-fixes"},
            "steps": [
                {"name": "received-review", "skill": "received-review-sdlc", "model": "pro", "status": "conditional", "args": ""},
                {"name": "commit-fixes", "skill": "commit-sdlc", "model": "flash", "status": "conditional", "args": "--expected-branch feat/leaf-gates"},
                {"name": "version", "skill": "version-sdlc", "model": "flash", "status": "will_run", "args": "--bump patch --expected-branch feat/leaf-gates"},
                {"name": "pr", "skill": "pr-sdlc", "model": "flash", "status": "will_run", "args": "--expected-branch feat/leaf-gates"},
                {"name": "cleanup", "skill": None, "model": None, "status": "will_run"},
            ],
        }), encoding="utf-8")

        leaf_state_steps = [
            {"name": "received-review", "status": "completed"},
            {"name": "commit-fixes", "status": "pending"},
            {"name": "version", "status": "pending"},
            {"name": "pr", "status": "pending"},
        ]
        leaf_agents = []

        async def mock_leaf_call_tool(tool_name, **kwargs):
            cmd = kwargs.get("CommandLine", "")
            if "verify-completeness.js" in cmd:
                raise AssertionError(f"P0-1: ship.py must NOT invoke verify-completeness.js: {cmd}")
            if "state/ship.js" in cmd and " read" in cmd:
                return f"Command exited with code 0.\\nCommand output:\\n{json.dumps({'steps': leaf_state_steps, 'decisions': []})}"
            if "git status --porcelain" in cmd:
                return "Command exited with code 0.\\nCommand output:\\n M src/fix.js\\n"
            if "rebase-onto-base.js" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"status":"up_to_date"}'
            if "cleanup-pipeline" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"currentRun":{"valid":true,"cleaned":true},"gc":{}}'
            return "Command exited with code 0.\\nCommand output:\\n{}"

        async def mock_leaf_agent(**kwargs):
            leaf_agents.append(kwargs)
            if kwargs.get("role") == "Ship: version-sdlc":
                return {"status": "success", "new_tag": "v1.0.1", "version": "1.0.1", "summary": "tagged"}
            if kwargs.get("role") == "Ship: pr-sdlc":
                return {"status": "success", "pr_number": 55, "pr_url": "https://example/pr/55", "summary": "opened"}
            return {"status": "success", "summary": "ok"}

        # commit-fixes gate -> gate == "commit"
        g_cf = await load_ship({
            "args": {"prepare_output_file": str(leaf_prepare), "cwd": tmpdir, "plugin_root": str(repo_root)},
            "call_tool": mock_leaf_call_tool,
            "agent": mock_leaf_agent,
        })["main"]()
        assert g_cf["status"] == "needs_consent" and g_cf["gate"] == "commit" and g_cf["step"] == "commit-fixes"
        assert len(leaf_agents) == 0

        # approve_commit -> commit-fixes runs with --auto, then pauses at gate == "version"
        g_ver = await load_ship({
            "args": {"prepare_output_file": str(leaf_prepare), "cwd": tmpdir, "plugin_root": str(repo_root), "approve_commit": True},
            "call_tool": mock_leaf_call_tool,
            "agent": mock_leaf_agent,
        })["main"]()
        assert g_ver["status"] == "needs_consent" and g_ver["gate"] == "version"
        assert len(leaf_agents) == 1 and "--auto" in leaf_agents[0]["prompt"]

        # approve_version (with commit-fixes already completed in state) -> version runs with --auto, then pauses at gate == "pr"
        leaf_state_steps[1]["status"] = "completed"
        leaf_agents.clear()
        g_pr = await load_ship({
            "args": {"prepare_output_file": str(leaf_prepare), "cwd": tmpdir, "plugin_root": str(repo_root), "approve_version": True},
            "call_tool": mock_leaf_call_tool,
            "agent": mock_leaf_agent,
        })["main"]()
        assert g_pr["status"] == "needs_consent" and g_pr["gate"] == "pr"
        assert len(leaf_agents) == 1 and leaf_agents[0]["role"] == "Ship: version-sdlc" and "--auto" in leaf_agents[0]["prompt"]

        # approve_pr (with version already completed in state) -> pr runs with --auto and completes
        leaf_state_steps[2]["status"] = "completed"
        leaf_agents.clear()
        g_done = await load_ship({
            "args": {"prepare_output_file": str(leaf_prepare), "cwd": tmpdir, "plugin_root": str(repo_root), "approve_pr": True},
            "call_tool": mock_leaf_call_tool,
            "agent": mock_leaf_agent,
        })["main"]()
        assert g_done["status"] == "completed"
        assert len(leaf_agents) == 1 and leaf_agents[0]["role"] == "Ship: pr-sdlc" and "--auto" in leaf_agents[0]["prompt"]

        # 8f-2: skip_ci_fix on verify_pipeline (interactive mode)
        vp_int_prepare = tmp / "vp-int-prepare.json"
        vp_int_prepare.write_text(json.dumps({
            "flags": {"auto": False, "steps": ["verify-pipeline"], "workspace": "continue", "verifyPipelineMaxIterations": 2},
            "context": {"currentBranch": "feat/vp-int", "defaultBranch": "main", "expectedBranch": "feat/vp-int", "worktree": {"inLinkedWorktree": False}},
            "resume": {"found": False},
            "steps": [
                {"name": "verify-pipeline", "skill": None, "model": None, "status": "will_run", "args": "--timeout 60"},
                {"name": "cleanup", "skill": None, "model": None, "status": "will_run"},
            ],
        }), encoding="utf-8")
        vp_int_cmds = []
        vp_int_agents = []

        async def mock_vp_int_call_tool(tool_name, **kwargs):
            cmd = kwargs.get("CommandLine", "")
            vp_int_cmds.append(cmd)
            if "verify-completeness.js" in cmd:
                raise AssertionError(f"P0-1: ship.py must NOT invoke verify-completeness.js: {cmd}")
            if "state/ship.js" in cmd and " init " in cmd:
                return f"Command exited with code 0.\\nCommand output:\\n{json.dumps({'filePath': str(tmp / 'vp-int-ship.json')})}"
            if "state/ship.js" in cmd and " read" in cmd:
                return f"Command exited with code 0.\\nCommand output:\\n{json.dumps({'steps': [{'name': 'verify-pipeline', 'status': 'in_progress'}], 'decisions': []})}"
            if "verify-pipeline.js" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"status":"failed","prNumber":91,"failedChecks":[{"name":"test","conclusion":"fail"}]}'
            if "cleanup-pipeline" in cmd:
                return 'Command exited with code 0.\\nCommand output:\\n{"currentRun":{"valid":true,"cleaned":true},"gc":{}}'
            return "Command exited with code 0.\\nCommand output:\\n{}"

        async def mock_vp_int_agent(**kwargs):
            vp_int_agents.append(kwargs)
            return {"status": "success"}

        vp_pause = await load_ship({
            "args": {"prepare_output_file": str(vp_int_prepare), "cwd": tmpdir, "plugin_root": str(repo_root)},
            "call_tool": mock_vp_int_call_tool,
            "agent": mock_vp_int_agent,
        })["main"]()
        assert vp_pause["status"] == "needs_consent" and vp_pause["gate"] == "verify_pipeline"

        vp_int_resume = tmp / "vp-int-resume.json"
        vp_int_resume.write_text(json.dumps({
            "flags": {"auto": False, "resume": True, "steps": ["verify-pipeline"], "workspace": "continue", "verifyPipelineMaxIterations": 2},
            "context": {"currentBranch": "feat/vp-int", "defaultBranch": "main", "expectedBranch": "feat/vp-int", "worktree": {"inLinkedWorktree": False}},
            "resume": {"found": True, "fullPath": str(tmp / "vp-int-ship.json"), "nextPendingStep": "verify-pipeline"},
            "steps": [
                {"name": "verify-pipeline", "skill": None, "model": None, "status": "will_run", "args": "--timeout 60"},
                {"name": "cleanup", "skill": None, "model": None, "status": "will_run"},
            ],
        }), encoding="utf-8")
        vp_int_cmds.clear()
        vp_skip = await load_ship({
            "args": {"prepare_output_file": str(vp_int_resume), "cwd": tmpdir, "plugin_root": str(repo_root), "skip_ci_fix": True},
            "call_tool": mock_vp_int_call_tool,
            "agent": mock_vp_int_agent,
        })["main"]()
        assert vp_skip["status"] == "completed", f"P0-3: skip_ci_fix must continue cleanly, got: {vp_skip}"
        assert len(vp_int_agents) == 0
        assert any("skip --step verify-pipeline" in c for c in vp_int_cmds)
        assert vp_skip["steps"][0]["step"] == "verify-pipeline" and vp_skip["steps"][0]["status"] == "skipped"

        # 8f-3: P0-1 ship.py _run_execute_step accepts status in ('complete', 'completed', None) without verify-completeness.js
        for mock_status_payload in (
            {"status": "complete", "tasks_completed": 1, "tasks_total": 1},
            {"tasks_completed": 1, "tasks_total": 1},
        ):
            ex_cmds = []

            async def mock_ex_only_call_tool(tool_name, **kwargs):
                cmd = kwargs.get("CommandLine", "")
                ex_cmds.append(cmd)
                if "verify-completeness.js" in cmd:
                    raise AssertionError(f"P0-1: ship.py must NOT invoke verify-completeness.js: {cmd}")
                if "ship-git-ops.js" in cmd and "stage-post-execute" in cmd:
                    return 'Command exited with code 0.\\nCommand output:\\n{"staged":[]}'
                return "Command exited with code 0.\\nCommand output:\\n{}"

            ex_ship = load_ship({"call_tool": mock_ex_only_call_tool})
            async def mock_run_exec(**kwargs):
                return dict(mock_status_payload)
            ex_ship["_load_subworkflow"] = lambda rel, pr: {"run_execute": mock_run_exec}
            ok_ex, paused_ex = await ex_ship["_run_execute_step"](
                step={"name": "execute", "args": ""},
                wf_args={},
                flags={"steps": ["execute"]},
                prior_status="pending",
                plan_file=str(tmp / "dummy.md"),
                state_file=str(tmp / "ship-state.json"),
                execute_branch="feat/ex-only",
                work_dir=tmpdir,
                plugin_root=str(repo_root),
                prepare_file=str(vp_int_prepare),
                artifacts={},
                step_outcomes=[],
            )
            assert ok_ex is True and paused_ex is None
            assert not any("verify-completeness.js" in c for c in ex_cmds)

    print(json.dumps({"ok": True, "ship_depth1_verified": True}))

asyncio.run(run_ship_tests())
`;

    const res = spawnSync('python3', ['-c', pyScript, REPO_ROOT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(
      res.status,
      0,
      `ship.py Depth-1 harness failed (exit ${res.status}):\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
    );
    const lines = res.stdout.trim().split(/\r?\n/);
    const summary = JSON.parse(lines[lines.length - 1]);
    assert.equal(summary.ok, true);
    assert.equal(summary.ship_depth1_verified, true);
  });
});
