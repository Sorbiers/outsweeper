"""LM Studio activity tracking: a process-wide snapshot of what LM Studio is
doing (reachable? which model is loaded? mid model-load or prompt-processing?),
kept current two ways —

1. `poll_loop` — periodically reads LM Studio's native `/api/v1/models` (already
   used elsewhere in this app for unload), which reflects the truth regardless of
   who triggered it (including models loaded from LM Studio's own UI). This is
   the only genuinely global signal LM Studio's REST API offers.
2. `stream_chat` — when *this app* makes a chat/vision call, it uses LM Studio's
   native streaming `/api/v1/chat` (see docs/lmstudio_events.md) instead of the
   OpenAI-compatible endpoint, so `model_load.progress` / `prompt_processing.progress`
   events update the same shared state in real time.

Either source updates one shared dict, broadcast over the app's existing SSE
channel (see `.events`) — every connected browser tab sees the same live picture,
not just the dialog that happened to trigger a request.
"""
from __future__ import annotations

import json
import threading
import time
from typing import Any
from urllib.parse import urlparse

from .events import _SSE_CLIENTS, _SSE_LOCK, _sse_broadcast

_STATE_LOCK = threading.Lock()
_STATE: dict[str, Any] = {
    'reachable': None,             # None = not polled yet; else True/False
    'model': None,                 # loaded/active model id, or None
    'model_load_progress': None,   # 0..1 while a model is loading, else None
    'prompt_progress': None,       # 0..1 while a prompt is processing, else None
}


def _native_base(lms_url: str) -> str:
    """OpenAI-compatible base (e.g. http://host:1234/v1) -> LM Studio's native
    REST API base (http://host:1234), which serves /api/v1/*."""
    p = urlparse(lms_url)
    return f'{p.scheme}://{p.netloc}'


def _broadcast_state() -> None:
    with _STATE_LOCK:
        snapshot = dict(_STATE)
    _sse_broadcast('lmstudio:' + json.dumps(snapshot), flag='lmstudio')


def _update_state(**kwargs: Any) -> None:
    with _STATE_LOCK:
        _STATE.update(kwargs)
    _broadcast_state()


def _widget_wanted() -> bool:
    with _SSE_LOCK:
        return any(c.get('lmstudio', True) for c in _SSE_CLIENTS.values())


def poll_loop(state: Any, interval: float = 3.0) -> None:
    """Background loop: keeps `reachable` + the currently loaded model current
    even when this app isn't the one making requests."""
    import requests as http_requests
    while True:
        time.sleep(interval)
        if not _widget_wanted():
            continue
        base = _native_base(state.lmstudio_url)
        try:
            resp = http_requests.get(f'{base}/api/v1/models', timeout=5)
            resp.raise_for_status()
            models = resp.json().get('models', [])
            loaded = None
            for m in models:
                instances = m.get('loaded_instances') or []
                if instances:
                    loaded = instances[0].get('id') or m.get('key')
                    break
            with _STATE_LOCK:
                # A chat this app is actively running knows the model more
                # precisely (and sooner) than the next poll tick — don't clobber it.
                in_flight = _STATE['model_load_progress'] is not None or _STATE['prompt_progress'] is not None
                if not in_flight:
                    _STATE['model'] = loaded
                _STATE['reachable'] = True
            _broadcast_state()
        except Exception:
            with _STATE_LOCK:
                _STATE.update(reachable=False, model=None, model_load_progress=None, prompt_progress=None)
            _broadcast_state()


def stream_chat(lms_url: str, model: str, input_items: Any, *, timeout: float) -> str:
    """POST LM Studio's native /api/v1/chat with stream:true, updating the shared
    activity state as events arrive, and returning the assembled response text.

    `input_items` is either a plain string (simple text prompt) or a list of
    `{"type": "text", "content": str}` / `{"type": "image", "data_url": str}`
    items (vision). Raises on a transport error, non-2xx status, or a streamed
    `error` event — callers should catch and fall back to the OpenAI-compatible
    endpoint, since this is a newer/less battle-tested API surface.
    """
    import requests as http_requests

    base = _native_base(lms_url)
    _update_state(model=model)
    try:
        resp = http_requests.post(
            f'{base}/api/v1/chat',
            json={'model': model, 'input': input_items, 'stream': True},
            stream=True,
            timeout=(10, timeout),
        )
        resp.raise_for_status()

        event_type: str | None = None
        result_text = ''
        got_end = False
        for raw in resp.iter_lines(decode_unicode=True):
            if not raw:
                continue
            line = raw.strip()
            if line.startswith('event:'):
                event_type = line[len('event:'):].strip()
                continue
            if not line.startswith('data:'):
                continue
            try:
                evt = json.loads(line[len('data:'):].strip())
            except Exception:
                continue
            etype = evt.get('type') or event_type

            if etype == 'chat.start':
                _update_state(model=evt.get('model_instance_id') or model)
            elif etype == 'model_load.start':
                _update_state(model=evt.get('model_instance_id') or model, model_load_progress=0.0)
            elif etype == 'model_load.progress':
                _update_state(model_load_progress=evt.get('progress'))
            elif etype == 'model_load.end':
                _update_state(model_load_progress=None)
            elif etype == 'prompt_processing.start':
                _update_state(prompt_progress=0.0)
            elif etype == 'prompt_processing.progress':
                _update_state(prompt_progress=evt.get('progress'))
            elif etype == 'prompt_processing.end':
                _update_state(prompt_progress=None)
            elif etype == 'error':
                err = evt.get('error') or {}
                raise RuntimeError(err.get('message') or 'LM Studio reported an error')
            elif etype == 'chat.end':
                got_end = True
                result = evt.get('result') or {}
                result_text = ''.join(
                    o.get('content', '') for o in result.get('output', []) if o.get('type') == 'message'
                )

        if not got_end:
            raise RuntimeError('LM Studio stream ended without a result')
        return result_text
    except http_requests.exceptions.ConnectionError:
        _update_state(reachable=False, model=None, model_load_progress=None, prompt_progress=None)
        raise
    finally:
        # Always clear transient progress when the call ends, success or failure —
        # the model itself (now loaded) is left for the next poll tick to confirm.
        _update_state(model_load_progress=None, prompt_progress=None)
