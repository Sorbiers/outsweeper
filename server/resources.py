"""Resource guards for the internal job queue.

ComfyUI and LM Studio cannot both hold VRAM on this machine, so every job runs
behind the same set of invariants:

  * the service it needs is running (launched on demand when a run command is set);
  * ComfyUI's own queue is drained before we submit (or force-cleared);
  * the *other* engine's memory is released before this one is used.

These are plain functions taking explicit arguments — no Flask/app state — so the
worker and the unit tests can call them directly. `should_cancel` is an optional
predicate polled during waits so a cancelled job stops promptly instead of sitting
out a long timeout.
"""
from __future__ import annotations

import mimetypes
import subprocess
import time
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

import requests as http_requests

PROBE_TIMEOUT = 3
"""Seconds for a single liveness probe — short, it's polled in a loop."""

SERVICE_START_TIMEOUT = 240
"""How long to wait for a launched service to answer (ComfyUI is slow to boot)."""

QUEUE_IDLE_TIMEOUT = 3600
"""Upper bound on waiting for someone else's ComfyUI work to finish."""

POLL_INTERVAL = 2


class ResourceError(RuntimeError):
    """A required service is unavailable and could not be started."""


def native_base(lms_url: str) -> str:
    """LM Studio's OpenAI-compatible base (…:1234/v1) -> native REST base (…:1234)."""
    p = urlparse(lms_url)
    return f'{p.scheme}://{p.netloc}'


def _cancelled(should_cancel: Callable[[], bool] | None) -> bool:
    return bool(should_cancel and should_cancel())


# --- liveness -------------------------------------------------------------

def comfy_alive(comfy_url: str) -> bool:
    try:
        r = http_requests.get(f'{comfy_url.rstrip("/")}/system_stats', timeout=PROBE_TIMEOUT)
        return r.status_code < 500
    except Exception:
        return False


def lmstudio_alive(lms_url: str) -> bool:
    try:
        r = http_requests.get(f'{native_base(lms_url)}/api/v1/models', timeout=PROBE_TIMEOUT)
        return r.status_code < 500
    except Exception:
        return False


def launch_service(cmd: str) -> None:
    """Start ComfyUI / LM Studio in its own console, exactly like /api/run-command."""
    cmd_path = Path(cmd)
    cwd = str(cmd_path.parent) if cmd_path.parent.is_dir() else None
    subprocess.Popen(
        ['cmd', '/c', cmd],
        cwd=cwd,
        creationflags=getattr(subprocess, 'CREATE_NEW_CONSOLE', 0),
    )


def _ensure(name: str, url: str, alive: Callable[[str], bool], run_cmd: str,
            auto_start: bool, should_cancel: Callable[[], bool] | None) -> None:
    if alive(url):
        return
    if not auto_start or not run_cmd:
        raise ResourceError(
            f'{name} is not running at {url} and no start command is configured '
            f'(set run_{"comfy" if name == "ComfyUI" else "lmstudio"}_command in config.toml).')
    launch_service(run_cmd)
    deadline = time.time() + SERVICE_START_TIMEOUT
    while time.time() < deadline:
        if _cancelled(should_cancel):
            return
        if alive(url):
            return
        time.sleep(POLL_INTERVAL)
    raise ResourceError(f'{name} did not become reachable at {url} after starting it.')


def ensure_comfy(comfy_url: str, run_cmd: str = '', *, auto_start: bool = True,
                 should_cancel: Callable[[], bool] | None = None) -> None:
    _ensure('ComfyUI', comfy_url, comfy_alive, run_cmd, auto_start, should_cancel)


def ensure_lmstudio(lms_url: str, run_cmd: str = '', *, auto_start: bool = True,
                    should_cancel: Callable[[], bool] | None = None) -> None:
    _ensure('LM Studio', lms_url, lmstudio_alive, run_cmd, auto_start, should_cancel)


# --- ComfyUI queue --------------------------------------------------------

def comfy_queue_depth(comfy_url: str) -> int:
    """How many prompts ComfyUI is running or holding. -1 when it can't be read."""
    try:
        q = http_requests.get(f'{comfy_url.rstrip("/")}/queue', timeout=PROBE_TIMEOUT).json()
        return len(q.get('queue_running', [])) + len(q.get('queue_pending', []))
    except Exception:
        return -1


def clear_comfy_queue(comfy_url: str) -> None:
    cu = comfy_url.rstrip('/')
    try:
        http_requests.post(f'{cu}/queue', json={'clear': True}, timeout=PROBE_TIMEOUT)
        http_requests.post(f'{cu}/interrupt', timeout=PROBE_TIMEOUT)
    except Exception:
        pass


def wait_comfy_idle(comfy_url: str, *, force_clear: bool = False,
                    should_cancel: Callable[[], bool] | None = None) -> None:
    """Block until ComfyUI has nothing queued, so our job doesn't interleave with
    work submitted elsewhere. `force_clear` drops that work instead of waiting."""
    if force_clear:
        clear_comfy_queue(comfy_url)
        return
    deadline = time.time() + QUEUE_IDLE_TIMEOUT
    while time.time() < deadline:
        if _cancelled(should_cancel):
            return
        depth = comfy_queue_depth(comfy_url)
        if depth <= 0:      # 0 = idle; -1 = unreadable, don't block forever on it
            return
        time.sleep(POLL_INTERVAL)
    raise ResourceError('Timed out waiting for the ComfyUI queue to drain.')


def interrupt_comfy(comfy_url: str) -> None:
    try:
        http_requests.post(f'{comfy_url.rstrip("/")}/interrupt', timeout=PROBE_TIMEOUT)
    except Exception:
        pass


# --- memory arbitration ---------------------------------------------------

def unload_all_lm_models(lms_url: str) -> None:
    """Unload every loaded LM Studio instance — call before handing VRAM to ComfyUI."""
    base = native_base(lms_url)
    try:
        models = http_requests.get(f'{base}/api/v1/models', timeout=PROBE_TIMEOUT).json().get('models', [])
        for model in models:
            for instance in model.get('loaded_instances', []):
                instance_id = instance.get('id')
                if instance_id:
                    http_requests.post(f'{base}/api/v1/models/unload',
                                       json={'instance_id': instance_id}, timeout=10)
    except Exception:
        pass


def free_comfy_memory(comfy_url: str) -> None:
    """Release ComfyUI's models/VRAM — call before handing VRAM to LM Studio."""
    try:
        http_requests.post(f'{comfy_url.rstrip("/")}/free',
                           json={'unload_models': True, 'free_memory': True}, timeout=10)
    except Exception:
        pass


# --- ComfyUI I/O ----------------------------------------------------------

def upload_image(comfy_url: str, file_path: Path) -> str:
    """Upload a source image to ComfyUI's input folder; returns the stored name.

    Deferred to job-execution time (rather than done in the browser at click time)
    so img2img/outpaint/upscale no longer require ComfyUI to already be running.
    """
    mime = mimetypes.guess_type(str(file_path))[0] or 'image/png'
    with open(file_path, 'rb') as f:
        resp = http_requests.post(
            f'{comfy_url.rstrip("/")}/upload/image',
            files={'image': (file_path.name, f, mime)}, timeout=60)
    resp.raise_for_status()
    name = resp.json().get('name')
    if not name:
        raise ResourceError(f'ComfyUI did not accept the upload of {file_path.name}')
    return name


def submit_prompt(comfy_url: str, workflow: dict, *, front: bool = False) -> str:
    """Queue one graph; returns its prompt_id. Raises with ComfyUI's validation text."""
    payload: dict = {'prompt': workflow}
    if front:
        payload['front'] = True
    resp = http_requests.post(f'{comfy_url.rstrip("/")}/prompt', json=payload, timeout=30)
    body = {}
    try:
        body = resp.json()
    except Exception:
        pass
    prompt_id = body.get('prompt_id')
    if not prompt_id:
        raise ResourceError(_submit_error(body) or f'ComfyUI rejected the prompt (HTTP {resp.status_code})')
    return prompt_id


def wait_for_prompt(comfy_url: str, prompt_id: str, *,
                    should_cancel: Callable[[], bool] | None = None,
                    timeout: float = QUEUE_IDLE_TIMEOUT) -> dict | None:
    """Poll /history until the prompt finishes; returns its history entry, or None if
    cancelled or timed out. Waiting is kept separate from copying because copying the
    outputs into the workspace is opt-in (`copy_result`) while waiting never is —
    the queue must know a render finished before it starts the next job."""
    cu = comfy_url.rstrip('/')
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _cancelled(should_cancel):
            return None
        try:
            hist = http_requests.get(f'{cu}/history/{prompt_id}', timeout=PROBE_TIMEOUT).json()
            if prompt_id in hist:
                return hist[prompt_id]
        except Exception:
            pass
        time.sleep(POLL_INTERVAL)
    return None


def _submit_error(body: dict) -> str:
    """Readable message out of ComfyUI's {error, node_errors} validation payload."""
    err = body.get('error')
    if isinstance(err, str):
        return err
    if isinstance(err, dict) and err.get('message'):
        return err['message']
    for node in (body.get('node_errors') or {}).values():
        for e in (node.get('errors') or []):
            if e.get('message'):
                return e['message']
    return ''
