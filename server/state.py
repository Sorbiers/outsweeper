from __future__ import annotations

import collections
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class AppState:
    root_dir: Path
    root_resolved: Path
    selected_name: str
    dust_name: str
    config: dict[str, Any]
    comfy_url: str
    lmstudio_url: str
    co_resolved: Path | None
    exiftool_path: str
    thumb_cache_days: int
    run_comfy_command: str
    run_lmstudio_command: str
    monitor_enabled: bool
    comfy_queue_enabled: bool
    tools_cfg: dict
    validation_interval: int | None

    comfy_output_str: str = ''

    folder_caches: dict = field(default_factory=dict)
    tag_index: dict = field(default_factory=dict)
    undo_stack: collections.deque = field(
        default_factory=lambda: collections.deque(maxlen=50)
    )
    undo_lock: threading.Lock = field(default_factory=threading.Lock)

    index_built: threading.Event = field(default_factory=threading.Event)
    root_build_time: list = field(default_factory=lambda: [0.0])
    last_detection: list = field(default_factory=lambda: [0.0])
    last_rescan_done: list = field(default_factory=lambda: [0.0])
