"""Deterministic `run_workflow` orchestrator for `ship-sdlc`.

Executes the end-to-end shipping pipeline at max subagent depth = 1:
- Deterministic setup, preflight, rebase, OpenSpec validation/archiving,
  completeness/ancestry gates, CI log fetch/classification, and state
  transitions run via `call_tool("run_command", ...)`.
- `execute-plan-sdlc`, `review-sdlc`, and `received-review-sdlc` thread
  verification load `execute.py::run_execute`, `review.py::run_review`, and
  `verify.py::run_verify` in isolated Python namespaces at Depth 1.
- Leaf SDLC actions (`commit-sdlc`, `version-sdlc`, `pr-sdlc`, lean review
  fixes, and actionable CI fixes) dispatch via `await agent(...)`.
- Interactive consent gates (including `high_risk_wave` from `execute.py`)
  pause cleanly with preserved state and return structured JSON so `ship-sdlc`
  can prompt the user via `ask_question`.

Note: Uses `async def main()` with no top-level `await` so `python3 -m py_compile`
succeeds cleanly. Invoke via `run_workflow` with:
  exec(open("<PLUGIN_ROOT>/skills/ship-sdlc/workflows/ship.py").read(), globals())
  await main()
"""

import asyncio
import json
import os
import re
import shlex
import subprocess
import tempfile
from pathlib import Path


STEP_RESULT_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["success", "failure"]},
        "summary": {"type": "string"},
        "artifacts": {
            "type": "object",
            "additionalProperties": True,
        },
        "warnings": {"type": "array", "items": {"type": "string"}},
        "error": {"type": ["string", "null"]},
    },
    "required": ["status", "summary"],
}

REVIEW_STEP_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["success", "failure"]},
        "verdict": {
            "type": "string",
            "enum": ["APPROVED", "APPROVED WITH NOTES", "CHANGES REQUESTED"],
        },
        "counts": {
            "type": "object",
            "properties": {
                "critical": {"type": "integer"},
                "high": {"type": "integer"},
                "medium": {"type": "integer"},
                "low": {"type": "integer"},
                "info": {"type": "integer"},
            },
            "required": ["critical", "high", "medium", "low", "info"],
        },
        "comment_file": {"type": ["string", "null"]},
        "deferred_findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "severity": {"type": "string"},
                    "file": {"type": "string"},
                    "line": {"type": ["integer", "string", "null"]},
                    "title": {"type": "string"},
                },
            },
        },
        "summary": {"type": "string"},
        "error": {"type": ["string", "null"]},
    },
    "required": ["status", "verdict", "counts", "summary"],
}

VERSION_STEP_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["success", "failure"]},
        "new_tag": {"type": ["string", "null"]},
        "version": {"type": ["string", "null"]},
        "summary": {"type": "string"},
        "error": {"type": ["string", "null"]},
    },
    "required": ["status", "summary"],
}

PR_STEP_SCHEMA = {
    "type": "object",
    "properties": {
        "status": {"type": "string", "enum": ["success", "failure"]},
        "pr_number": {"type": ["integer", "null"]},
        "pr_url": {"type": ["string", "null"]},
        "summary": {"type": "string"},
        "error": {"type": ["string", "null"]},
    },
    "required": ["status", "summary"],
}

LEAF_CONSENT_GATES = {
    "commit": ("commit", "approve_commit"),
    "commit-fixes": ("commit", "approve_commit"),
    "version": ("version", "approve_version"),
    "pr": ("pr", "approve_pr"),
}


def _wf_log(*parts):
    fn = globals().get("log")
    if callable(fn):
        fn(*parts)
    else:
        print(*parts)


def _wf_phase(name):
    fn = globals().get("phase")
    if callable(fn):
        fn(name)
    else:
        _wf_log(f"[phase] {name}")


def _wf_args():
    raw = globals().get("args")
    return raw if isinstance(raw, dict) else {}


def _load_subworkflow(rel_path: str, plugin_root) -> dict:
    """Load a sibling Python workflow in an isolated namespace inheriting run_workflow primitives."""
    target_path = Path(plugin_root) / rel_path
    code = target_path.read_text(encoding="utf-8")
    ns = {
        "__file__": str(target_path),
        "__name__": "sdlc_subwf",
    }
    g = globals()
    for prim in ("call_tool", "agent", "phase", "parallel", "pipeline", "log", "args", "WORKSPACES"):
        if prim in g:
            ns[prim] = g[prim]
    exec(compile(code, str(target_path), "exec"), ns)
    return ns


def _resolve_cwd():
    wf_args = _wf_args()
    if wf_args.get("cwd"):
        return str(Path(wf_args["cwd"]).resolve())
    return str(Path.cwd().resolve())


def _resolve_plugin_root(cwd):
    wf_args = _wf_args()
    if wf_args.get("plugin_root"):
        candidate = Path(wf_args["plugin_root"]).resolve()
        if (candidate / "scripts" / "skill").is_dir():
            return str(candidate)
    if "__file__" in globals():
        candidate = Path(__file__).resolve().parents[3]
        if (candidate / "scripts" / "skill").is_dir():
            return str(candidate)
    workspaces = globals().get("WORKSPACES") or ()
    for base in [cwd, *workspaces, str(Path.home() / ".gemini" / "config" / "plugins" / "lift-sdlc"), str(Path.home() / ".gemini" / "antigravity-cli" / "plugins" / "lift-sdlc")]:
        for cand in (Path(base), Path(base) / "lift-sdlc"):
            if (cand / "scripts" / "skill").is_dir():
                return str(cand.resolve())
    return str(Path(cwd).resolve())


def to_agy_model(tier):
    """Map Gemini tier names or agy enums to valid agy enums: flash_lite|flash|pro|inherit."""
    if not isinstance(tier, str) or not tier.strip():
        return "inherit"
    norm = tier.strip().lower()
    if norm in ("inherit", "flash_lite", "flash", "pro"):
        return norm
    if norm.endswith("-hydrogen-low") or norm.endswith("-flash-low"):
        return "flash_lite"
    if (
        re.search(r"-(hydrogen|flash)-(medium|high|xhigh)$", norm)
        or norm in ("gemini-4-hydrogen", "gemini-3.8-flash")
    ):
        return "flash"
    if re.search(r"-(neon|argon|carbon|pro)(-(low|medium|high|xhigh))?$", norm):
        return "pro"
    return "flash"


def _resolve_sub_dispatch_model(step, skill_name, fallback="pro"):
    """Resolve agy model enum for a loop subDispatch skill from step metadata."""
    sub_dispatches = (step.get("loop") or {}).get("subDispatch") or []
    for entry in sub_dispatches:
        if isinstance(entry, dict) and entry.get("skill") == skill_name:
            tier = entry.get("model") or entry.get("agyModel")
            if tier:
                return to_agy_model(tier)
    return to_agy_model(fallback) if fallback else "pro"


def _parse_run_command_output(raw):
    if not isinstance(raw, str):
        return 0, str(raw or ""), ""
    if "Tool is running as a background task" in raw:
        return 124, raw, "Command exceeded synchronous WaitMsBeforeAsync window"
    code_match = re.search(r"Command exited with code (-?\d+)\.", raw)
    exit_code = int(code_match.group(1)) if code_match else 0
    if "Command output:\n" in raw:
        output = raw.split("Command output:\n", 1)[1]
    elif "Command output:" in raw:
        output = raw.split("Command output:", 1)[1].lstrip("\r\n")
    else:
        output = raw
    return exit_code, output.strip(), ""


async def run_cmd(command, summary="Run shell command", cwd=None):
    """Run a shell command via call_tool('run_command', ...) with cwd scoping."""
    full_cmd = command
    if cwd and str(Path(cwd).resolve()) != str(Path.cwd().resolve()):
        full_cmd = f"cd {shlex.quote(str(cwd))} && {command}"
    _wf_log(f"[cmd] {summary}")
    try:
        raw = await call_tool(
            "run_command",
            CommandLine=full_cmd,
            WaitMsBeforeAsync=10000,
        )
        return _parse_run_command_output(raw)
    except NameError:
        proc = await asyncio.to_thread(
            subprocess.run,
            full_cmd,
            shell=True,
            cwd=cwd or None,
            capture_output=True,
            text=True,
        )
        return proc.returncode, (proc.stdout or "").strip(), (proc.stderr or "").strip()
    except Exception as exc:
        if getattr(exc, "denied", False):
            raise
        msg = getattr(exc, "message", None) or str(exc)
        return 1, "", msg


def _parse_json_output(text):
    if not text:
        return None
    stripped = text.strip()
    try:
        return json.loads(stripped)
    except Exception:
        pass
    for line in reversed(stripped.splitlines()):
        cand = line.strip()
        if cand.startswith("{") and cand.endswith("}"):
            try:
                return json.loads(cand)
            except Exception:
                continue
    brace_idx = stripped.find("{")
    if brace_idx != -1:
        try:
            return json.loads(stripped[brace_idx:])
        except Exception:
            pass
    return None


def _derive_branch_meta(plan_file, fallback_branch):
    logical_type = "feature"
    slug_source = fallback_branch or "feature-branch"
    if plan_file and Path(plan_file).is_file():
        try:
            for line in Path(plan_file).read_text(encoding="utf-8").splitlines():
                if line.startswith("# "):
                    title = line[2:].strip()
                    title = re.sub(r"\s+implementation plan$", "", title, flags=re.I)
                    if title:
                        slug_source = title
                    break
        except OSError:
            pass
    if re.search(r"\b(fix|bug|hotfix)\b", slug_source, re.I):
        logical_type = "fix"
    elif re.search(r"\b(chore|refactor|cleanup|docs)\b", slug_source, re.I):
        logical_type = "chore"
    slug = re.sub(r"[^a-z0-9]+", "-", slug_source.lower()).strip("-")[:48] or "feature-branch"
    return logical_type, slug


def _review_meets_threshold(counts, threshold):
    c = int(counts.get("critical", 0) or 0)
    h = int(counts.get("high", 0) or 0)
    m = int(counts.get("medium", 0) or 0)
    l = int(counts.get("low", 0) or 0)
    t = (threshold or "high").lower()
    if t == "critical":
        return c > 0
    if t == "high":
        return (c + h) > 0
    if t == "medium":
        return (c + h + m) > 0
    if t == "low":
        return (c + h + m + l) > 0
    return (c + h) > 0


def _has_package_script(work_dir, script_name):
    pkg = Path(work_dir) / "package.json"
    if not pkg.is_file():
        return False
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
        return isinstance(data.get("scripts"), dict) and bool(data["scripts"].get(script_name))
    except Exception:
        return False


def _extract_flag_value(args_str, flag_name):
    m = re.search(rf"(?:^|\s){re.escape(flag_name)}\s+(?:\"([^\"]+)\"|'([^']+)'|(\S+))", args_str or "")
    if not m:
        return None
    return m.group(1) or m.group(2) or m.group(3)


async def _run_ship_state(plugin_root, work_dir, subcommand_args, summary="Update ship state"):
    script = str(Path(plugin_root) / "scripts" / "state" / "ship.js")
    cmd = f"node {shlex.quote(script)} {subcommand_args}"
    return await run_cmd(cmd, summary=summary, cwd=work_dir)


async def _run_ship_todos(plugin_root, work_dir, state_file, event_args):
    if not state_file:
        return
    script = str(Path(plugin_root) / "scripts" / "lib" / "ship-todos.js")
    cmd = f"node {shlex.quote(script)} --state-file {shlex.quote(state_file)} {event_args}"
    rc, out, _ = await run_cmd(cmd, summary="Emit pipeline progress", cwd=work_dir)
    if rc == 0 and out:
        parsed = _parse_json_output(out)
        if isinstance(parsed, dict) and parsed.get("marker"):
            _wf_log(parsed["marker"])


async def _cleanup_pipeline(plugin_root, work_dir, state_file, steps_count, any_failed, ttl_days=None):
    if steps_count >= 2 and state_file:
        await _run_ship_todos(plugin_root, work_dir, state_file, "--event cleanup --current-step cleanup")
    args_parts = ["cleanup-pipeline"]
    if any_failed:
        args_parts.append("--force")
    if ttl_days is not None:
        args_parts.extend(["--ttl-days", str(ttl_days)])
    rc, out, err = await _run_ship_state(
        plugin_root,
        work_dir,
        " ".join(args_parts),
        summary="Cleanup ship pipeline state",
    )
    if steps_count >= 2 and state_file:
        await _run_ship_todos(
            plugin_root,
            work_dir,
            state_file,
            "--event step --current-step cleanup --mark-completed cleanup",
        )
    return {"exit_code": rc, "report": _parse_json_output(out) or out, "stderr": err}


async def _fail_step(plugin_root, work_dir, step_name, err_msg, step_outcomes, **extra):
    """Record step failure in ship state and append to step_outcomes."""
    await _run_ship_state(
        plugin_root,
        work_dir,
        f"fail --step {shlex.quote(step_name)} --error {shlex.quote(err_msg)}",
        summary=f"Fail step {step_name}",
    )
    step_outcomes.append({"step": step_name, "status": "failed", "error": err_msg, **extra})


async def _complete_step(plugin_root, work_dir, state_file, flags, step_name, summary_txt, step_outcomes, emit_todo=True, **extra):
    """Record step completion in ship state, emit optional todo marker, and append outcome."""
    await _run_ship_state(
        plugin_root,
        work_dir,
        f"complete --step {shlex.quote(step_name)} --result {shlex.quote(summary_txt)}",
        summary=f"Complete step {step_name}",
    )
    if emit_todo and len(flags.get("steps", [])) >= 2 and state_file:
        await _run_ship_todos(
            plugin_root,
            work_dir,
            state_file,
            f"--event step --current-step {shlex.quote(step_name)} --mark-completed {shlex.quote(step_name)}",
        )
    step_outcomes.append({"step": step_name, "status": "completed", "summary": summary_txt, **extra})


async def _cleanup_review_artifacts(plugin_root, work_dir, manifest_file):
    """Clean up review manifest and sdlc-review-* temp dir via review-cleanup.js safety guard."""
    if not manifest_file:
        return None
    cleanup_script = str(Path(plugin_root) / "scripts" / "util" / "review-cleanup.js")
    rc, out, err = await run_cmd(
        f"node {shlex.quote(cleanup_script)} {shlex.quote(str(manifest_file))}",
        summary="Clean up review artifacts",
        cwd=work_dir,
    )
    return {"exit_code": rc, "output": out, "stderr": err}


async def _run_execute_step(
    step,
    wf_args,
    flags,
    prior_status,
    plan_file,
    state_file,
    execute_branch,
    work_dir,
    plugin_root,
    prepare_file,
    artifacts,
    step_outcomes,
):
    """Run execute-plan-sdlc directly at Depth 1 via execute.py::run_execute."""
    if plan_file and state_file:
        await _run_ship_todos(
            plugin_root,
            work_dir,
            state_file,
            f"--plan-file {shlex.quote(plan_file)} --event execute --current-step execute",
        )

    await _run_ship_state(plugin_root, work_dir, "start --step execute", summary="Start step execute")

    step_args = step.get("args") or ""
    exec_wf_args = {
        "plan_file": plan_file,
        "quality": flags.get("quality") or wf_args.get("quality") or "balanced",
        "auto": bool(flags.get("auto")),
        "resume": bool(flags.get("resume") and prior_status == "in_progress"),
        "commit_waves": bool(flags.get("executeCommitWaves") or "--commit-waves" in step_args),
        "branch": execute_branch,
        "approve_high_risk": bool(wf_args.get("approve_high_risk")),
        "skip_high_risk": bool(wf_args.get("skip_high_risk")),
        "cwd": work_dir,
        "plugin_root": plugin_root,
    }
    for opt_key in ("test_command", "standard_worker_enum", "prior_wave_context_caps", "guardrails"):
        if opt_key in wf_args:
            exec_wf_args[opt_key] = wf_args[opt_key]

    try:
        exec_ns = _load_subworkflow("skills/execute-plan-sdlc/workflows/execute.py", plugin_root)
        exec_res = await exec_ns["run_execute"](
            wf_args=exec_wf_args,
            cwd=work_dir,
            plugin_root=plugin_root,
        )
    except Exception as exc:
        await _fail_step(plugin_root, work_dir, "execute", f"execute-plan-sdlc failed: {exc}", step_outcomes)
        return False, None

    if isinstance(exec_res, dict) and exec_res.get("status") == "needs_consent":
        paused = {
            **exec_res,
            "status": "needs_consent",
            "gate": exec_res.get("gate") or "high_risk_wave",
            "state_file": state_file,
            "work_dir": work_dir,
            "prepare_output_file": prepare_file,
        }
        return False, paused

    if isinstance(exec_res, dict) and exec_res.get("status") == "skipped":
        artifacts["execute"] = exec_res
        reason = "high-risk wave skipped"
        await _run_ship_state(
            plugin_root,
            work_dir,
            f"skip --step execute --reason {shlex.quote(reason)}",
            summary="Skip step execute",
        )
        step_outcomes.append({"step": "execute", "status": "skipped", "reason": reason})
        return True, None

    if (
        not isinstance(exec_res, dict)
        or exec_res.get("status") not in ("complete", "completed", "success", None)
        or exec_res.get("error")
    ):
        err_msg = (
            (exec_res or {}).get("error")
            or (exec_res or {}).get("summary")
            or f"execute-plan-sdlc failed ({(exec_res or {}).get('tasks_completed', 0)}/{(exec_res or {}).get('tasks_total', '?')} tasks)"
        )
        await _fail_step(plugin_root, work_dir, "execute", err_msg, step_outcomes)
        return False, None

    artifacts["execute"] = exec_res

    git_ops = str(Path(plugin_root) / "scripts" / "util" / "ship-git-ops.js")
    src, sout, serr = await run_cmd(
        f"node {shlex.quote(git_ops)} stage-post-execute",
        summary="Stage post-execute files",
        cwd=work_dir,
    )
    stage_res = _parse_json_output(sout) or {}
    if src != 0 or stage_res.get("error"):
        err_msg = stage_res.get("error") or serr or sout or "stage-post-execute failed"
        await _fail_step(plugin_root, work_dir, "execute", err_msg, step_outcomes)
        return False, None
    artifacts["post_execute_staged"] = stage_res.get("staged", [])

    summary_txt = str(
        exec_res.get("summary")
        or f"execute completed: {exec_res.get('tasks_completed', 0)}/{exec_res.get('tasks_total', 0)} tasks in {exec_res.get('waves_executed', 0)} wave(s)"
    )[:240]
    await _complete_step(plugin_root, work_dir, state_file, flags, "execute", summary_txt, step_outcomes)
    return True, None


async def _run_review_step(
    step,
    step_idx,
    steps,
    wf_args,
    flags,
    existing_state_steps,
    state_file,
    work_dir,
    plugin_root,
    artifacts,
    step_outcomes,
):
    """Run review-sdlc directly at Depth 1 via review.py::run_review and persist verdict/counts."""
    await _run_ship_state(plugin_root, work_dir, "start --step review", summary="Start step review")

    rev_wf_args = {
        "review_args": step.get("args") or "--committed",
        "cwd": work_dir,
        "plugin_root": plugin_root,
    }
    if wf_args.get("review_manifest_file"):
        rev_wf_args["manifest_file"] = wf_args["review_manifest_file"]

    empty_counts = {"critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0}
    try:
        rev_ns = _load_subworkflow("skills/review-sdlc/workflows/review.py", plugin_root)
        rev_res = await rev_ns["run_review"](
            wf_args=rev_wf_args,
            cwd=work_dir,
            plugin_root=plugin_root,
        )
    except Exception as exc:
        await _fail_step(plugin_root, work_dir, "review", f"review-sdlc failed: {exc}", step_outcomes)
        return False, None, empty_counts, None, None

    if not isinstance(rev_res, dict) or rev_res.get("status") not in ("completed", "success"):
        if isinstance(rev_res, dict) and rev_res.get("manifest_file"):
            await _cleanup_review_artifacts(plugin_root, work_dir, rev_res.get("manifest_file"))
        err_msg = (rev_res or {}).get("error") or (rev_res or {}).get("summary") or "review-sdlc returned failure"
        await _fail_step(plugin_root, work_dir, "review", err_msg, step_outcomes)
        return False, None, empty_counts, None, None

    review_verdict = rev_res.get("verdict") or "APPROVED"
    raw_counts = rev_res.get("counts") or {}
    review_counts = {
        k: int(raw_counts.get(k, 0) or 0)
        for k in ("critical", "high", "medium", "low", "info")
    }
    comment_file = rev_res.get("comment_file")
    manifest_file = rev_res.get("manifest_file")
    artifacts["review"] = rev_res

    counts_json = json.dumps(review_counts)
    decide_parts = []
    if comment_file:
        decide_parts.append(f"CommentFile: {comment_file}")
    if manifest_file:
        decide_parts.append(f"ManifestFile: {manifest_file}")
    decide_parts.append(f"Verdict: {review_verdict}")
    decide_parts.append(f"Counts: {counts_json}")
    await _run_ship_state(
        plugin_root,
        work_dir,
        f"decide --step review --text {shlex.quote(' | '.join(decide_parts))}",
        summary="Record review verdict",
    )

    for df in rev_res.get("deferred_findings") or []:
        sev = df.get("severity") or "medium"
        fpath = df.get("file") or "unknown"
        title = df.get("title") or "Deferred finding"
        line_arg = f" --line {shlex.quote(str(df['line']))}" if df.get("line") else ""
        await _run_ship_state(
            plugin_root,
            work_dir,
            f"defer --severity {shlex.quote(sev)} --file {shlex.quote(fpath)}{line_arg} --title {shlex.quote(title)}",
            summary="Defer review finding",
        )

    threshold = flags.get("reviewThreshold") or "high"
    remaining_steps = steps[step_idx + 1:]
    needs_comment_downstream = (
        _review_meets_threshold(review_counts, threshold)
        and any(
            s.get("name") == "received-review"
            and s.get("status") != "skipped"
            and not (flags.get("resume") and existing_state_steps.get("received-review") in ("completed", "skipped"))
            for s in remaining_steps
        )
    )
    if manifest_file and not needs_comment_downstream:
        await _cleanup_review_artifacts(plugin_root, work_dir, manifest_file)
        manifest_file = None

    total_findings = rev_res.get("total_findings")
    if total_findings is None:
        total_findings = sum(review_counts.values())
    summary_txt = str(
        rev_res.get("summary")
        or f"review completed: {review_verdict} ({total_findings} finding(s))"
    )[:240]
    await _complete_step(plugin_root, work_dir, state_file, flags, "review", summary_txt, step_outcomes)
    return True, review_verdict, review_counts, comment_file, manifest_file


async def _run_verify_pipeline_step(
    step,
    wf_args,
    flags,
    auto,
    state_file,
    work_dir,
    plugin_root,
    prepare_file,
    artifacts,
    step_outcomes,
):
    """Poll CI checks and run deterministic log fetch/classification before any CI fix agent."""
    await _run_ship_state(plugin_root, work_dir, "start --step verify-pipeline", summary="Start verify-pipeline")
    vp_script = str(Path(plugin_root) / "scripts" / "util" / "verify-pipeline.js")
    fetch_logs_script = str(Path(plugin_root) / "scripts" / "util" / "fetch-logs.js")
    classify_script = str(Path(plugin_root) / "scripts" / "skill" / "verify-pipeline-sdlc-classify.js")
    max_iters = int(flags.get("verifyPipelineMaxIterations") or 3)
    vp_args = step.get("args", "")
    state_flag = f" --state-file {shlex.quote(state_file)}" if state_file else ""
    vp_final = {}
    paused_gate = None
    skip_ci_fix: bool = bool(wf_args.get("skip_ci_fix"))

    for iteration in range(max_iters):
        vrc, vout, _ = await run_cmd(
            f"node {shlex.quote(vp_script)} {vp_args}{state_flag}".strip(),
            summary=f"Verify CI pipeline (iter {iteration + 1})",
            cwd=work_dir,
        )
        vp_final = _parse_json_output(vout) or {"status": "error" if vrc != 0 else "green"}
        vp_status = vp_final.get("status")
        if vp_status in ("green", "skipped", "timeout", "error"):
            break
        if vp_status == "failed":
            if skip_ci_fix:
                vp_final["skipped_ci_fix"] = True
                artifacts["verify_pipeline"] = vp_final
                reason = "CI fix skipped by user"
                await _run_ship_state(
                    plugin_root,
                    work_dir,
                    f"skip --step verify-pipeline --reason {shlex.quote(reason)}",
                    summary="Skip verify-pipeline",
                )
                step_outcomes.append({"step": "verify-pipeline", "status": "skipped", "reason": reason, "result": vp_final})
                return vp_final, None
            if not auto and not wf_args.get("approve_ci_fix"):
                paused_gate = {
                    "status": "needs_consent",
                    "gate": "verify_pipeline",
                    "verify_pipeline": vp_final,
                    "state_file": state_file,
                    "work_dir": work_dir,
                    "prepare_output_file": prepare_file,
                }
                break

            pr_num = vp_final.get("prNumber") or (artifacts.get("pr") or {}).get("pr_number")
            failed_checks = vp_final.get("failedChecks") or []
            fallback_excerpt = "\n\n".join(
                f"=== {c.get('name', 'check')} ===\n{c.get('logsExcerpt', '')}"
                for c in failed_checks
                if isinstance(c, dict) and c.get("logsExcerpt")
            ).strip()

            tmp_inline_log = None
            try:
                if pr_num:
                    fl_cmd = f"node {shlex.quote(fetch_logs_script)} --pr-number {shlex.quote(str(pr_num))}"
                else:
                    with tempfile.NamedTemporaryFile(mode="w", suffix=".log", delete=False, encoding="utf-8") as tf:
                        tf.write(fallback_excerpt)
                        tmp_inline_log = tf.name
                    fl_cmd = f"node {shlex.quote(fetch_logs_script)} --logs {shlex.quote(tmp_inline_log)}"
                fl_rc, fl_out, fl_err = await run_cmd(fl_cmd, summary="Fetch failed CI logs", cwd=work_dir)
            finally:
                if tmp_inline_log:
                    Path(tmp_inline_log).unlink(missing_ok=True)

            log_text = (fl_out or "").strip()
            if not log_text and fallback_excerpt:
                log_text = fallback_excerpt

            if fl_rc != 0 and not log_text:
                abort_verdict = {
                    "status": "abort",
                    "reason": fl_err or fl_out or f"fetch-logs.js failed (exit {fl_rc})",
                }
                vp_final["verdict"] = abort_verdict
                artifacts["verify_pipeline_verdict"] = abort_verdict
                break

            tmp_cls_log = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", suffix=".log", delete=False, encoding="utf-8") as tf:
                    tf.write(log_text)
                    tmp_cls_log = tf.name
                _, cl_out, _ = await run_cmd(
                    f"node {shlex.quote(classify_script)} --logs-file {shlex.quote(tmp_cls_log)}",
                    summary="Classify CI failure logs",
                    cwd=work_dir,
                )
            finally:
                if tmp_cls_log:
                    Path(tmp_cls_log).unlink(missing_ok=True)

            cls_res = _parse_json_output(cl_out) or {
                "category": "unknown",
                "signals": [],
                "routingBucket": "always-proposal",
            }
            vp_final["classification"] = cls_res
            routing_bucket = cls_res.get("routingBucket") or "always-proposal"
            category = cls_res.get("category") or "unknown"
            signals = cls_res.get("signals") or []

            if routing_bucket == "always-proposal":
                if category == "unknown" and log_text:
                    summary_txt = f"Unclassified CI failure (always-proposal). Log excerpt:\n{log_text[-1000:]}"
                else:
                    summary_txt = (
                        f"Deterministic CI failure classification: category={category}, "
                        f"routingBucket=always-proposal, signals={signals}"
                    )
                proposal_verdict = {
                    "status": "proposal",
                    "category": category,
                    "routingBucket": routing_bucket,
                    "signals": signals,
                    "summary": summary_txt,
                    "suggestedPatch": f"Manual investigation required for `{category}` failure on PR #{pr_num or 'unknown'}.",
                }
                vp_final["verdict"] = proposal_verdict
                artifacts["verify_pipeline_verdict"] = proposal_verdict
                artifacts["verify_pipeline_proposal"] = proposal_verdict
                await _run_ship_state(
                    plugin_root,
                    work_dir,
                    f"decide --step verify-pipeline --text {shlex.quote(f'Proposal ({category}): {summary_txt[:180]}')}",
                    summary="Record verify-pipeline deterministic proposal",
                )
                break

            fix_res = await agent(
                prompt=(
                    f"Working directory: {work_dir}\n"
                    f"Plugin root: {plugin_root}\n"
                    f"Apply a minimal fix for actionable CI failure on PR #{pr_num or ''}"
                    f"{' --auto' if auto else ''}.\n\n"
                    "## Pre-Computed Classification (Steps 1-2 Already Completed)\n"
                    f"- Category: `{category}` | Routing bucket: `{routing_bucket}`\n"
                    f"- Signals: `{json.dumps(signals)}`\n"
                    f"- Failed checks: {json.dumps(failed_checks)}\n\n"
                    f"### CI Failure Log Excerpt\n```\n{log_text[-4000:]}\n```\n\n"
                    "## Instructions\n"
                    "- Do NOT re-run `fetch-logs.js` or `verify-pipeline-sdlc-classify.js`.\n"
                    "- Apply only the minimal fix for the failing lint/test/type error; do NOT refactor or commit.\n"
                    "- Return structured JSON matching the schema via `finish`."
                ),
                schema=STEP_RESULT_SCHEMA,
                role="Ship: verify-pipeline-sdlc",
                type_name="self",
                workspace="inherit",
                model=_resolve_sub_dispatch_model(step, "verify-pipeline-sdlc", fallback="pro"),
            )
            if isinstance(fix_res, dict) and fix_res.get("status") in ("success", "fix-applied"):
                await agent(
                    prompt=(
                        f"Working directory: {work_dir}\n"
                        f"Plugin root: {plugin_root}\n"
                        "Execute `/commit-sdlc --auto` to commit and push the CI fix."
                    ),
                    schema=STEP_RESULT_SCHEMA,
                    role="Ship: commit CI fix",
                    type_name="self",
                    workspace="inherit",
                    model=_resolve_sub_dispatch_model(step, "commit-sdlc", fallback="pro"),
                )
            else:
                vp_final["fix_result"] = fix_res
                break

    if paused_gate:
        return None, paused_gate

    artifacts["verify_pipeline"] = vp_final
    await _run_ship_state(
        plugin_root,
        work_dir,
        f"complete --step verify-pipeline --result {shlex.quote(json.dumps(vp_final)[:200])}",
        summary="Complete verify-pipeline",
    )
    step_outcomes.append({"step": "verify-pipeline", "status": "completed", "result": vp_final})
    return vp_final, None


async def _run_await_remote_review_step(
    step,
    wf_args,
    auto,
    state_file,
    work_dir,
    plugin_root,
    prepare_file,
    artifacts,
    step_outcomes,
):
    """Await remote PR reviews and verify threads directly at Depth 1 via verify.py::run_verify."""
    await _run_ship_state(plugin_root, work_dir, "start --step await-remote-review", summary="Start await-remote-review")
    ar_script = str(Path(plugin_root) / "scripts" / "util" / "await-review.js")
    state_flag = f" --state-file {shlex.quote(state_file)}" if state_file else ""
    arc, aout, _ = await run_cmd(
        f"node {shlex.quote(ar_script)} {step.get('args', '')}{state_flag}".strip(),
        summary="Await remote PR review",
        cwd=work_dir,
    )
    ar_res = _parse_json_output(aout) or {"status": "error" if arc != 0 else "approved-clean"}

    if ar_res.get("status") == "actionable":
        if not auto and not wf_args.get("approve_remote_review"):
            return False, {
                "status": "needs_consent",
                "gate": "await_remote_review",
                "remote_review": ar_res,
                "state_file": state_file,
                "work_dir": work_dir,
                "prepare_output_file": prepare_file,
            }

        pr_num = ar_res.get("prNumber") or (artifacts.get("pr") or {}).get("pr_number")
        rr_parts = []
        if pr_num:
            rr_parts.append(f"--pr {shlex.quote(str(pr_num))}")
        if auto:
            rr_parts.append("--auto")
        verify_wf_args = {
            "received_review_args": " ".join(rr_parts),
            "cwd": work_dir,
            "plugin_root": plugin_root,
        }
        if wf_args.get("verify_manifest_file"):
            verify_wf_args["manifest_file"] = wf_args["verify_manifest_file"]

        try:
            verify_ns = _load_subworkflow("skills/received-review-sdlc/workflows/verify.py", plugin_root)
            ver_res = await verify_ns["run_verify"](
                wf_args=verify_wf_args,
                cwd=work_dir,
                plugin_root=plugin_root,
            )
        except Exception as exc:
            await _fail_step(plugin_root, work_dir, "await-remote-review", f"verify.py failed: {exc}", step_outcomes)
            return False, None

        artifacts["await_remote_review_verify"] = ver_res
        if not isinstance(ver_res, dict) or (
            ver_res.get("status") == "failed"
            and not ver_res.get("reportFile")
            and not ver_res.get("findings")
            and not ver_res.get("missingIds")
        ):
            err_msg = (ver_res or {}).get("error") or "verify.py failed to verify remote PR review threads"
            await _fail_step(plugin_root, work_dir, "await-remote-review", err_msg, step_outcomes)
            return False, None

        findings = ver_res.get("findings") or []
        missing_ids = ver_res.get("missingIds") or []
        report_file = ver_res.get("reportFile") or ""
        pr_meta = ver_res.get("pr") or {}
        pr_display = pr_meta.get("number") or pr_num or ""

        if findings or missing_ids:
            remote_fix_res = await agent(
                prompt=(
                    f"Working directory: {work_dir}\n"
                    f"Plugin root: {plugin_root}\n"
                    f"Respond to pre-verified PR review threads for PR #{pr_display}"
                    f"{' --auto' if auto else ''}.\n\n"
                    "## Pre-Verified Findings (Step 3 Already Completed — Skip Re-Verification)\n"
                    "- Do NOT run `verify.py`, `received-review-orchestrator`, or Step 3b re-verification.\n"
                    "- Treat any IDs in `missingIds` as `cannot-verify`.\n"
                    f"- Full verification report file: `{report_file}` (read only for pushback or `needs discussion`).\n\n"
                    f"### Pre-Verified `findings[]`\n```json\n{json.dumps(findings, indent=2)}\n```\n\n"
                    f"### `missingIds`\n```json\n{json.dumps(missing_ids)}\n```\n\n"
                    "## Instructions\n"
                    "- Follow `received-review-sdlc` Steps 4-12: evaluate verdicts, draft technical responses (no performative openers), "
                    "apply `agree, will fix` edits, verify with `run-truncated.js`, validate reply links via "
                    "`scripts/util/received-review-validate-links.js`, and post PR thread replies + resolve addressed threads.\n"
                    "- Do NOT run `git commit` or `git push` (handled by `commit-sdlc` below).\n"
                    "- Return structured JSON matching the schema via `finish`."
                ),
                schema=STEP_RESULT_SCHEMA,
                role="Ship: remote review fix/reply",
                type_name="self",
                workspace="inherit",
                model=_resolve_sub_dispatch_model(step, "received-review-sdlc", fallback="pro"),
            )
            artifacts["await_remote_review_fix"] = remote_fix_res

        _, st_out, _ = await run_cmd("git status --porcelain", summary="Check remote review changes", cwd=work_dir)
        if st_out.strip():
            await agent(
                prompt=(
                    f"Working directory: {work_dir}\n"
                    f"Plugin root: {plugin_root}\n"
                    "Execute `/commit-sdlc --auto` to commit and push remote review fixes."
                ),
                schema=STEP_RESULT_SCHEMA,
                role="Ship: commit remote review fixes",
                type_name="self",
                workspace="inherit",
                model=_resolve_sub_dispatch_model(step, "commit-sdlc", fallback="pro"),
            )

    await _run_ship_state(
        plugin_root,
        work_dir,
        f"complete --step await-remote-review --result {shlex.quote(str(ar_res.get('status') or 'done'))}",
        summary="Complete await-remote-review",
    )
    step_outcomes.append({"step": "await-remote-review", "status": "completed", "result": ar_res})
    return True, None


async def main():
    """Execute the deterministic ship-sdlc workflow."""
    wf_args = _wf_args()
    cwd = _resolve_cwd()
    plugin_root = _resolve_plugin_root(cwd)
    raw_args = str(wf_args.get("raw_args") or "").strip()

    _wf_phase("Prepare & Validate")
    prepare_file = wf_args.get("prepare_output_file")
    owns_prepare_file = False
    if not prepare_file or not Path(prepare_file).is_file():
        ship_js = str(Path(plugin_root) / "scripts" / "skill" / "ship.js")
        has_plan_flag = "" if "--gc" in raw_args or "--has-plan" in raw_args else " --has-plan"
        cmd = f"node {shlex.quote(ship_js)} --output-file{has_plan_flag} {raw_args}".strip()
        rc, out, err = await run_cmd(cmd, summary="Run ship.js prepare", cwd=cwd)
        lines = [ln.strip() for ln in out.splitlines() if ln.strip()]
        prepare_file = lines[-1] if lines else ""
        owns_prepare_file = True
        if not prepare_file or not Path(prepare_file).is_file():
            result = {
                "status": "failed",
                "gate": "prepare",
                "exit_code": rc,
                "error": err or out or "ship.js failed to emit manifest path",
            }
            print(json.dumps(result, indent=2))
            return result

    prepare = json.loads(Path(prepare_file).read_text(encoding="utf-8"))

    if prepare.get("action") == "gc":
        if owns_prepare_file:
            Path(prepare_file).unlink(missing_ok=True)
        result = {"status": "gc", "report": prepare.get("report"), "warnings": prepare.get("warnings", [])}
        print(json.dumps(result, indent=2))
        return result

    if prepare.get("errors"):
        result = {
            "status": "blocked",
            "gate": "prepare_validation",
            "errors": prepare["errors"],
            "warnings": prepare.get("warnings", []),
            "prepare_output_file": prepare_file,
        }
        print(json.dumps(result, indent=2))
        return result

    flags = prepare.get("flags", {})
    context = prepare.get("context", {})
    steps = prepare.get("steps", [])
    resume_info = prepare.get("resume", {})
    auto = bool(flags.get("auto"))

    if flags.get("dryRun"):
        if owns_prepare_file:
            Path(prepare_file).unlink(missing_ok=True)
        result = {
            "status": "dry_run",
            "flags": flags,
            "context": context,
            "steps": steps,
            "validation": prepare.get("validation", {}),
        }
        print(json.dumps(result, indent=2))
        return result

    _wf_phase("State & Workspace Setup")
    work_dir = cwd
    current_branch = context.get("currentBranch") or "HEAD"
    default_branch = context.get("defaultBranch") or "main"
    execute_branch = context.get("expectedBranch") or current_branch
    plan_file = context.get("planFile") or flags.get("planFile")
    state_file = None
    existing_state_steps = {}
    review_counts = {"critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0}
    review_verdict = None
    review_comment_file = wf_args.get("review_comment_file")
    review_manifest_file = wf_args.get("review_manifest_file")
    review_ran = False
    received_review_ran = False

    if flags.get("resume") and resume_info.get("found"):
        state_file = resume_info.get("fullPath") or resume_info.get("stateFile")
        if not context.get("worktree", {}).get("inLinkedWorktree"):
            wt_script = str(Path(plugin_root) / "scripts" / "util" / "worktree-lifecycle.js")
            rc, out, _ = await run_cmd(
                f"node {shlex.quote(wt_script)} resolve --branch {shlex.quote(current_branch)}",
                summary="Resolve worktree on resume",
                cwd=cwd,
            )
            wt = _parse_json_output(out) or {}
            if wt.get("found") and wt.get("exists") and wt.get("path"):
                work_dir = wt["path"]
        rc, out, _ = await _run_ship_state(plugin_root, work_dir, "read", summary="Read resumed ship state")
        st_data = _parse_json_output(out) or {}
        for st_step in st_data.get("steps", []):
            key = st_step.get("name") or st_step.get("id")
            if key:
                existing_state_steps[key] = st_step.get("status")
        if existing_state_steps.get("review") == "completed":
            review_ran = True
            for dec in reversed(st_data.get("decisions") or []):
                if dec.get("step") == "review" and isinstance(dec.get("text"), str):
                    txt = dec["text"]
                    cfm = re.search(r"CommentFile:\s*([^|\n]+)", txt)
                    if cfm and not review_comment_file:
                        cand = cfm.group(1).strip()
                        if cand and cand != "None":
                            review_comment_file = cand
                    mfm = re.search(r"ManifestFile:\s*([^|\n]+)", txt)
                    if mfm and not review_manifest_file:
                        cand = mfm.group(1).strip()
                        if cand and cand != "None":
                            review_manifest_file = cand
                    vm = re.search(r"Verdict:\s*([^|]+)", txt)
                    if vm and not review_verdict:
                        review_verdict = vm.group(1).strip()
                    cm = re.search(r"Counts:\s*(\{.*\})", txt)
                    if cm:
                        parsed_counts = _parse_json_output(cm.group(1))
                        if isinstance(parsed_counts, dict):
                            for k in review_counts:
                                if k in parsed_counts:
                                    review_counts[k] = int(parsed_counts[k] or 0)
                            break
            if isinstance(wf_args.get("review_counts"), dict):
                for k in review_counts:
                    if k in wf_args["review_counts"]:
                        review_counts[k] = int(wf_args["review_counts"][k] or 0)
        if existing_state_steps.get("received-review") == "completed":
            received_review_ran = True
        if len(flags.get("steps", [])) >= 2 and state_file:
            await _run_ship_todos(
                plugin_root,
                work_dir,
                state_file,
                f"--event resume --current-step {shlex.quote(str(resume_info.get('nextPendingStep') or 'execute'))}",
            )
    else:
        ws_flag = wf_args.get("workspace_flag") or flags.get("workspace") or "prompt"
        if ws_flag == "prompt" and not auto:
            result = {
                "status": "needs_consent",
                "gate": "workspace_mode",
                "current_branch": current_branch,
                "default_branch": default_branch,
                "prepare_output_file": prepare_file,
                "message": "Workspace mode is 'prompt' — ask user to select branch, worktree, or continue.",
            }
            print(json.dumps(result, indent=2))
            return result

        flags_json = json.dumps(flags)
        step_names = [s.get("name") for s in steps if s.get("name") and s.get("name") != "cleanup"]
        steps_arg = f" --steps {shlex.quote(json.dumps(step_names))}" if step_names else ""
        rc, out, err = await _run_ship_state(
            plugin_root,
            cwd,
            f"init --branch {shlex.quote(current_branch)} --flags {shlex.quote(flags_json)}{steps_arg}",
            summary="Initialize ship state",
        )
        init_res = _parse_json_output(out) or {}
        state_file = init_res.get("filePath")
        if rc != 0 or not state_file:
            result = {
                "status": "failed",
                "gate": "state_init",
                "error": err or out or "Failed to initialize ship state",
            }
            print(json.dumps(result, indent=2))
            return result

        if len(flags.get("steps", [])) >= 2:
            await _run_ship_todos(plugin_root, cwd, state_file, "--event init")

        if ws_flag != "continue" or current_branch == default_branch:
            logical_type, derived_slug = _derive_branch_meta(plan_file, current_branch)
            logical_type = wf_args.get("logical_type") or logical_type
            derived_slug = wf_args.get("derived_slug") or derived_slug
            setup_script = str(Path(plugin_root) / "scripts" / "util" / "ship-workspace-setup.js")
            setup_cmd = (
                f"node {shlex.quote(setup_script)} "
                f"--workspace-flag {shlex.quote(ws_flag)} "
                f"--prepare-output-file {shlex.quote(prepare_file)} "
                f"--logical-type {shlex.quote(logical_type)} "
                f"--derived-slug {shlex.quote(derived_slug)}"
            )
            rc, out, err = await run_cmd(setup_cmd, summary="Setup ship workspace", cwd=cwd)
            setup_res = _parse_json_output(out) or {}
            if rc != 0 or setup_res.get("status") == "error":
                cleanup_info = await _cleanup_pipeline(
                    plugin_root, cwd, state_file, len(flags.get("steps", [])), any_failed=True, ttl_days=wf_args.get("ttl_days")
                )
                result = {
                    "status": "failed",
                    "gate": "workspace_setup",
                    "error": setup_res.get("error") or err or out,
                    "state_file": state_file,
                    "cleanup": cleanup_info,
                }
                print(json.dumps(result, indent=2))
                return result
            if setup_res.get("executeBranch"):
                execute_branch = setup_res["executeBranch"]
            if setup_res.get("worktreePath"):
                work_dir = setup_res["worktreePath"]

    _wf_phase("Pipeline Execution")
    step_outcomes = []
    artifacts = {"branch": execute_branch, "work_dir": work_dir}
    rebased_done = False
    any_failed = False
    paused_gate = None

    for step_idx, step in enumerate(steps):
        name = step.get("name")
        if name == "cleanup":
            continue

        prior_status = existing_state_steps.get(name)
        if flags.get("resume") and prior_status in ("completed", "skipped"):
            _wf_log(f"[resume-skip] {name} already {prior_status}")
            step_outcomes.append({"step": name, "status": prior_status, "resumed_skip": True})
            continue

        status = step.get("status")
        if status == "skipped":
            reason = step.get("reason") or "skipped"
            await _run_ship_state(
                plugin_root, work_dir,
                f"skip --step {shlex.quote(name)} --reason {shlex.quote(reason)}",
                summary=f"Skip step {name}",
            )
            step_outcomes.append({"step": name, "status": "skipped", "reason": reason, "skipSource": step.get("skipSource")})
            continue

        if len(flags.get("steps", [])) >= 2 and state_file:
            await _run_ship_todos(
                plugin_root, work_dir, state_file,
                f"--event step --current-step {shlex.quote(name)}",
            )

        # ---- Rebase before version (or before pr if version skipped) ----
        if name in ("version", "pr") and not rebased_done and any(
            o.get("step") in ("commit", "commit-fixes") and o.get("status") == "completed" for o in step_outcomes
        ):
            rebased_done = True
            rebase_script = str(Path(plugin_root) / "scripts" / "util" / "rebase-onto-base.js")
            rc, out, err = await run_cmd(
                f"node {shlex.quote(rebase_script)} --base {shlex.quote(default_branch)}",
                summary=f"Rebase onto {default_branch}",
                cwd=work_dir,
            )
            rb = _parse_json_output(out) or {}
            rb_status = rb.get("status")
            artifacts["rebase"] = rb
            if rb_status == "conflicts":
                action = wf_args.get("rebase_conflict_action")
                if action not in ("skip", "merge"):
                    paused_gate = {
                        "status": "paused_conflicts" if auto else "needs_consent",
                        "gate": "rebase_conflicts",
                        "base": default_branch,
                        "files": rb.get("files", []),
                        "state_file": state_file,
                        "work_dir": work_dir,
                        "prepare_output_file": prepare_file,
                    }
                    break
                if action == "merge":
                    mrc, _, merr = await run_cmd(
                        f"git merge {shlex.quote('origin/' + default_branch)}",
                        summary="Fallback merge origin base",
                        cwd=work_dir,
                    )
                    if mrc != 0:
                        await run_cmd("git merge --abort", summary="Abort conflicted merge", cwd=work_dir)
                        paused_gate = {
                            "status": "paused_conflicts",
                            "gate": "rebase_conflicts",
                            "base": default_branch,
                            "files": rb.get("files", []),
                            "error": merr,
                            "state_file": state_file,
                            "work_dir": work_dir,
                            "prepare_output_file": prepare_file,
                        }
                        break

        # ---- Step-specific conditional & inline/Depth-1 handlers ----
        if name == "received-review":
            threshold = flags.get("reviewThreshold") or "high"
            if not review_ran or not _review_meets_threshold(review_counts, threshold):
                if review_manifest_file:
                    await _cleanup_review_artifacts(plugin_root, work_dir, review_manifest_file)
                    review_manifest_file = None
                reason = "review did not meet threshold"
                await _run_ship_state(
                    plugin_root, work_dir,
                    f"skip --step {shlex.quote(name)} --reason {shlex.quote(reason)}",
                    summary="Skip received-review",
                )
                step_outcomes.append({"step": name, "status": "skipped", "reason": reason})
                continue
            if not auto and not wf_args.get("approve_received_review"):
                paused_gate = {
                    "status": "needs_consent",
                    "gate": "received_review",
                    "verdict": review_verdict,
                    "counts": review_counts,
                    "review_comment_file": review_comment_file,
                    "state_file": state_file,
                    "work_dir": work_dir,
                    "prepare_output_file": prepare_file,
                }
                break

        if name == "commit-fixes":
            if not received_review_ran:
                reason = "received-review not triggered"
                await _run_ship_state(
                    plugin_root, work_dir,
                    f"skip --step {shlex.quote(name)} --reason {shlex.quote(reason)}",
                    summary="Skip commit-fixes",
                )
                step_outcomes.append({"step": name, "status": "skipped", "reason": reason})
                continue
            _, st_out, _ = await run_cmd("git status --porcelain", summary="Check review fix changes", cwd=work_dir)
            if not st_out.strip():
                reason = "no working-tree changes after received-review"
                await _run_ship_state(
                    plugin_root, work_dir,
                    f"skip --step {shlex.quote(name)} --reason {shlex.quote(reason)}",
                    summary="Skip commit-fixes",
                )
                step_outcomes.append({"step": name, "status": "skipped", "reason": reason})
                continue

        if name == "archive-openspec":
            change_name = _extract_flag_value(step.get("args", ""), "--change")
            if not change_name:
                await _run_ship_state(
                    plugin_root, work_dir,
                    "skip --step archive-openspec --reason 'missing change name'",
                    summary="Skip archive-openspec",
                )
                step_outcomes.append({"step": name, "status": "skipped", "reason": "missing change name"})
                continue
            await _run_ship_state(plugin_root, work_dir, "start --step archive-openspec", summary="Start archive-openspec")
            val_script = str(Path(plugin_root) / "scripts" / "util" / "openspec-validate.js")
            vrc, vout, verr = await run_cmd(
                f"node {shlex.quote(val_script)} {shlex.quote(change_name)}",
                summary="Validate OpenSpec change",
                cwd=work_dir,
            )
            val_manifest_path = vout.splitlines()[-1].strip() if vout else ""
            val_data = {}
            if val_manifest_path and Path(val_manifest_path).is_file():
                val_data = json.loads(Path(val_manifest_path).read_text(encoding="utf-8"))
                Path(val_manifest_path).unlink(missing_ok=True)
            if vrc != 0 or not val_data.get("ok"):
                err_msg = "; ".join(val_data.get("errors") or []) or val_data.get("stderr") or verr or "OpenSpec validation failed"
                await _fail_step(plugin_root, work_dir, name, err_msg, step_outcomes)
                any_failed = True
                break
            if not auto and not wf_args.get("approve_openspec_archive"):
                paused_gate = {
                    "status": "needs_consent",
                    "gate": "openspec_archive",
                    "change": change_name,
                    "state_file": state_file,
                    "work_dir": work_dir,
                    "prepare_output_file": prepare_file,
                }
                break
            arch_script = str(Path(plugin_root) / "scripts" / "util" / "openspec-archive.js")
            arc, aout, aerr = await run_cmd(
                f"node {shlex.quote(arch_script)} {shlex.quote(change_name)}",
                summary="Archive OpenSpec change",
                cwd=work_dir,
            )
            arch_manifest_path = aout.splitlines()[-1].strip() if aout else ""
            arch_data = {}
            if arch_manifest_path and Path(arch_manifest_path).is_file():
                arch_data = json.loads(Path(arch_manifest_path).read_text(encoding="utf-8"))
                Path(arch_manifest_path).unlink(missing_ok=True)
            if arc != 0 or not arch_data.get("ok"):
                err_msg = "; ".join(arch_data.get("errors") or []) or arch_data.get("stderr") or aerr or "OpenSpec archive failed"
                await _fail_step(plugin_root, work_dir, name, err_msg, step_outcomes)
                any_failed = True
                break
            git_ops = str(Path(plugin_root) / "scripts" / "util" / "ship-git-ops.js")
            grc, gout, gerr = await run_cmd(
                f"node {shlex.quote(git_ops)} commit-openspec-archive --change {shlex.quote(change_name)}",
                summary="Commit OpenSpec archive",
                cwd=work_dir,
            )
            commit_arch = _parse_json_output(gout) or {}
            if grc != 0:
                err_msg = commit_arch.get("reason") or gerr or "commit-openspec-archive failed"
                await _fail_step(plugin_root, work_dir, name, err_msg, step_outcomes)
                any_failed = True
                break
            summary_txt = f"openspec archive ({change_name}): {commit_arch.get('reason') or 'committed'}"
            await _run_ship_state(plugin_root, work_dir, f"complete --step archive-openspec --result {shlex.quote(summary_txt)}", summary="Complete archive-openspec")
            artifacts["openspec_archived"] = {"change": change_name, **commit_arch}
            step_outcomes.append({"step": name, "status": "completed", "summary": summary_txt})
            continue

        if name == "execute":
            ok, paused_gate = await _run_execute_step(
                step=step,
                wf_args=wf_args,
                flags=flags,
                prior_status=prior_status,
                plan_file=plan_file,
                state_file=state_file,
                execute_branch=execute_branch,
                work_dir=work_dir,
                plugin_root=plugin_root,
                prepare_file=prepare_file,
                artifacts=artifacts,
                step_outcomes=step_outcomes,
            )
            if paused_gate:
                break
            if not ok:
                any_failed = True
                break
            continue

        if name == "review":
            ok, rev_verdict, rev_counts, rev_comment, rev_manifest = await _run_review_step(
                step=step,
                step_idx=step_idx,
                steps=steps,
                wf_args=wf_args,
                flags=flags,
                existing_state_steps=existing_state_steps,
                state_file=state_file,
                work_dir=work_dir,
                plugin_root=plugin_root,
                artifacts=artifacts,
                step_outcomes=step_outcomes,
            )
            if not ok:
                any_failed = True
                break
            review_ran = True
            review_verdict = rev_verdict
            review_counts = rev_counts
            review_comment_file = rev_comment
            review_manifest_file = rev_manifest
            continue

        if name == "verify-pipeline":
            _, paused_gate = await _run_verify_pipeline_step(
                step=step,
                wf_args=wf_args,
                flags=flags,
                auto=auto,
                state_file=state_file,
                work_dir=work_dir,
                plugin_root=plugin_root,
                prepare_file=prepare_file,
                artifacts=artifacts,
                step_outcomes=step_outcomes,
            )
            if paused_gate:
                break
            continue

        if name == "await-remote-review":
            ok, paused_gate = await _run_await_remote_review_step(
                step=step,
                wf_args=wf_args,
                auto=auto,
                state_file=state_file,
                work_dir=work_dir,
                plugin_root=plugin_root,
                prepare_file=prepare_file,
                artifacts=artifacts,
                step_outcomes=step_outcomes,
            )
            if paused_gate:
                break
            if not ok:
                any_failed = True
                break
            continue

        if name == "learnings-commit":
            await _run_ship_state(plugin_root, work_dir, "start --step learnings-commit", summary="Start learnings-commit")
            git_ops = str(Path(plugin_root) / "scripts" / "util" / "ship-git-ops.js")
            lrc, lout, lerr = await run_cmd(
                f"node {shlex.quote(git_ops)} commit-learnings",
                summary="Commit pipeline learnings",
                cwd=work_dir,
            )
            lres = _parse_json_output(lout) or {}
            if lrc != 0 or lres.get("dirty"):
                err_msg = lres.get("postConditionReason") or lres.get("reason") or lerr or "commit-learnings failed"
                await _fail_step(plugin_root, work_dir, name, err_msg, step_outcomes)
                any_failed = True
                break
            await _run_ship_state(
                plugin_root, work_dir,
                f"complete --step learnings-commit --result {shlex.quote(json.dumps(lres))}",
                summary="Complete learnings-commit",
            )
            step_outcomes.append({"step": name, "status": "completed", "result": lres})
            continue

        # ---- Main-level leaf agent step dispatch (commit, received-review, commit-fixes, version, pr) ----
        skill_name = step.get("skill")
        step_args = (step.get("args") or "").strip()

        if name in LEAF_CONSENT_GATES:
            gate_name, approve_key = LEAF_CONSENT_GATES[name]
            approved = bool(
                auto
                or wf_args.get(approve_key)
                or (name == "commit-fixes" and wf_args.get("approve_commit_fixes"))
            )
            if not approved:
                paused_gate = {
                    "status": "needs_consent",
                    "gate": gate_name,
                    "step": name,
                    "skill": skill_name,
                    "args": step_args,
                    "branch": execute_branch,
                    "state_file": state_file,
                    "work_dir": work_dir,
                    "prepare_output_file": prepare_file,
                }
                break
            if not re.search(r"(?:^|\s)--auto(?:\s|$)", step_args):
                step_args = f"{step_args} --auto".strip()

        await _run_ship_state(plugin_root, work_dir, f"start --step {shlex.quote(name)}", summary=f"Start step {name}")

        step_model = to_agy_model(step.get("model"))
        step_schema = STEP_RESULT_SCHEMA
        if name == "version":
            step_schema = VERSION_STEP_SCHEMA
        elif name == "pr":
            step_schema = PR_STEP_SCHEMA

        if name == "received-review":
            threshold = flags.get("reviewThreshold") or "high"
            comment_ref = (
                f"Read the local review findings from `{review_comment_file}`."
                if review_comment_file
                else "Use the review findings from the preceding review step."
            )
            prompt_text = (
                f"Working directory: {work_dir}\n"
                f"Plugin root: {plugin_root}\n"
                f"Apply fixes for local pre-PR review findings (verdict={review_verdict}, "
                f"threshold={threshold}, counts={json.dumps(review_counts)})"
                f"{' --auto' if auto else ''}.\n\n"
                f"- {comment_ref}\n"
                "- This is a pre-PR local review — no GitHub PR threads exist yet, so do NOT invoke "
                "`verify.py`, `received-review.js`, `received-review-orchestrator`, or `gh` PR thread reply commands.\n"
                "- Implement minimal fixes for findings meeting the severity threshold, verify changes via "
                "`scripts/util/run-truncated.js`, and leave changes unstaged for `commit-fixes`.\n"
                "- Do NOT call `ask_question` — report structured data via `finish`."
            )
        else:
            prompt_text = (
                f"Working directory: {work_dir}\n"
                f"Plugin root: {plugin_root}\n"
                f"Execute skill `/{skill_name}` with arguments: `{step_args}`.\n"
                "Operate strictly within the working directory above. "
                "Do not call `ask_question` — report structured data via `finish`."
            )

        try:
            agent_res = await agent(
                prompt=prompt_text,
                schema=step_schema,
                role=f"Ship: {skill_name}",
                type_name="self",
                workspace="inherit",
                model=step_model,
            )
        except Exception as exc:
            await _fail_step(plugin_root, work_dir, name, f"{skill_name} failed: {exc}", step_outcomes)
            any_failed = True
            break

        if not isinstance(agent_res, dict) or agent_res.get("status") != "success":
            err_msg = (agent_res or {}).get("error") or (agent_res or {}).get("summary") or f"{skill_name} returned failure"
            await _fail_step(plugin_root, work_dir, name, err_msg, step_outcomes)
            any_failed = True
            break

        # ---- Deterministic Post-Gates ----
        if name == "commit" and _has_package_script(work_dir, "preflight"):
            trunc_script = str(Path(plugin_root) / "scripts" / "util" / "run-truncated.js")
            prc, pout, perr = await run_cmd(
                f"node {shlex.quote(trunc_script)} \"npm run preflight\"",
                summary="Run npm preflight gate",
                cwd=work_dir,
            )
            if prc != 0:
                err_msg = f"Preflight gate failed (exit {prc}): {(perr or pout)[-500:]}"
                await _fail_step(plugin_root, work_dir, "commit", err_msg, step_outcomes)
                step_outcomes[-1]["step"] = "preflight"
                step_outcomes[-1]["output"] = pout
                any_failed = True
                break

        if name == "received-review":
            received_review_ran = True
            artifacts["received_review"] = agent_res
            if review_manifest_file:
                await _cleanup_review_artifacts(plugin_root, work_dir, review_manifest_file)
                review_manifest_file = None

        if name == "version":
            new_tag = agent_res.get("new_tag")
            artifacts["version"] = agent_res
            if new_tag and execute_branch:
                va_script = str(Path(plugin_root) / "scripts" / "util" / "verify-ancestry.js")
                arc, aout, aerr = await run_cmd(
                    f"node {shlex.quote(va_script)} --new-tag {shlex.quote(new_tag)} --execute-branch {shlex.quote(execute_branch)}",
                    summary="Verify post-version ancestry",
                    cwd=work_dir,
                )
                if arc != 0:
                    err_msg = aerr or aout or f"verify-ancestry failed for {new_tag}"
                    await _fail_step(plugin_root, work_dir, name, err_msg, step_outcomes)
                    any_failed = True
                    break

        if name == "pr":
            artifacts["pr"] = agent_res

        summary_txt = str(agent_res.get("summary") or f"{name} completed")[:240]
        await _complete_step(plugin_root, work_dir, state_file, flags, name, summary_txt, step_outcomes)

    if paused_gate:
        paused_gate["steps_completed"] = step_outcomes
        paused_gate["artifacts"] = artifacts
        print(json.dumps(paused_gate, indent=2))
        return paused_gate

    if review_manifest_file and not any_failed:
        await _cleanup_review_artifacts(plugin_root, work_dir, review_manifest_file)
        review_manifest_file = None

    _wf_phase("Terminal Cleanup & Report")
    cleanup_info = await _cleanup_pipeline(
        plugin_root,
        work_dir,
        state_file,
        len(flags.get("steps", [])),
        any_failed=any_failed,
        ttl_days=wf_args.get("ttl_days"),
    )

    learn_script = str(Path(plugin_root) / "scripts" / "util" / "learn-status.js")
    _, learn_out, _ = await run_cmd(f"node {shlex.quote(learn_script)}", summary="Check learning status", cwd=work_dir)
    learn_status = _parse_json_output(learn_out)

    wt_script = str(Path(plugin_root) / "scripts" / "util" / "worktree-lifecycle.js")
    _, wt_out, _ = await run_cmd(
        f"node {shlex.quote(wt_script)} resolve --branch {shlex.quote(execute_branch)}",
        summary="Check worktree status",
        cwd=work_dir,
    )
    worktree_status = _parse_json_output(wt_out)

    if owns_prepare_file and not any_failed:
        Path(prepare_file).unlink(missing_ok=True)

    final_result = {
        "status": "failed" if any_failed else "completed",
        "auto": auto,
        "branch": execute_branch,
        "work_dir": work_dir,
        "state_file": state_file,
        "steps": step_outcomes,
        "artifacts": artifacts,
        "cleanup": cleanup_info,
        "learn_status": learn_status,
        "worktree": worktree_status,
        "openspec_detected": bool(context.get("openspecDetected")),
    }
    print(json.dumps(final_result, indent=2))
    return final_result


if __name__ == "__main__":
    asyncio.run(main())
