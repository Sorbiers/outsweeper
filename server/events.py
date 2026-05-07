from __future__ import annotations

import queue
import threading

_SSE_CLIENTS: dict = {}
_SSE_LOCK = threading.Lock()


def _sse_broadcast(msg: str, *, flag: str | None = None) -> None:
    with _SSE_LOCK:
        for client in list(_SSE_CLIENTS.values()):
            if flag and not client.get(flag, True):
                continue
            try:
                client['queue'].put_nowait(msg)
            except queue.Full:
                pass
