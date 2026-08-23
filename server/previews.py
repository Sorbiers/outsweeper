"""Step previews streamed from ComfyUI's websocket.

ComfyUI's sampler callback decodes `x0` — the model's running estimate of the
finished image — once per step and pushes it as a binary websocket frame. That is
already computed during every render, so capturing it costs nothing extra beyond
the TAESD decode ComfyUI is doing anyway.

It only happens when ComfyUI runs with `--preview-method taesd` (or `auto` /
`latent2rgb`); the default is `none` and no frames are sent at all.

The binary frames carry no ids on the legacy protocol, but each one is preceded by
a JSON `progress` message holding `prompt_id` and `node`, so frames are attributed
from whatever progress message arrived last. Negotiating the newer
`supports_preview_metadata` flag would embed the ids instead — but ComfyUI then
*stops* sending the legacy frames, so this deliberately does not negotiate.
"""
from __future__ import annotations

import struct
import threading
import time
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw

#: Binary websocket event ids (ComfyUI's protocol.py).
EVENT_PREVIEW_IMAGE = 1
EVENT_PREVIEW_IMAGE_WITH_METADATA = 4

#: Image type ids inside a PREVIEW_IMAGE frame.
_IMAGE_TYPES = {1: 'image/jpeg', 2: 'image/png'}

#: Cap on frames held per prompt. A 20-step render sends 20; this is headroom for
#: long runs while keeping a stuck recording from growing without bound.
MAX_FRAMES = 200

#: Longest edge of a cell in the contact sheet.
SHEET_CELL_PX = 256
#: Columns in the contact sheet.
SHEET_COLS = 5
#: Milliseconds per frame in the animated WebP.
ANIM_FRAME_MS = 200


def parse_preview_frame(data: bytes) -> tuple[str, bytes] | None:
    """Decode one binary websocket frame into (mimetype, image bytes).

    Returns None for frames that aren't previews, are truncated, or use an image
    type we don't recognise — the caller treats those as "nothing to show".
    """
    if len(data) < 8:
        return None
    event = struct.unpack('>I', data[:4])[0]

    if event == EVENT_PREVIEW_IMAGE:
        type_num = struct.unpack('>I', data[4:8])[0]
        mime = _IMAGE_TYPES.get(type_num)
        payload = data[8:]
        return (mime, payload) if mime and payload else None

    if event == EVENT_PREVIEW_IMAGE_WITH_METADATA:
        # Not negotiated, but decode it anyway so a protocol switch upstream
        # degrades to "previews still work" rather than "previews vanish".
        meta_len = struct.unpack('>I', data[4:8])[0]
        body = data[8:]
        if meta_len > len(body):
            return None
        import json
        try:
            meta = json.loads(body[:meta_len].decode('utf-8'))
        except Exception:
            return None
        payload = body[meta_len:]
        return (meta.get('image_type') or 'image/jpeg', payload) if payload else None

    return None


@dataclass
class _Recording:
    frames: list[bytes] = field(default_factory=list)
    dropped: int = 0


class PreviewStore:
    """Latest step preview, plus opt-in per-prompt recordings.

    One instance is shared by the websocket reader and the request handlers, so
    every method takes the lock; the frames themselves are immutable bytes.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._latest: tuple[str, bytes] | None = None
        self._latest_at: float = 0.0
        #: prompt_id -> progress, refreshed from the JSON message before each frame.
        self._current_prompt: str | None = None
        self._current_step: int = 0
        self._recordings: dict[str, _Recording] = {}

    # --- writing (websocket thread) ---------------------------------------

    def note_progress(self, prompt_id: str | None, step: int) -> None:
        """Remember which prompt the next binary frame belongs to."""
        with self._lock:
            self._current_prompt = prompt_id
            self._current_step = step

    def add_frame(self, mime: str, blob: bytes) -> None:
        with self._lock:
            self._latest = (mime, blob)
            self._latest_at = time.time()
            rec = self._recordings.get(self._current_prompt or '')
            if rec is None:
                return
            if len(rec.frames) >= MAX_FRAMES:
                rec.dropped += 1
                return
            rec.frames.append(blob)

    # --- reading (request threads) ----------------------------------------

    def latest(self, max_age: float = 30.0) -> tuple[str, bytes] | None:
        """The newest frame, or None once it is stale enough to be misleading."""
        with self._lock:
            if not self._latest or time.time() - self._latest_at > max_age:
                return None
            return self._latest

    def step(self) -> int:
        with self._lock:
            return self._current_step

    # --- recording (worker thread) ----------------------------------------

    def start_recording(self, prompt_id: str) -> None:
        with self._lock:
            self._recordings[prompt_id] = _Recording()

    def take_recording(self, prompt_id: str) -> list[bytes]:
        """Pop a prompt's frames; returns [] when nothing was recorded."""
        with self._lock:
            rec = self._recordings.pop(prompt_id, None)
            return rec.frames if rec else []

    def discard_recording(self, prompt_id: str) -> None:
        with self._lock:
            self._recordings.pop(prompt_id, None)


def _decode(frames: list[bytes]) -> list[Image.Image]:
    out = []
    for blob in frames:
        try:
            im = Image.open(BytesIO(blob))
            im.load()
            out.append(im.convert('RGB'))
        except Exception:
            continue
    return out


def write_step_sheet(frames: list[bytes], dest: Path) -> Path | None:
    """Contact sheet of every captured step, numbered. Returns the path written."""
    images = _decode(frames)
    if not images:
        return None

    cells = []
    for im in images:
        c = im.copy()
        c.thumbnail((SHEET_CELL_PX, SHEET_CELL_PX), Image.LANCZOS)
        cells.append(c)

    cw = max(c.width for c in cells)
    ch = max(c.height for c in cells)
    cols = min(SHEET_COLS, len(cells))
    rows = (len(cells) + cols - 1) // cols
    label_h = 16

    sheet = Image.new('RGB', (cols * cw, rows * (ch + label_h)), (18, 18, 18))
    draw = ImageDraw.Draw(sheet)
    for i, cell in enumerate(cells):
        x = (i % cols) * cw + (cw - cell.width) // 2
        y = (i // cols) * (ch + label_h)
        sheet.paste(cell, (x, y))
        draw.text((x + 3, y + ch + 2), f'{i + 1}', fill=(190, 190, 190))

    dest.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(dest, quality=88, optimize=True)
    return dest


def write_step_animation(frames: list[bytes], dest: Path) -> Path | None:
    """Animated WebP of the render evolving. Returns the path written."""
    images = _decode(frames)
    if not images:
        return None

    # Frames can differ in size between samplers in one graph; WebP needs one size.
    w = max(im.width for im in images)
    h = max(im.height for im in images)
    canvas = [im if im.size == (w, h) else im.resize((w, h), Image.LANCZOS) for im in images]

    dest.parent.mkdir(parents=True, exist_ok=True)
    canvas[0].save(
        dest, format='WEBP', save_all=True, append_images=canvas[1:],
        duration=ANIM_FRAME_MS, loop=0, quality=80, method=4,
    )
    return dest
