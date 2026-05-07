from __future__ import annotations

import threading
import time
from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer

from .events import _sse_broadcast
from .state import AppState
from .utils import (
    EXTENSIONS,
    WATCHER_COOLDOWN_SECS,
    WATCHER_DEBOUNCE_SECS,
    WATCHER_POLL_SECS,
    build_index,
    stat_entry,
)


def _eager_index(state: AppState) -> None:
    t0 = time.perf_counter()
    if state.root_resolved.is_dir():
        state.folder_caches[str(state.root_resolved)] = build_index(state.root_resolved)
    state.root_build_time[0] = time.perf_counter() - t0
    state.index_built.set()
    for folder in (
        state.root_resolved / state.selected_name,
        state.root_resolved / state.dust_name,
    ):
        if folder.is_dir():
            state.folder_caches[str(folder)] = build_index(folder)


def _validation_loop(state: AppState) -> None:
    if state.validation_interval is None:
        state.index_built.wait()
        interval = max(200.0, min(1800.0, state.root_build_time[0] * 20))
        print(
            f'[index] Revalidation interval: {interval:.0f}s '
            f'(build: {state.root_build_time[0]:.1f}s)',
            flush=True,
        )
    else:
        interval = float(state.validation_interval)
    root_key = str(state.root_resolved)
    while True:
        time.sleep(interval)
        for key in list(state.folder_caches.keys()):
            if key == root_key:
                continue
            folder = Path(key)
            if not folder.is_dir():
                state.folder_caches.pop(key, None)
                continue
            cache = state.folder_caches.get(key, {})
            actual: dict = {}
            try:
                for f in folder.iterdir():
                    if (
                        f.is_file()
                        and f.suffix.lower() in EXTENSIONS
                        and not f.name.startswith(('.', '_'))
                    ):
                        try:
                            actual[f.name] = f.stat()
                        except Exception:
                            pass
            except Exception:
                continue
            for name, st in actual.items():
                entry = cache.get(name)
                if (
                    not entry
                    or entry.get('mtime') != st.st_mtime
                    or entry.get('size') != st.st_size
                ):
                    cache[name] = stat_entry(st)
            for name in list(cache.keys()):
                if name not in actual:
                    cache.pop(name, None)
            time.sleep(0)


class _RootChangeHandler(FileSystemEventHandler):
    def __init__(self, state: AppState) -> None:
        super().__init__()
        self._state = state

    def _relevant(self, event) -> bool:
        return (
            not event.is_directory
            and Path(event.src_path).suffix.lower() in EXTENSIONS
            and Path(event.src_path).parent.resolve() == self._state.root_resolved
        )

    def on_created(self, event) -> None:
        if self._relevant(event):
            self._state.last_detection[0] = time.time()

    def on_deleted(self, event) -> None:
        if self._relevant(event):
            self._state.last_detection[0] = time.time()


def _watcher_rescan_loop(state: AppState) -> None:
    while True:
        time.sleep(WATCHER_POLL_SECS)
        now = time.time()
        if state.last_detection[0] <= state.last_rescan_done[0]:
            continue
        if now - state.last_detection[0] < WATCHER_DEBOUNCE_SECS:
            continue
        if now - state.last_rescan_done[0] < WATCHER_COOLDOWN_SECS:
            continue
        root_key = str(state.root_resolved)
        old_count = len(state.folder_caches.get(root_key, {}))
        print(f'[watcher] rebuild start — {old_count} files known', flush=True)
        t0 = time.perf_counter()
        state.folder_caches[root_key] = build_index(state.root_resolved)
        elapsed = (time.perf_counter() - t0) * 1000
        new_count = len(state.folder_caches[root_key])
        state.last_rescan_done[0] = time.time()
        print(
            f'[watcher] rebuild done — {new_count} files in {elapsed:.1f} ms'
            + (
                f' (count changed: {old_count} → {new_count})'
                if new_count != old_count
                else ''
            ),
            flush=True,
        )
        if new_count != old_count:
            _sse_broadcast(f'source_changed:{new_count - old_count:+d}')


def start_watcher(state: AppState) -> None:
    threading.Thread(target=_eager_index, args=(state,), daemon=True).start()
    observer = Observer()
    observer.schedule(_RootChangeHandler(state), str(state.root_resolved), recursive=False)
    observer.daemon = True
    observer.start()
    threading.Thread(target=_watcher_rescan_loop, args=(state,), daemon=True).start()
    if state.validation_interval != 0:
        threading.Thread(target=_validation_loop, args=(state,), daemon=True).start()
