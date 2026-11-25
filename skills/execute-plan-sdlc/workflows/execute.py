"""Deterministic `run_workflow` wave scheduler for `execute-plan-sdlc`.

Executes implementation plans at max subagent depth = 1:
- Parses the plan markdown, builds a dependency DAG, enforces same-file and
  risk-spreading wave invariants, and manages `state/execute.js`.
- Fans out each wave over `task-implementer` agents via
  `asyncio.gather(..., return_exceptions=True)` with a deterministic
  escalation retry ladder (`flash_lite -> flash -> pro`).
- Runs mechanical git diff / canary / test / build / lint / preflight checks
  via `call_tool("run_command", ...)`.
- Runs `spec-compliance-reviewer` (JSON schema output) on waves with Standard or
  Complex tasks when quality != "minimal".

Note: Uses `async def main()` / `async def run_execute(wf_args=None, cwd=None, plugin_root=None)`
with no top-level `await` so `python3 -m py_compile` succeeds cleanly. Invoke via `run_workflow`:
  exec(open("<PLUGIN_ROOT>/skills/execute-plan-sdlc/workflows/execute.py").read(), globals())
  await main()
"""

import asyncio
import json
import os
import re
import shlex
import subprocess
from pathlib import Path


TASK_RESULT_SCHEMA = {
    "type": "object",
    "properties": {
        "task_id": {"type": "string"},
        "status": {
            "type": "string",
            "enum": ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"],
        },
        "files_touched": {"type": "array", "items": {"type": "string"}},
        "verify_token": {"type": ["string", "null"]},
        "tests_pass": {"type": ["boolean", "null"]},
        "build_pass": {"type": ["boolean", "null"]},
        "concerns": {"type": "array", "items": {"type": "string"}},
        "error_code": {
            "type": ["string", "null"],
            "enum": [None, "FAILED_TESTS", "FAILED_BUILD", "BLOCKED", "NEEDS_CONTEXT"],
        },
        "summary": {"type": "string"},
    },
    "required": ["task_id", "status", "files_touched", "summary"],
}

SPEC_REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["COMPLIANT", "ISSUES_FOUND"]},
        "tasks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string"},
                    "compliant": {"type": "boolean"},
                    "issues": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "severity": {"type": "string", "enum": ["minor", "major"]},
                                "file": {"type": "string"},
                                "line": {"type": ["string", "null"]},
                                "description": {"type": "string"},
                            },
                            "required": ["severity", "file", "description"],
                        },
                    },
                },
                "required": ["task_id", "compliant", "issues"],
            },
        },
        "summary": {"type": "string"},
    },
    "required": ["verdict", "tasks", "summary"],
}

ESCALATION_LADDER = ("flash_lite", "flash", "pro")
MAX_RETRIES_PER_TASK = 2


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


def _resolve_cwd(wf_args=None):
    resolved = _wf_args() if wf_args is None else (wf_args if isinstance(wf_args, dict) else {})
    if resolved.get("cwd"):
        return str(Path(resolved["cwd"]).resolve())
    return str(Path.cwd().resolve())


def _resolve_plugin_root(cwd, wf_args=None):
    resolved = _wf_args() if wf_args is None else (wf_args if isinstance(wf_args, dict) else {})
    if resolved.get("plugin_root"):
        candidate = Path(resolved["plugin_root"]).resolve()
        if (candidate / "scripts" / "state").is_dir():
            return str(candidate)
    if "__file__" in globals():
        candidate = Path(__file__).resolve().parents[3]
        if (candidate / "scripts" / "state").is_dir():
            return str(candidate)
    workspaces = globals().get("WORKSPACES") or ()
    for base in [cwd, *workspaces, str(Path.home() / ".gemini" / "config" / "plugins" / "lift-sdlc"), str(Path.home() / ".gemini" / "antigravity-cli" / "plugins" / "lift-sdlc")]:
        for cand in (Path(base), Path(base) / "lift-sdlc"):
            if (cand / "scripts" / "state").is_dir():
                return str(cand.resolve())
    return str(Path(cwd).resolve())


def _resolve_path(raw_path, base_cwd):
    if not raw_path:
        return None
    p = Path(raw_path)
    if not p.is_absolute():
        cand = Path(base_cwd) / p
        if cand.is_file() or not p.is_file():
            return cand
    return p


def _normalize_worker_enum(value):
    if isinstance(value, str):
        norm = value.strip().lower()
        if norm in ("pro", "inherit"):
            return norm
    return None


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


def _parse_json(text):
    if not text:
        return None
    stripped = text.strip()
    try:
        return json.loads(stripped)
    except Exception:
        pass
    for line in reversed(stripped.splitlines()):
        c = line.strip()
        if c.startswith("{") and c.endswith("}"):
            try:
                return json.loads(c)
            except Exception:
                pass
    idx = stripped.find("{")
    if idx != -1:
        try:
            return json.loads(stripped[idx:])
        except Exception:
            pass
    return None


def next_escalated_model(current_model, error_code="FAILED_TESTS"):
    """Advance one tier along the escalation ladder unless error_code is NEEDS_CONTEXT."""
    if isinstance(error_code, str) and error_code.strip().upper() == "NEEDS_CONTEXT":
        return current_model
    if current_model == "flash_lite":
        return "flash"
    return "pro"


def initial_model_for_task(task, quality, standard_worker_enum="pro"):
    """Assign initial agy model enum (flash|pro|inherit) aligned with Neon-for-Coding."""
    if (task.get("risk") or "").lower() == "high":
        return "pro"
    comp = (task.get("complexity") or "Standard").lower()
    q = (quality or "balanced").lower()
    if q == "minimal":
        return "flash"
    if q == "full":
        return "flash" if comp == "trivial" else "pro"
    # balanced
    if comp == "trivial":
        return "flash"
    if comp == "complex":
        return "pro"
    return standard_worker_enum or "pro"


def parse_plan_markdown(markdown_text, cwd):
    """Parse tasks, source OpenSpec path, and acceptance criteria from plan markdown."""
    source_match = re.search(r"^\*\*Source:\*\*\s*(.+)$", markdown_text, re.M)
    openspec_specs = []
    if source_match:
        src = source_match.group(1).strip().strip("`")
        m_os = re.search(r"(openspec/changes/[^/\s]+)", src)
        if m_os:
            specs_dir = Path(cwd) / m_os.group(1) / "specs"
            if specs_dir.is_dir():
                for p in sorted(specs_dir.glob("*.md")):
                    openspec_specs.append({"file": str(p.relative_to(cwd)), "content": p.read_text(encoding="utf-8")})

    task_re = re.compile(r"^### Task (\d+):\s*(.+)$", re.M)
    matches = list(task_re.finditer(markdown_text))
    tasks = []
    for idx, m in enumerate(matches):
        tid = m.group(1).strip()
        title = m.group(2).strip()
        start = m.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(markdown_text)
        body = markdown_text[start:end]

        comp_m = re.search(r"\*\*Complexity:\*\*\s*(Trivial|Standard|Complex)", body, re.I)
        risk_m = re.search(r"\*\*Risk:\*\*\s*(Low|Medium|High)", body, re.I)
        dep_m = re.search(r"\*\*Depends on:\*\*\s*(.+)", body, re.I)
        ver_m = re.search(r"\*\*Verify:\*\*\s*(.+)", body, re.I)

        deps = []
        if dep_m:
            dep_str = dep_m.group(1).strip()
            if dep_str.lower() not in ("none", "n/a", "—", "-"):
                deps = re.findall(r"(?:Task\s*)?(\d+)", dep_str, re.I)

        created_files = []
        modified_files = []
        test_files = []
        all_files = []
        in_files = False
        for line in body.splitlines():
            if re.match(r"^\*\*Files:\*\*", line.strip()):
                in_files = True
                continue
            if in_files:
                if line.strip().startswith("**") or line.strip().startswith("---"):
                    in_files = False
                    continue
                fm = re.match(r"^\s*-\s*(Create|Modify|Test):\s*`?([^`\n—]+)`?", line, re.I)
                if fm:
                    kind = fm.group(1).lower()
                    fpath = fm.group(2).strip().split()[0].strip("`")
                    all_files.append(fpath)
                    if kind == "create":
                        created_files.append(fpath)
                    elif kind == "modify":
                        modified_files.append(fpath)
                    else:
                        test_files.append(fpath)
                elif re.match(r"^\s*-\s*`([^`]+)`", line):
                    fpath = re.match(r"^\s*-\s*`([^`]+)`", line).group(1).strip()
                    all_files.append(fpath)
                    modified_files.append(fpath)

        criteria = []
        in_ac = False
        for line in body.splitlines():
            if re.match(r"^\*\*Acceptance criteria:\*\*", line.strip(), re.I):
                in_ac = True
                continue
            if in_ac:
                if line.strip().startswith("**") or line.strip().startswith("#"):
                    in_ac = False
                    continue
                if re.match(r"^\s*-\s*\[~\]", line):
                    continue  # Skipped intentionally — exclude from criteria
                cm = re.match(r"^\s*-\s*\[[ xX]\]\s*(.+)$", line)
                if cm:
                    criteria.append(cm.group(1).strip())

        openspec_task = None
        os_m = re.search(
            r"\*\*openspec-task:\*\*\s*\n((?:\s*-\s*.+\n?)+)",
            body,
            re.M,
        )
        if os_m:
            block = os_m.group(1)
            ch = re.search(r"change:\s*(.+)", block)
            rf = re.search(r"ref:\s*(.+)", block)
            ln = re.search(r"line:\s*(\d+)", block)
            tt = re.search(r"title:\s*(.+)", block)
            if ch and rf:
                openspec_task = {
                    "change": ch.group(1).strip(),
                    "ref": rf.group(1).strip(),
                    "line": ln.group(1).strip() if ln else None,
                    "title": tt.group(1).strip() if tt else None,
                }

        tasks.append({
            "id": tid,
            "name": title,
            "title": title,
            "complexity": (comp_m.group(1).capitalize() if comp_m else "Standard"),
            "risk": (risk_m.group(1).capitalize() if risk_m else "Low"),
            "depends_on": [d for d in deps if d != tid],
            "verify": ver_m.group(1).strip() if ver_m else "",
            "created_files": created_files,
            "modified_files": modified_files,
            "test_files": test_files,
            "files": list(dict.fromkeys(all_files)),
            "acceptanceCriteria": criteria,
            "description": body.strip(),
            "openspec_task": openspec_task,
        })

    return tasks, openspec_specs


def schedule_waves(tasks):
    """Build conflict-free, risk-spread dependency waves."""
    by_id = {t["id"]: t for t in tasks}
    creator_of = {}
    for t in tasks:
        for f in t["created_files"]:
            creator_of[f] = t["id"]

    deps = {}
    for t in tasks:
        dset = {d for d in t["depends_on"] if d in by_id}
        for f in t["modified_files"] + t["test_files"]:
            if f in creator_of and creator_of[f] != t["id"]:
                dset.add(creator_of[f])
        deps[t["id"]] = dset

    # Detect cycles via Kahn's algorithm
    remaining = set(by_id.keys())
    completed = set()
    n_total = len(tasks)
    static_cap = 999 if n_total <= 3 else (4 if n_total <= 8 else (5 if n_total <= 15 else 6))
    waves = []

    while remaining:
        ready = [t for t in tasks if t["id"] in remaining and deps[t["id"]].issubset(completed)]
        if not ready:
            raise ValueError(f"Circular or unresolvable dependency detected among tasks: {sorted(remaining)}")

        wave_tasks = []
        wave_files = set()
        high_risk_count = 0
        weight = 0

        for t in ready:
            t_files = set(t["files"])
            if t_files & wave_files:
                continue
            is_high = t["risk"].lower() == "high"
            if is_high and high_risk_count >= 1:
                continue
            t_weight = 2 if t["complexity"].lower() == "complex" else 1
            if wave_tasks and (weight + t_weight) > static_cap:
                continue
            wave_tasks.append(t)
            wave_files |= t_files
            if is_high:
                high_risk_count += 1
            weight += t_weight

        if not wave_tasks:
            # Ensure progress even if a single Complex task exceeds cap or shares nothing
            t = ready[0]
            wave_tasks.append(t)

        waves.append(wave_tasks)
        for t in wave_tasks:
            remaining.remove(t["id"])
            completed.add(t["id"])

    return waves


def _layer_boundaries_for_files(files):
    rules = []
    joined = "\n".join(files)
    if "apps/api/src/facade/" in joined:
        rules.append("apps/api/src/facade/: Pure HTTP translation only — no direct Access/Engine calls.")
    if "apps/api/src/utilities/" in joined:
        rules.append("apps/api/src/utilities/: Utility isolation — no upward imports into domain layers.")
    if "apps/api/tests/" in joined:
        rules.append("apps/api/tests/: Deterministic testing rules — no naked setTimeout; use workerGate.")
    return rules


def _render_task_prompt(task, fact_sheet_path, guardrails, prior_summary, work_dir, plugin_root, attempt, prev_error=None, current_model="flash"):
    sections = [
        "You are implementing a single task from an execution plan. Focus strictly on your assigned task.",
        f"Working directory: {work_dir}",
        f"Plugin root: {plugin_root}",
    ]
    if guardrails:
        gr_lines = ["## Project Guardrails"]
        for g in guardrails:
            gr_lines.append(f"- **{g.get('id', 'guardrail')}** ({g.get('severity', 'error')}): {g.get('description', '')}")
        sections.append("\n".join(gr_lines))

    boundaries = _layer_boundaries_for_files(task["files"])
    if boundaries:
        sections.append("## Layer Boundaries\n" + "\n".join(f"- {b}" for b in boundaries))

    spec_header = [
        "## Your Task",
        f"Task ID: {task['id']} | Title: {task['title']}",
        f"Complexity: {task['complexity']} | Risk: {task['risk']}",
        f"Assigned model tier: {current_model} | Attempt: {attempt + 1}",
    ]
    if fact_sheet_path:
        spec_header.append(f"Read your fact sheet first: {fact_sheet_path}")
    spec_header.append(f"\n### Task Specification\n{task['description']}")
    sections.append("\n".join(spec_header))

    files_list = "\n".join(f"- {f}" for f in task["files"]) or "- (see specification)"
    sections.append(f"## Files You May Touch\n{files_list}")

    if prior_summary:
        sections.append(f"## Context From Prior Waves\n{json.dumps(prior_summary, indent=2)}")

    if prev_error:
        heading = (
            "## Injected Missing Context (Same-Tier Retry)"
            if "NEEDS_CONTEXT" in prev_error
            else "## Previous Attempt Failure (Escalated Retry)"
        )
        sections.append(f"{heading}\n{prev_error}")

    sections.append(
        "## Instructions\n"
        "- Use `view_file`, `write_to_file`, `replace_file_content`, `find_by_name`, `grep_search`, and `run_command` only.\n"
        "- Do not read the original plan markdown file or modify files outside `Files You May Touch`.\n"
        "- Run targeted verification (`Verify:` or test/build command) and return structured JSON via `finish`."
    )
    return "\n\n".join(sections)


def _detect_verification_commands(wave_tasks, cwd, override_cmd=None):
    if override_cmd:
        return [override_cmd]
    cmds = []
    pkg_path = Path(cwd) / "package.json"
    scripts = {}
    if pkg_path.is_file():
        try:
            scripts = json.loads(pkg_path.read_text(encoding="utf-8")).get("scripts") or {}
        except Exception:
            scripts = {}
    for t in wave_tasks:
        v = (t.get("verify") or "").strip()
        if v and v.lower() not in ("tests", "build", "lint", "manual", "n/a", "none"):
            if v not in cmds:
                cmds.append(v)
    if not cmds:
        if "test" in scripts:
            cmds.append("npm test")
        if "build" in scripts:
            cmds.append("npm run build")
        if "lint" in scripts:
            cmds.append("npm run lint")
    if "preflight" in scripts and "npm run preflight" not in cmds:
        cmds.append("npm run preflight")
    return cmds


def _parse_diff_stat_files(diff_stat_output):
    files = set()
    for line in (diff_stat_output or "").splitlines():
        if "|" in line:
            path_part = line.split("|", 1)[0].strip()
            if path_part:
                files.add(path_part)
    return files


async def _run_execute_state(plugin_root, cwd, subcmd_args, summary="Update execute state"):
    script = str(Path(plugin_root) / "scripts" / "state" / "execute.js")
    return await run_cmd(f"node {shlex.quote(script)} {subcmd_args}", summary=summary, cwd=cwd)


async def _verify_wave(wave_tasks, results_by_id, cwd, plugin_root, test_override):
    _, diff_stat, _ = await run_cmd("git diff --stat", summary="Check wave git diff stat", cwd=cwd)
    _, untracked_out, _ = await run_cmd("git ls-files --others --exclude-standard", summary="Check untracked files", cwd=cwd)
    changed_files = _parse_diff_stat_files(diff_stat) | {ln.strip() for ln in untracked_out.splitlines() if ln.strip()}

    phantom_failures = []
    canary_failures = []
    for t in wave_tasks:
        res = results_by_id.get(t["id"]) or {}
        if res.get("status") in ("DONE", "DONE_WITH_CONCERNS"):
            expected = set(t["files"]) | set(res.get("files_touched") or [])
            if expected and not (changed_files & expected):
                phantom_failures.append(t["id"])
            vtok = res.get("verify_token") or ""
            m_tok = re.match(r"^\s*([A-Za-z0-9_$]+)\s+in\s+(.+?)\s*$", vtok)
            if m_tok:
                sym, fpath = m_tok.group(1), m_tok.group(2)
                abs_f = Path(cwd) / fpath
                if not abs_f.is_file() or sym not in abs_f.read_text(encoding="utf-8", errors="ignore"):
                    canary_failures.append(f"Task {t['id']}: missing symbol {sym} in {fpath}")

    trunc_script = str(Path(plugin_root) / "scripts" / "util" / "run-truncated.js")
    cmd_failures = []
    for vcmd in _detect_verification_commands(wave_tasks, cwd, test_override):
        rc, out, err = await run_cmd(
            f"node {shlex.quote(trunc_script)} {shlex.quote(vcmd)}",
            summary=f"Verify: {vcmd[:30]}",
            cwd=cwd,
        )
        if rc != 0:
            cmd_failures.append({"command": vcmd, "exit_code": rc, "output": (err or out)[-1200:]})

    return {
        "changed_files": sorted(changed_files),
        "phantom_failures": phantom_failures,
        "canary_failures": canary_failures,
        "command_failures": cmd_failures,
        "ok": not (phantom_failures or canary_failures or cmd_failures),
    }


async def run_execute(wf_args=None, cwd=None, plugin_root=None):
    """Execute plan waves with escalation retry ladder and spec-compliance review."""
    resolved_args = _wf_args() if wf_args is None else (dict(wf_args) if isinstance(wf_args, dict) else {})
    resolved_cwd = str(Path(cwd).resolve()) if cwd else _resolve_cwd(resolved_args)
    resolved_plugin_root = (
        str(Path(plugin_root).resolve())
        if plugin_root
        else _resolve_plugin_root(resolved_cwd, resolved_args)
    )
    wf_args = resolved_args
    cwd = resolved_cwd
    plugin_root = resolved_plugin_root

    plan_file = wf_args.get("plan_file")
    quality = str(wf_args.get("quality") or "balanced").lower()
    if quality not in ("minimal", "balanced", "full"):
        quality = "balanced"
    auto = bool(wf_args.get("auto"))
    resume = bool(wf_args.get("resume"))
    commit_waves = bool(wf_args.get("commit_waves"))
    approve_high_risk: bool = bool(wf_args.get("approve_high_risk"))
    skip_high_risk: bool = bool(wf_args.get("skip_high_risk"))
    branch = wf_args.get("branch")
    test_override = wf_args.get("test_command")

    if not branch:
        _, b_out, _ = await run_cmd("git branch --show-current", summary="Detect current branch", cwd=cwd)
        branch = b_out.strip() or "main"

    _wf_phase("Load & Schedule Waves")
    if resume:
        _, det_out, _ = await _run_execute_state(
            plugin_root, cwd, f"detect-resume --branch {shlex.quote(branch)}", summary="Detect execute resume state"
        )
        det = _parse_json(det_out) or {}
        if det.get("found") and not plan_file:
            _, rd_out, _ = await _run_execute_state(plugin_root, cwd, f"read --branch {shlex.quote(branch)}", summary="Read execute state")
            st = _parse_json(rd_out) or {}
            plan_file = st.get("planPath")
    else:
        det = {}

    plan_path = _resolve_path(plan_file, cwd)
    if not plan_path or not plan_path.is_file():
        result = {"status": "failed", "error": f"Explicit plan file not found: {plan_file}"}
        print(json.dumps(result, indent=2))
        return result

    plan_abs = str(plan_path.resolve())
    plan_text = plan_path.read_text(encoding="utf-8")
    tasks, openspec_specs = parse_plan_markdown(plan_text, cwd)
    if not tasks:
        result = {"status": "failed", "error": f"No tasks ('### Task N: ...') found in {plan_abs}"}
        print(json.dumps(result, indent=2))
        return result

    try:
        waves = schedule_waves(tasks)
    except ValueError as exc:
        result = {"status": "failed", "error": str(exc)}
        print(json.dumps(result, indent=2))
        return result

    adv_script = str(Path(plugin_root) / "scripts" / "util" / "execute-context-advisory.js")
    explicit_worker_enum = _normalize_worker_enum(wf_args.get("standard_worker_enum"))
    adv_cmd = f"node {shlex.quote(adv_script)} --meta"
    if cwd:
        adv_cmd += f" --cwd {shlex.quote(cwd)}"
    try:
        adv_rc, adv_out, _ = await run_cmd(
            adv_cmd,
            summary="Load execution guardrails and metadata",
            cwd=cwd,
        )
    except Exception as exc:
        if getattr(exc, "denied", False):
            raise
        adv_rc, adv_out = 1, ""

    adv_parsed = _parse_json(adv_out) if adv_rc == 0 else None
    guardrails = None
    meta_worker_enum = None
    meta_caps = None
    if isinstance(adv_parsed, dict):
        if isinstance(adv_parsed.get("guardrails"), list):
            guardrails = adv_parsed["guardrails"]
        meta_worker_enum = _normalize_worker_enum(adv_parsed.get("standardWorkerEnum"))
        if isinstance(adv_parsed.get("priorWaveContextCaps"), dict):
            meta_caps = adv_parsed["priorWaveContextCaps"]
    elif isinstance(adv_parsed, list):
        guardrails = adv_parsed

    if not isinstance(guardrails, list):
        guardrails = wf_args.get("guardrails") or []

    standard_worker_enum = explicit_worker_enum or meta_worker_enum or "pro"
    prior_caps = wf_args.get("prior_wave_context_caps")
    if not isinstance(prior_caps, dict):
        prior_caps = meta_caps if isinstance(meta_caps, dict) else {}

    small_plan = len(tasks) <= 3 and all(t["complexity"].lower() != "complex" and t["risk"].lower() != "high" for t in tasks)
    use_state = not small_plan

    completed_ids = set()
    skipped_task_ids = set()
    resumed_wave_shas = {}
    run_id = "run"
    if use_state:
        hash_script = str(Path(plugin_root) / "scripts" / "util" / "plan-hash.js")
        _, plan_hash_out, _ = await run_cmd(f"node {shlex.quote(hash_script)} {shlex.quote(plan_abs)}", summary="Hash plan markdown", cwd=cwd)
        plan_hash = plan_hash_out.strip()

        if resume and det.get("found"):
            for entry in det.get("waveShaStatus") or []:
                if entry.get("reachable") is False:
                    result = {
                        "status": "failed",
                        "error": f"Wave {entry.get('wave')} state mismatch: committed sha {entry.get('committedSha')} not reachable from HEAD.",
                    }
                    print(json.dumps(result, indent=2))
                    return result
                if entry.get("reachable") is True:
                    resumed_wave_shas[entry["wave"]] = entry.get("committedSha")
            _, rd_out, _ = await _run_execute_state(plugin_root, cwd, f"read --branch {shlex.quote(branch)}", summary="Read execute state")
            st = _parse_json(rd_out) or {}
            run_id = re.sub(r"[^0-9T]", "", str(st.get("startedAt") or "")) or "run"
            for w in st.get("waves") or []:
                if w.get("status") == "completed" or w.get("number") in resumed_wave_shas:
                    for wt in w.get("tasks") or []:
                        if wt.get("status") == "completed":
                            completed_ids.add(str(wt["id"]))
                        elif wt.get("status") == "skipped-dependency":
                            skipped_task_ids.add(str(wt["id"]))
        else:
            all_ids_json = json.dumps([t["id"] for t in tasks])
            rc, init_out, init_err = await _run_execute_state(
                plugin_root,
                cwd,
                (
                    f"init --branch {shlex.quote(branch)} --quality {shlex.quote(quality)} "
                    f"--total-tasks {len(tasks)} --planned-task-ids {shlex.quote(all_ids_json)} "
                    f"--plan-path {shlex.quote(plan_abs)} --plan-hash {shlex.quote(plan_hash)}"
                ),
                summary="Initialize execute state",
            )
            if rc != 0:
                result = {"status": "failed", "error": init_err or init_out or "execute state init failed"}
                print(json.dumps(result, indent=2))
                return result
            _, rd_out, _ = await _run_execute_state(plugin_root, cwd, f"read --branch {shlex.quote(branch)}", summary="Read initialized execute state")
            st = _parse_json(rd_out) or {}
            run_id = re.sub(r"[^0-9T]", "", str(st.get("startedAt") or "")) or "run"

    escalations_used = 0
    spec_reviews = []
    openspec_warnings = []
    flipped_refs = set()
    ref_to_siblings = {}
    for t in tasks:
        ot = t.get("openspec_task")
        if ot:
            ref_to_siblings.setdefault(ot["ref"], set()).add(t["id"])

    wave_summaries = []
    failed_halt = False

    for wave_idx, wave_tasks in enumerate(waves, start=1):
        pending_tasks = [t for t in wave_tasks if t["id"] not in completed_ids and t["id"] not in skipped_task_ids]
        if not pending_tasks or wave_idx in resumed_wave_shas:
            all_wave_skipped = bool(wave_tasks) and all(t["id"] in skipped_task_ids for t in wave_tasks)
            _wf_log(f"Wave {wave_idx}: already {'skipped' if all_wave_skipped else 'completed'} — skipping")
            wave_summaries.append({
                "wave": wave_idx,
                "status": "skipped" if all_wave_skipped else "completed",
                "resumed_skip": True,
            })
            continue

        high_risk_tasks = [t for t in pending_tasks if t["risk"].lower() == "high"]
        if high_risk_tasks and not auto and not approve_high_risk:
            if skip_high_risk:
                _wf_log(f"Wave {wave_idx}: high-risk wave skipped via skip_high_risk")
                if use_state:
                    for t in pending_tasks:
                        await _run_execute_state(
                            plugin_root,
                            cwd,
                            (
                                f"task-fail --wave {wave_idx} --task {shlex.quote(t['id'])} "
                                f"--name {shlex.quote(t['name'])} --complexity {shlex.quote(t['complexity'])} "
                                f"--risk {shlex.quote(t['risk'])} --error {shlex.quote('Skipped high-risk wave by user')} "
                                "--skipped-dependency"
                            ),
                            summary=f"Record skipped high-risk task {t['id']}",
                        )
                    await _run_execute_state(
                        plugin_root,
                        cwd,
                        f"wave-done --wave {wave_idx}",
                        summary=f"Record skipped wave {wave_idx}",
                    )
                for t in pending_tasks:
                    skipped_task_ids.add(t["id"])
                wave_summaries.append({
                    "wave": wave_idx,
                    "status": "skipped",
                    "reason": "skip_high_risk",
                    "tasks": [
                        {"task_id": t["id"], "title": t["title"], "risk": t["risk"], "status": "skipped"}
                        for t in pending_tasks
                    ],
                })
                continue

            result = {
                "status": "needs_consent",
                "gate": "high_risk_wave",
                "wave": wave_idx,
                "high_risk_tasks": [{"id": t["id"], "title": t["title"], "risk": t["risk"]} for t in high_risk_tasks],
                "completed_task_ids": sorted(completed_ids),
            }
            print(json.dumps(result, indent=2))
            return result

        _wf_phase(f"Execute Wave {wave_idx}/{len(waves)}")
        fact_sheet_by_id = {}
        prior_summary = None
        if use_state:
            tasks_payload = [
                {
                    "id": t["id"],
                    "name": t["name"],
                    "complexity": t["complexity"],
                    "risk": t["risk"],
                    "description": t["description"],
                    "acceptanceCriteria": t["acceptanceCriteria"],
                    "files": t["files"],
                }
                for t in pending_tasks
            ]
            rc, ws_out, _ = await _run_execute_state(
                plugin_root,
                cwd,
                f"wave-start --wave {wave_idx} --tasks-json {shlex.quote(json.dumps(tasks_payload))} --run-id {shlex.quote(run_id)}",
                summary=f"Start wave {wave_idx}",
            )
            ws_json = _parse_json(ws_out) or {}
            for fs_path in ws_json.get("factSheets") or []:
                m_id = re.search(r"task-([^/\\]+)\.md$", fs_path)
                if m_id:
                    fact_sheet_by_id[m_id.group(1)] = fs_path

            cap_flags = []
            for flag_name, key in (("--max-files", "maxFiles"), ("--max-decisions", "maxDecisions"), ("--max-interfaces", "maxInterfaces")):
                val = prior_caps.get(key)
                if not isinstance(val, bool) and isinstance(val, int) and val > 0:
                    cap_flags.append(f"{flag_name} {val}")
            summarize_cmd = "summarize-prior-wave-context" + (f" {' '.join(cap_flags)}" if cap_flags else "")
            _, pr_out, _ = await _run_execute_state(
                plugin_root, cwd, summarize_cmd, summary="Summarize prior wave context"
            )
            prior_summary = _parse_json(pr_out)

        async def run_task_with_ladder(task):
            nonlocal escalations_used
            model = initial_model_for_task(task, quality, standard_worker_enum)
            attempts = []
            prev_err = None
            last_res = None

            for attempt in range(MAX_RETRIES_PER_TASK + 1):
                prompt = _render_task_prompt(
                    task,
                    fact_sheet_by_id.get(task["id"]),
                    guardrails,
                    prior_summary,
                    cwd,
                    plugin_root,
                    attempt,
                    prev_err,
                    model,
                )
                err_code_for_esc = "FAILED_TESTS"
                try:
                    res = await agent(
                        prompt=prompt,
                        schema=TASK_RESULT_SCHEMA,
                        role=f"Task {task['id']}: {task['title'][:40]}",
                        type_name="task-implementer",
                        workspace="inherit",
                        model=model,
                    )
                except Exception as exc:
                    attempts.append({"attempt": attempt, "model": model, "error": str(exc)})
                    prev_err = f"Subagent exception at tier {model}: {exc}"
                    last_res = {"task_id": task["id"], "status": "FAILED", "files_touched": [], "summary": prev_err, "error_code": "BLOCKED"}
                    err_code_for_esc = "BLOCKED"
                else:
                    last_res = res if isinstance(res, dict) else {"task_id": task["id"], "status": "FAILED", "files_touched": [], "summary": "Invalid non-dict result"}
                    status_val = last_res.get("status")
                    err_code = last_res.get("error_code")
                    needs_context = (
                        status_val == "NEEDS_CONTEXT"
                        or (isinstance(err_code, str) and err_code.strip().upper() == "NEEDS_CONTEXT")
                    )
                    ok = (
                        status_val in ("DONE", "DONE_WITH_CONCERNS")
                        and last_res.get("tests_pass") is not False
                        and last_res.get("build_pass") is not False
                    )
                    attempts.append({"attempt": attempt, "model": model, "status": status_val})
                    if ok:
                        return {**last_res, "final_model": model, "attempts": attempts}
                    if needs_context:
                        err_code_for_esc = "NEEDS_CONTEXT"
                        extra_ctx = []
                        if last_res.get("concerns"):
                            extra_ctx.append(f"Requested context / concerns: {json.dumps(last_res['concerns'])}")
                        if openspec_specs:
                            extra_ctx.append(
                                "OpenSpec specs:\n" + "\n".join(
                                    f"- {sp['file']}:\n{sp['content'][:1200]}" for sp in openspec_specs
                                )
                            )
                        ctx_block = ("\n" + "\n".join(extra_ctx)) if extra_ctx else ""
                        prev_err = (
                            f"Previous attempt at tier {model} returned NEEDS_CONTEXT: {last_res.get('summary')}.{ctx_block}\n"
                            "Retrying at the same model tier with injected context — inspect the target files directly."
                        )
                    else:
                        err_code_for_esc = err_code or "FAILED_TESTS"
                        prev_err = f"Previous tier {model} returned status={status_val}, error_code={err_code}: {last_res.get('summary')}"

                if attempt < MAX_RETRIES_PER_TASK:
                    next_model = next_escalated_model(model, err_code_for_esc)
                    if next_model != model:
                        escalations_used += 1
                    model = next_model

            return {
                **(last_res or {}),
                "task_id": task["id"],
                "status": "FAILED",
                "final_model": model,
                "attempts": attempts,
            }

        raw_outcomes = await asyncio.gather(
            *(run_task_with_ladder(t) for t in pending_tasks),
            return_exceptions=True,
        )

        results_by_id = {}
        for task, outcome in zip(pending_tasks, raw_outcomes):
            if isinstance(outcome, Exception):
                results_by_id[task["id"]] = {
                    "task_id": task["id"],
                    "status": "FAILED",
                    "files_touched": [],
                    "summary": f"Unhandled exception: {outcome}",
                }
            else:
                results_by_id[task["id"]] = outcome

        verify_info = await _verify_wave(pending_tasks, results_by_id, cwd, plugin_root, test_override)

        # Escalated retry for phantom success tasks when retry budget wasn't exhausted
        if verify_info["phantom_failures"]:
            retry_coros = []
            retry_tasks = []
            for tid in verify_info["phantom_failures"]:
                t_obj = next(t for t in pending_tasks if t["id"] == tid)
                prior_attempts = len((results_by_id[tid] or {}).get("attempts") or [])
                if prior_attempts <= MAX_RETRIES_PER_TASK:
                    cur_m = (results_by_id[tid] or {}).get("final_model") or "flash"
                    esc_m = next_escalated_model(cur_m)
                    escalations_used += 1
                    retry_tasks.append(t_obj)
                    retry_coros.append(
                        agent(
                            prompt=_render_task_prompt(
                                t_obj,
                                fact_sheet_by_id.get(tid),
                                guardrails,
                                prior_summary,
                                cwd,
                                plugin_root,
                                prior_attempts,
                                "Phantom success detected: git diff --stat showed zero edits to expected files. Write actual changes using replace_file_content/write_to_file.",
                                esc_m,
                            ),
                            schema=TASK_RESULT_SCHEMA,
                            role=f"Retry phantom Task {tid}",
                            type_name="task-implementer",
                            workspace="inherit",
                            model=esc_m,
                        )
                    )
            if retry_coros:
                retry_res = await asyncio.gather(*retry_coros, return_exceptions=True)
                for t_obj, r_out in zip(retry_tasks, retry_res):
                    if isinstance(r_out, dict) and r_out.get("status") in ("DONE", "DONE_WITH_CONCERNS"):
                        results_by_id[t_obj["id"]] = r_out
                    else:
                        results_by_id[t_obj["id"]] = {
                            "task_id": t_obj["id"],
                            "status": "FAILED",
                            "files_touched": [],
                            "summary": f"Phantom success retry failed: {r_out}",
                        }
                verify_info = await _verify_wave(pending_tasks, results_by_id, cwd, plugin_root, test_override)
                for tid in verify_info["phantom_failures"]:
                    results_by_id[tid]["status"] = "FAILED"

        # ---- Spec compliance review (Standard/Complex tasks, quality != minimal) ----
        non_trivial = [t for t in pending_tasks if t["complexity"].lower() != "trivial" and results_by_id[t["id"]].get("status") in ("DONE", "DONE_WITH_CONCERNS")]
        if non_trivial and quality != "minimal":
            reviewer_model = "pro"
            spec_blocks = []
            for t in non_trivial:
                touched = results_by_id[t["id"]].get("files_touched") or t["files"]
                spec_blocks.append(
                    f"### Task {t['id']}: {t['title']}\n"
                    f"**Specification:**\n{t['description']}\n\n"
                    f"**Claimed modified files:** {', '.join(touched) or 'none'}"
                )
            delta_block = ""
            if openspec_specs:
                delta_block = "\n\n## OpenSpec Delta Specs\n" + "\n\n".join(
                    f"### {sp['file']}\n{sp['content']}" for sp in openspec_specs
                )
            spec_prompt = (
                f"Working directory: {cwd}\n"
                f"Verify Wave {wave_idx} implementations adversarially against the specifications and actual git diff.\n\n"
                + "\n\n---\n\n".join(spec_blocks)
                + delta_block
            )
            try:
                spec_verdict = await agent(
                    prompt=spec_prompt,
                    schema=SPEC_REVIEW_SCHEMA,
                    role=f"Spec compliance review Wave {wave_idx}",
                    type_name="spec-compliance-reviewer",
                    workspace="inherit",
                    model=reviewer_model,
                )
            except Exception as exc:
                spec_verdict = {"verdict": "ISSUES_FOUND", "tasks": [], "summary": f"Spec reviewer exception: {exc}"}
            spec_reviews.append({"wave": wave_idx, **spec_verdict})

            if spec_verdict.get("verdict") == "ISSUES_FOUND":
                fix_coros = []
                fix_targets = []
                for tr in spec_verdict.get("tasks") or []:
                    if tr.get("compliant"):
                        continue
                    tid = str(tr.get("task_id"))
                    major_issues = [iss for iss in tr.get("issues") or [] if iss.get("severity") == "major"]
                    t_obj = next((t for t in non_trivial if t["id"] == tid), None)
                    if major_issues and t_obj:
                        prior_attempts = len((results_by_id[tid] or {}).get("attempts") or [])
                        if prior_attempts <= MAX_RETRIES_PER_TASK:
                            esc_m = next_escalated_model((results_by_id[tid] or {}).get("final_model") or "flash")
                            escalations_used += 1
                            issue_txt = "\n".join(f"- {iss.get('file')}:{iss.get('line', '')} {iss.get('description')}" for iss in major_issues)
                            fix_targets.append(t_obj)
                            fix_coros.append(
                                agent(
                                    prompt=_render_task_prompt(
                                        t_obj, fact_sheet_by_id.get(tid), guardrails, prior_summary, cwd, plugin_root,
                                        prior_attempts, f"Spec compliance issues found:\n{issue_txt}", esc_m,
                                    ),
                                    schema=TASK_RESULT_SCHEMA,
                                    role=f"Fix spec gaps Task {tid}",
                                    type_name="task-implementer",
                                    workspace="inherit",
                                    model=esc_m,
                                )
                            )
                if fix_coros:
                    fix_outs = await asyncio.gather(*fix_coros, return_exceptions=True)
                    for t_obj, f_out in zip(fix_targets, fix_outs):
                        if isinstance(f_out, dict):
                            results_by_id[t_obj["id"]] = f_out
                    verify_info = await _verify_wave(pending_tasks, results_by_id, cwd, plugin_root, test_override)

        wave_failed = (
            not verify_info["ok"]
            or any(results_by_id[t["id"]].get("status") not in ("DONE", "DONE_WITH_CONCERNS") for t in pending_tasks)
        )

        if use_state:
            for t in pending_tasks:
                res = results_by_id[t["id"]]
                if res.get("status") in ("DONE", "DONE_WITH_CONCERNS") and not wave_failed:
                    completed_ids.add(t["id"])
                    files_json = json.dumps(res.get("files_touched") or t["files"])
                    await _run_execute_state(
                        plugin_root, cwd,
                        (
                            f"task-done --wave {wave_idx} --task {shlex.quote(t['id'])} "
                            f"--name {shlex.quote(t['name'])} --complexity {shlex.quote(t['complexity'])} "
                            f"--risk {shlex.quote(t['risk'])} --files-changed {shlex.quote(files_json)}"
                        ),
                        summary=f"Record task {t['id']} done",
                    )
                else:
                    err_txt = str(res.get("summary") or res.get("error_code") or "verification failed")[:240]
                    await _run_execute_state(
                        plugin_root, cwd,
                        (
                            f"task-fail --wave {wave_idx} --task {shlex.quote(t['id'])} "
                            f"--name {shlex.quote(t['name'])} --complexity {shlex.quote(t['complexity'])} "
                            f"--risk {shlex.quote(t['risk'])} --error {shlex.quote(err_txt)}"
                        ),
                        summary=f"Record task {t['id']} failed",
                    )

            # OpenSpec task checkbox flip (non-blocking)
            os_info_script = str(Path(plugin_root) / "scripts" / "util" / "openspec-task-info.js")
            for ref, siblings in ref_to_siblings.items():
                if ref in flipped_refs or not siblings.issubset(completed_ids):
                    continue
                sample_t = next(t for t in tasks if (t.get("openspec_task") or {}).get("ref") == ref)
                ot = sample_t["openspec_task"]
                cmd = f"node {shlex.quote(os_info_script)} --change {shlex.quote(ot['change'])} --ref {shlex.quote(ref)}"
                if ot.get("line"):
                    cmd += f" --line {shlex.quote(str(ot['line']))}"
                if ot.get("title"):
                    cmd += f" --title {shlex.quote(ot['title'])}"
                _, oout, _ = await run_cmd(cmd, summary="Flip OpenSpec checkbox", cwd=cwd)
                ores = _parse_json(oout) or {}
                flipped_refs.add(ref)
                if ores.get("reason") in ("not-found", "io-error"):
                    openspec_warnings.append({"change": ot["change"], "ref": ref, "reason": ores["reason"]})

            ctx_payload = {
                "completedTaskIds": sorted(completed_ids),
                "filesModified": verify_info["changed_files"],
            }
            await _run_execute_state(
                plugin_root, cwd, f"context --data {shlex.quote(json.dumps(ctx_payload))}", summary="Update wave context"
            )
            await _run_execute_state(
                plugin_root, cwd,
                f"{'wave-fail' if wave_failed else 'wave-done'} --wave {wave_idx}",
                summary=f"Finish wave {wave_idx}",
            )

            if commit_waves and not wave_failed and not small_plan:
                wc_script = str(Path(plugin_root) / "scripts" / "util" / "wave-commit.js")
                titles = "|".join(t["title"] for t in pending_tasks)
                wrc, wout, werr = await run_cmd(
                    f"node {shlex.quote(wc_script)} --wave {wave_idx} --titles {shlex.quote(titles)}",
                    summary=f"WIP commit wave {wave_idx}",
                    cwd=cwd,
                )
                wres = _parse_json(wout) or {}
                if wrc != 0:
                    wave_failed = True
                    verify_info["wave_commit_error"] = wres.get("error") or wres.get("reason") or werr
                else:
                    sha = wres.get("sha") or ""
                    await _run_execute_state(
                        plugin_root, cwd,
                        f"wave-committed --branch {shlex.quote(branch)} --wave {wave_idx} --sha {shlex.quote(sha)}",
                        summary="Record wave WIP commit SHA",
                    )

        wave_summaries.append({
            "wave": wave_idx,
            "status": "failed" if wave_failed else "completed",
            "tasks": [results_by_id[t["id"]] for t in pending_tasks],
            "verification": verify_info,
        })
        if wave_failed:
            failed_halt = True
            break

    _wf_phase("Final Verification & Completeness")
    final_verify = None
    executed_tasks = [t for t in tasks if t["id"] not in skipped_task_ids]
    if not failed_halt:
        if executed_tasks:
            final_verify = await _verify_wave(
                executed_tasks,
                {t["id"]: {"status": "DONE", "files_touched": t["files"]} for t in executed_tasks},
                cwd,
                plugin_root,
                test_override,
            )
            if final_verify["command_failures"]:
                failed_halt = True
        else:
            final_verify = {
                "changed_files": [],
                "phantom_failures": [],
                "canary_failures": [],
                "command_failures": [],
                "ok": True,
                "skipped": True,
            }

    if use_state and not failed_halt:
        vc_rc, vc_out, vc_err = await _run_execute_state(
            plugin_root, cwd, f"verify-completeness --branch {shlex.quote(branch)}", summary="Verify task completeness"
        )
        if vc_rc != 0:
            failed_halt = True
            wave_summaries.append({"completeness_error": vc_err or vc_out, "exit_code": vc_rc})
        else:
            await _run_execute_state(plugin_root, cwd, f"cleanup --branch {shlex.quote(branch)}", summary="Cleanup execute state")

    completeness_verified = bool(use_state and not failed_halt)
    all_skipped = bool(tasks) and len(skipped_task_ids) == len(tasks) and not failed_halt
    final_status = "failed" if failed_halt else ("skipped" if all_skipped else "completed")

    final_result = {
        "status": final_status,
        "branch": branch,
        "quality": quality,
        "tasks_completed": len(completed_ids) if use_state else (0 if (failed_halt or all_skipped) else len(executed_tasks)),
        "tasks_total": len(tasks),
        "tasks_skipped": len(skipped_task_ids),
        "skipped_task_ids": sorted(skipped_task_ids),
        "waves_executed": len(wave_summaries),
        "escalations_used": escalations_used,
        "completeness_verified": completeness_verified,
        "waves": wave_summaries,
        "spec_reviews": spec_reviews,
        "final_verification": final_verify,
        "openspec_warnings": openspec_warnings,
    }
    print(json.dumps(final_result, indent=2))
    return final_result


async def main():
    """Entrypoint delegating to `run_execute` using workflow `args` globals."""
    return await run_execute(wf_args=_wf_args())


if __name__ == "__main__":
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(main())
