from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING

from .events import _SSE_CLIENTS, _SSE_LOCK, _sse_broadcast
from .utils import LMS_CHECK_TIMEOUT, SSE_QUEUE_TIMEOUT

if TYPE_CHECKING:
    from .state import AppState

_COMFY_PROGRESS: dict = {}


def _metrics_loop(interval: float = 2.0) -> None:
    nvml_ok = False
    try:
        import pynvml
        pynvml.nvmlInit()
        nvml_ok = True
    except Exception:
        pass
    while True:
        time.sleep(interval)
        with _SSE_LOCK:
            has_metrics = any(c['metrics'] for c in _SSE_CLIENTS.values())
        if not has_metrics:
            continue
        try:
            import psutil
            cpu = psutil.cpu_percent(interval=None)
            ram = psutil.virtual_memory().percent
            gpu = temp = vram = None
            if nvml_ok:
                try:
                    h    = pynvml.nvmlDeviceGetHandleByIndex(0)
                    gpu  = pynvml.nvmlDeviceGetUtilizationRates(h).gpu
                    temp = pynvml.nvmlDeviceGetTemperature(h, pynvml.NVML_TEMPERATURE_GPU)
                    mi   = pynvml.nvmlDeviceGetMemoryInfo(h)
                    vram = round(mi.used / mi.total * 100, 1)
                except Exception:
                    pass
            _sse_broadcast(
                'metrics:' + json.dumps({'cpu': cpu, 'ram': ram, 'gpu': gpu, 'temp': temp, 'vram': vram}),
                flag='metrics',
            )
        except Exception as e:
            print(f'[warn] metrics: {e}', flush=True)


def _comfy_ws_loop(state: 'AppState') -> None:
    global _COMFY_PROGRESS
    try:
        import websocket
    except ImportError:
        return
    while True:
        cu = state.comfy_url.rstrip('/')
        ws_url = cu.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws'
        try:
            def on_message(ws, message):
                global _COMFY_PROGRESS
                try:
                    msg = json.loads(message)
                    if msg['type'] == 'progress':
                        _COMFY_PROGRESS = {'value': msg['data']['value'], 'max': msg['data']['max']}
                    elif msg['type'] == 'execution_complete':
                        _COMFY_PROGRESS = {}
                    elif msg['type'] == 'executing' and msg.get('data', {}).get('node') is None:
                        _COMFY_PROGRESS = {}
                except Exception:
                    pass
            websocket.WebSocketApp(ws_url, on_message=on_message).run_forever()
        except Exception as e:
            print(f'[warn] comfy ws: {e}', flush=True)
        time.sleep(5)


def _comfy_queue_loop(state: 'AppState', interval: float = 2.0) -> None:
    import requests as http_requests
    prev_running_ids: set = set()
    done_count = 0
    while True:
        time.sleep(interval)
        with _SSE_LOCK:
            has_comfy = any(c.get('comfy_queue', True) for c in _SSE_CLIENTS.values())
        if not has_comfy:
            continue
        cu = state.comfy_url.rstrip('/')
        try:
            resp = http_requests.get(f'{cu}/queue', timeout=3)
            data = resp.json()
            running_items = data.get('queue_running', [])
            pending_items = data.get('queue_pending', [])
            current_running_ids = {
                str(item[1]) for item in running_items
                if isinstance(item, (list, tuple)) and len(item) > 1
            }
            done_count += len(prev_running_ids - current_running_ids)
            prev_running_ids = current_running_ids
            _sse_broadcast('comfy_queue:' + json.dumps({
                'running': len(running_items),
                'pending': len(pending_items),
                'done':    done_count,
                'progress': _COMFY_PROGRESS if running_items else None,
            }), flag='comfy_queue')
        except Exception as e:
            print(f'[warn] comfy queue: {e}', flush=True)
