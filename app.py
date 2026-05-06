import sys
import io
import json
import queue
import re
import shutil
import time
import threading
import webbrowser
import subprocess
import shlex
import zipfile
import psutil
import base64
import mimetypes
import fnmatch
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
import uuid as _uuid
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

try:
    import tomllib
except ImportError:
    import tomli as tomllib

import requests as http_requests
from flask import Flask, jsonify, request, send_from_directory, send_file, abort, g
from PIL import Image, ImageCms
from PIL.ExifTags import TAGS, GPSTAGS
from PIL.PngImagePlugin import PngInfo
from io import BytesIO

EXTENSIONS     = {'.png', '.jpg', '.jpeg', '.webp'}
THUMBNAILS_DIR = '__thumbnails'
undo_stack     = []

# SSE client registry (used for metrics + comfy queue widgets only)
_sse_clients: dict = {}
_sse_lock = threading.Lock()


def _sse_broadcast(msg: str, *, flag: str | None = None) -> None:
    with _sse_lock:
        for client in list(_sse_clients.values()):
            if flag and not client.get(flag, True):
                continue
            try:
                client['queue'].put_nowait(msg)
            except queue.Full:
                pass


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
        with _sse_lock:
            has_metrics = any(c['metrics'] for c in _sse_clients.values())
        if not has_metrics:
            continue
        try:
            cpu = psutil.cpu_percent(interval=None)
            ram = psutil.virtual_memory().percent
            gpu = temp = vram = None
            if nvml_ok:
                try:
                    h = pynvml.nvmlDeviceGetHandleByIndex(0)
                    gpu  = pynvml.nvmlDeviceGetUtilizationRates(h).gpu
                    temp = pynvml.nvmlDeviceGetTemperature(h, pynvml.NVML_TEMPERATURE_GPU)
                    mi   = pynvml.nvmlDeviceGetMemoryInfo(h)
                    vram = round(mi.used / mi.total * 100, 1)
                except Exception:
                    pass
            _sse_broadcast('metrics:' + json.dumps(
                {'cpu': cpu, 'ram': ram, 'gpu': gpu, 'temp': temp, 'vram': vram}
            ), flag='metrics')
        except Exception:
            pass


_comfy_progress: dict = {}


def _comfy_ws_loop(comfy_url: str) -> None:
    try:
        import websocket
    except ImportError:
        return
    ws_url = comfy_url.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws'
    while True:
        try:
            def on_message(ws, message):
                global _comfy_progress
                try:
                    msg = json.loads(message)
                    if msg['type'] == 'progress':
                        _comfy_progress = {'value': msg['data']['value'], 'max': msg['data']['max']}
                    elif msg['type'] == 'execution_complete':
                        _comfy_progress = {}
                    elif msg['type'] == 'executing' and msg.get('data', {}).get('node') is None:
                        _comfy_progress = {}
                except Exception:
                    pass
            websocket.WebSocketApp(ws_url, on_message=on_message).run_forever()
        except Exception:
            pass
        time.sleep(5)


def _comfy_queue_loop(comfy_url: str, interval: float = 2.0) -> None:
    prev_running_ids: set = set()
    done_count = 0
    while True:
        time.sleep(interval)
        with _sse_lock:
            has_comfy = any(c.get('comfy_queue', True) for c in _sse_clients.values())
        if not has_comfy:
            continue
        try:
            resp = http_requests.get(f'{comfy_url}/queue', timeout=3)
            data = resp.json()
            running_items = data.get('queue_running', [])
            pending_items = data.get('queue_pending', [])
            current_running_ids = {str(item[1]) for item in running_items if isinstance(item, (list, tuple)) and len(item) > 1}
            done_count += len(prev_running_ids - current_running_ids)
            prev_running_ids = current_running_ids
            _sse_broadcast('comfy_queue:' + json.dumps({
                'running': len(running_items),
                'pending': len(pending_items),
                'done': done_count,
                'progress': _comfy_progress if running_items else None,
            }), flag='comfy_queue')
        except Exception:
            pass


def get_exif_date(filepath: Path):
    """Return ISO datetime string from EXIF DateTimeOriginal/DateTime, or None."""
    try:
        img = Image.open(filepath)
        exif_data = img.getexif()
        for tag_id in (0x9003, 0x0132, 0x9004):
            val = exif_data.get(tag_id)
            if val and isinstance(val, str):
                try:
                    return datetime.strptime(val, '%Y:%m:%d %H:%M:%S').isoformat()
                except ValueError:
                    pass
    except Exception:
        pass
    return None


def stat_entry(stat) -> dict:
    """Lightweight cache record from a stat result."""
    return {'mtime': stat.st_mtime, 'ctime': stat.st_ctime, 'size': stat.st_size}


def mtime_token(mtime: float) -> str:
    """8-char hex of integer mtime. Filename-safe, monotonic, deterministic."""
    return f'{int(mtime):08x}'


def cleanup_old_thumbnails(roots, days: int) -> None:
    """Recursively remove __thumbnails/* files older than `days` days under each root."""
    cutoff = time.time() - days * 86400
    removed = 0
    for root in roots:
        if not root or not Path(root).is_dir():
            continue
        try:
            for thumbs_dir in Path(root).rglob(THUMBNAILS_DIR):
                if not thumbs_dir.is_dir():
                    continue
                for f in thumbs_dir.iterdir():
                    if not f.is_file():
                        continue
                    try:
                        if f.stat().st_mtime < cutoff:
                            f.unlink()
                            removed += 1
                    except Exception:
                        pass
        except Exception:
            pass
    print(f"[thumbs] cleanup: removed {removed} stale thumbnail(s) older than {days} day(s)", flush=True)


def build_index(folder: Path) -> dict:
    """Fast metadata-only scan: mtime/ctime/size only. No image opens."""
    start = time.perf_counter()
    cache: dict = {}
    if not folder.is_dir():
        return cache
    try:
        for f in folder.iterdir():
            if not f.is_file() or f.suffix.lower() not in EXTENSIONS or f.name.startswith(('.', '_')):
                continue
            try:
                cache[f.name] = stat_entry(f.stat())
            except Exception:
                pass
    except Exception:
        pass
    elapsed = (time.perf_counter() - start) * 1000
    print(f"[index] {folder} — {len(cache)} files in {elapsed:.1f} ms", flush=True)
    return cache


def ensure_dimensions(folder: Path, name: str, entry: dict) -> None:
    """Lazily open the image and cache width/height on the entry."""
    if 'width' in entry:
        return
    try:
        with Image.open(folder / name) as im:
            entry['width'], entry['height'] = im.size
    except Exception:
        entry['width'] = entry['height'] = None


def ensure_exif_date(folder: Path, name: str, entry: dict) -> None:
    """Lazily extract and cache EXIF date for a single entry."""
    if 'exif_date' in entry:
        return
    entry['exif_date'] = get_exif_date(folder / name)


def human_size(nbytes):
    for unit in ('B', 'KB', 'MB', 'GB'):
        if nbytes < 1024:
            return f"{nbytes:.1f} {unit}"
        nbytes /= 1024
    return f"{nbytes:.1f} TB"


def extract_comfyui_data(prompt):
    """Extract ComfyUI workflow data from PNG metadata."""
    result = {'found': False}
    # if filepath.suffix.lower() != '.png':
    #     return result

    try:
        # img = Image.open(filepath)
        # meta = img.info
        # if 'prompt' not in meta:
        #     return result

        prompt = json.loads(prompt)
        result['found'] = True

        model = None
        loras = []
        positive_prompt = None
        negative_prompt = None
        steps = None
        cfg = None
        seed = None
        sampler = None
        scheduler = None
        batch_size = None

        for node in prompt.values():
            inputs = node.get('inputs', {})
            class_type = node.get('class_type', '')

            if 'ckpt_name' in inputs:
                model = inputs['ckpt_name']

            if 'lora_name' in inputs:
                loras.append({
                    'name': inputs['lora_name'],
                    'strength_model': inputs.get('strength_model', 1.0),
                    'strength_clip': inputs.get('strength_clip', 1.0),
                })

            if 'steps' in inputs and 'cfg' in inputs:
                steps = inputs.get('steps')
                cfg = inputs.get('cfg')
                seed = inputs.get('seed')
                sampler = inputs.get('sampler_name')
                scheduler = inputs.get('scheduler')

            if class_type == 'CLIPTextEncode' and 'text' in inputs:
                text = inputs['text']
                if positive_prompt is None:
                    positive_prompt = text
                else:
                    negative_prompt = text

            if 'batch_size' in inputs:
                batch_size = inputs['batch_size']

        result.update({
            'model': model,
            'loras': loras,
            'prompt': positive_prompt,
            'negative_prompt': negative_prompt,
            'steps': steps,
            'cfg': cfg,
            'seed': seed,
            'sampler': sampler,
            'scheduler': scheduler,
            'batch_size': batch_size,
        })
    except Exception as e:
        result['error'] = str(e)

    return result


def extract_exif(filepath):
    """Extract EXIF from IFD0 + ExifIFD (no GPS — that's a separate section)."""
    result = {}

    def _add(ifd):
        for tag_id, value in ifd.items():
            s = str(value)
            tag_name = TAGS.get(tag_id, str(tag_id))
            if s.startswith(("b'ASCII", "b'UNICODE", "b'JIS")):
                text = extract_exif_text(value)
                result[str(tag_name)] = text
                continue
            if s.startswith(("b'", 'b"')):
                continue
            result[str(tag_name)] = s

    try:
        img       = Image.open(filepath)
        exif_data = img.getexif()
        _add(exif_data)                          # IFD0
        _add(exif_data.get_ifd(0x8769))          # ExifIFD: aperture, ISO, lens, etc.
    except Exception:
        pass
    return result


def _rationals_to_decimal(dms, ref):
    """Convert ((deg,min,sec), 'N'/'S'/'E'/'W') to decimal degrees."""
    try:
        deg, mn, sec = (float(x) for x in dms)
        val = deg + mn / 60 + sec / 3600
        if ref in ('S', 'W'):
            val = -val
        return round(val, 6)
    except Exception:
        return None


def extract_gps(filepath):
    """Extract GPS data: decimal lat/lon/altitude + raw tags (when present)."""
    result = {}
    try:
        img = Image.open(filepath)
        gps = img.getexif().get_ifd(0x8825)
        if not gps:
            return result
        lat = gps.get(2); lat_ref = gps.get(1)
        lon = gps.get(4); lon_ref = gps.get(3)
        if lat is not None and lat_ref is not None:
            d = _rationals_to_decimal(lat, lat_ref)
            if d is not None:
                result['latitude'] = str(d)
        if lon is not None and lon_ref is not None:
            d = _rationals_to_decimal(lon, lon_ref)
            if d is not None:
                result['longitude'] = str(d)
        alt = gps.get(6)
        if alt is not None:
            try:
                result['altitude'] = f'{float(alt):.1f}'
            except Exception:
                pass
        for tag_id, value in gps.items():
            s = str(value)
            if s.startswith(("b'", 'b"')):
                continue
            name = GPSTAGS.get(tag_id, str(tag_id))
            result.setdefault(str(name), s)
    except Exception:
        pass
    return result


_TAG_RE = re.compile(r'#([A-Za-z0-9_\-]+)')


def _user_comment_text(filepath: Path) -> str:
    """Read EXIF UserComment, stripping the 8-byte EXIF charset prefix if present."""
    try:
        ifd = Image.open(filepath).getexif().get_ifd(0x8769)
        v   = ifd.get(0x9286)
        if v is None:
            return ''
        if isinstance(v, bytes):
            for prefix in (b'ASCII\x00\x00\x00', b'UNICODE\x00', b'JIS\x00\x00\x00\x00\x00'):
                if v.startswith(prefix):
                    body = v[len(prefix):]
                    enc  = 'utf-16-be' if prefix.startswith(b'UNICODE') else 'ascii'
                    try:
                        return body.decode(enc, errors='ignore').rstrip('\x00').strip()
                    except Exception:
                        return ''
            try:
                return v.decode('ascii', errors='ignore').rstrip('\x00').strip()
            except Exception:
                return ''
        return str(v).rstrip('\x00').strip()
    except Exception:
        return ''


def extract_exif_text(v: str) -> str:
    try:
        if v is None:
            return ''
        if isinstance(v, bytes):
            for prefix in (b'ASCII\x00\x00\x00', b'UNICODE\x00', b'JIS\x00\x00\x00\x00\x00'):
                if v.startswith(prefix):
                    body = v[len(prefix):]
                    enc  = 'utf-16-be' if prefix.startswith(b'UNICODE') else 'ascii'
                    try:
                        return body.decode(enc, errors='ignore').rstrip('\x00').strip()
                    except Exception:
                        return ''
            try:
                return v.decode('ascii', errors='ignore').rstrip('\x00').strip()
            except Exception:
                return ''
        return str(v).rstrip('\x00').strip()
    except Exception:
        return ''


def extract_tags_from_comment(text: str) -> set:
    """Return lowercase #hashtag words from a free-text comment."""
    if not text:
        return set()
    return {m.lower() for m in _TAG_RE.findall(text)}


def extract_icc(filepath):
    """Extract a few readable ICC profile fields if an ICC profile is embedded."""
    result = {}
    try:
        img = Image.open(filepath)
        icc = img.info.get('icc_profile')
        if not icc:
            return result
        profile = ImageCms.getOpenProfile(BytesIO(icc))
        try:    result['Description']      = ImageCms.getProfileDescription(profile).strip()
        except Exception: pass
        try:    result['Manufacturer']     = ImageCms.getProfileManufacturer(profile).strip()
        except Exception: pass
        try:    result['Model']            = ImageCms.getProfileModel(profile).strip()
        except Exception: pass
        try:    result['Copyright']        = ImageCms.getProfileCopyright(profile).strip()
        except Exception: pass
        try:    result['Color Space']      = profile.profile.xcolor_space.strip()
        except Exception: pass
        try:    result['Connection Space'] = profile.profile.connection_space.strip()
        except Exception: pass
        try:    result['Version']          = str(profile.profile.version)
        except Exception: pass
        try:    result['Device Class']     = profile.profile.profile_id.hex() if profile.profile.profile_id else ''
        except Exception: pass
        # Drop empties
        result = {k: v for k, v in result.items() if v}
    except Exception:
        pass
    return result


def extract_png_metadata(filepath):
    """Extract all PNG text chunks (tEXt/iTXt/zTXt) from a PNG file."""
    result = {}
    if filepath.suffix.lower() != '.png':
        return result
    try:
        img = Image.open(filepath)
        for key, value in img.info.items():
            if not isinstance(value, str):
                continue
            result[key] = value
    except Exception:
        pass
    return result


def create_app(root_dir, config, selected_name, dust_name,
               comfy_url='http://127.0.0.1:8188',
               lmstudio_url='http://localhost:1234/v1', comfy_output='',
               monitor_enabled=False, comfy_queue_enabled=False,
               validation_interval=None, thumb_cache_days=3,
               exiftool_path='exiftool',
               run_comfy_command='', run_lmstudio_command=''):
    static_dir    = Path(__file__).parent / 'static'
    app           = Flask(__name__, static_folder=None)
    tools_cfg     = config.get('tools', {})
    root_resolved = root_dir.resolve()
    co_resolved   = Path(comfy_output).resolve() if comfy_output else None

    # In-memory only. Key: str(resolved_path); value: {filename -> {mtime, ctime, size, [width, height, exif_date]}}
    st = {
        'folder_caches':    {},
        'comfy_output':     str(co_resolved) if co_resolved else '',
        'exiftool_path':    exiftool_path,
        'thumb_cache_days': thumb_cache_days,
        # Per-folder tag index (lazily populated on first tag filter request).
        # { '<resolved_folder>': { filename: frozenset(tags) } }
        'tag_index':        {},
    }

    @app.before_request
    def log_request():
        if config.get('defaults', {}).get('debug') is not True:
            return
        g.request_id = str(_uuid.uuid4())[:8]
        g.start_time = time.perf_counter()

        print(f"[{g.request_id}] --> {request.method} {request.path}")

    @app.after_request
    def log_response(response):
        if config.get('defaults', {}).get('debug') is not True:
            return response

        elapsed = (time.perf_counter() - g.start_time) * 1000

        print(
            f"[{g.request_id}] <-- {response.status} "
            f"{elapsed:.1f}ms"
        )

        return response

    # Shared state for watcher coordination
    _index_built      = threading.Event()
    _root_build_time  = [0.0]   # seconds, set by _eager_index
    _last_detection   = [0.0]   # timestamp of last watcher event
    _last_rescan_done = [0.0]   # timestamp when last watcher-triggered rescan finished

    def _eager_index() -> None:
        """Pre-build indexes for root + root/__selected + root/__dust."""
        t0 = time.perf_counter()
        if root_resolved.is_dir():
            st['folder_caches'][str(root_resolved)] = build_index(root_resolved)
        _root_build_time[0] = time.perf_counter() - t0
        _index_built.set()
        for folder in (root_resolved / selected_name, root_resolved / dust_name):
            if folder.is_dir():
                st['folder_caches'][str(folder)] = build_index(folder)

    def _validation_loop() -> None:
        """Periodic incremental scan for __selected / __dust only. Root is handled by the file watcher."""
        if validation_interval is None:
            _index_built.wait()
            interval = max(200.0, min(1800.0, _root_build_time[0] * 20))
            print(f'[index] Revalidation interval: {interval:.0f}s '
                  f'(build: {_root_build_time[0]:.1f}s)', flush=True)
        else:
            interval = float(validation_interval)
        root_key = str(root_resolved)
        while True:
            time.sleep(interval)
            for key in list(st['folder_caches'].keys()):
                if key == root_key:
                    continue          # watcher handles root
                folder = Path(key)
                if not folder.is_dir():
                    st['folder_caches'].pop(key, None)
                    continue
                cache = st['folder_caches'].get(key, {})
                actual: dict = {}
                try:
                    for f in folder.iterdir():
                        if f.is_file() and f.suffix.lower() in EXTENSIONS and not f.name.startswith(('.', '_')):
                            try:
                                actual[f.name] = f.stat()
                            except Exception:
                                pass
                except Exception:
                    continue
                for name, stat in actual.items():
                    entry = cache.get(name)
                    if not entry or entry.get('mtime') != stat.st_mtime or entry.get('size') != stat.st_size:
                        cache[name] = stat_entry(stat)
                for name in list(cache.keys()):
                    if name not in actual:
                        cache.pop(name, None)
                time.sleep(0)

    class _RootChangeHandler(FileSystemEventHandler):
        """React only to image file creation/deletion directly in root (non-recursive)."""
        def _relevant(self, event) -> bool:
            return (
                not event.is_directory
                and Path(event.src_path).suffix.lower() in EXTENSIONS
                and Path(event.src_path).parent.resolve() == root_resolved
            )
        def on_created(self, event):
            if self._relevant(event):
                _last_detection[0] = time.time()
        def on_deleted(self, event):
            if self._relevant(event):
                _last_detection[0] = time.time()

    def _watcher_rescan_loop() -> None:
        """Rebuild root cache when watcher detects changes.
        Requires: 3 s debounce since last event AND 200 s cooldown since last rescan."""
        while True:
            time.sleep(1)
            now = time.time()
            if _last_detection[0] <= _last_rescan_done[0]:
                continue                    # no pending changes
            if now - _last_detection[0] < 3:
                continue                    # debounce: wait for event burst to settle
            if now - _last_rescan_done[0] < 200:
                continue                    # cooldown: don't hammer large folders
            root_key = str(root_resolved)
            old_count = len(st['folder_caches'].get(root_key, {}))
            print(f'[watcher] rebuild start — {old_count} files known', flush=True)
            t0 = time.perf_counter()
            st['folder_caches'][root_key] = build_index(root_resolved)
            elapsed = (time.perf_counter() - t0) * 1000
            new_count = len(st['folder_caches'][root_key])
            _last_rescan_done[0] = time.time()
            print(f'[watcher] rebuild done — {new_count} files in {elapsed:.1f} ms'
                  + (f' (count changed: {old_count} → {new_count})' if new_count != old_count else ''),
                  flush=True)
            if new_count != old_count:
                _sse_broadcast(f'source_changed:{new_count - old_count:+d}')

    threading.Thread(target=_eager_index, daemon=True).start()

    _observer = Observer()
    _observer.schedule(_RootChangeHandler(), str(root_resolved), recursive=False)
    _observer.daemon = True
    _observer.start()
    threading.Thread(target=_watcher_rescan_loop, daemon=True).start()

    # Periodic revalidation for __selected / __dust (0 = disabled)
    if validation_interval != 0:
        threading.Thread(target=_validation_loop, daemon=True).start()
    if thumb_cache_days > 0:
        threading.Thread(
            target=cleanup_old_thumbnails,
            args=([root_resolved, co_resolved], thumb_cache_days),
            daemon=True,
        ).start()
    if monitor_enabled:
        threading.Thread(target=_metrics_loop, daemon=True).start()
    if comfy_queue_enabled:
        threading.Thread(target=_comfy_queue_loop, args=(comfy_url,), daemon=True).start()
        threading.Thread(target=_comfy_ws_loop, args=(comfy_url,), daemon=True).start()

    def resolve_path(rel: str) -> Path:
        """Resolve ?path= to an absolute path. Validates against root and comfy output."""
        rel = (rel or '').strip().lstrip('/')
        if rel.startswith('%comfy_output%'):
            if not co_resolved:
                abort(404, 'ComfyUI output not configured')
            suffix = rel[len('%comfy_output%'):].lstrip('/')
            target = (co_resolved / suffix).resolve() if suffix else co_resolved
            if not target.is_relative_to(co_resolved):
                abort(400, 'invalid path')
            return target
        target = (root_resolved / rel).resolve() if rel else root_resolved
        if not target.is_relative_to(root_resolved):
            abort(400, 'invalid path')
        return target

    def get_folder_cache(folder_path: Path) -> dict:
        key = str(folder_path.resolve())
        if key not in st['folder_caches']:
            st['folder_caches'][key] = build_index(folder_path)
        return st['folder_caches'][key]

    def cache_for(folder_path: Path) -> dict | None:
        """Return existing cache for a folder, or None. Does not build."""
        return st['folder_caches'].get(str(folder_path.resolve()))

    def _ensure_tag_index(folder: Path) -> dict:
        """Build (lazily) the tag index for a folder. Returns {filename: frozenset(tags)}."""
        key = str(folder.resolve())
        idx = st['tag_index'].get(key)
        if idx is None:
            t0 = time.perf_counter()
            idx = {}
            try:
                for f in folder.iterdir():
                    if f.is_file() and f.suffix.lower() in EXTENSIONS and not f.name.startswith(('.', '_')):
                        idx[f.name] = frozenset(extract_tags_from_comment(_user_comment_text(f)))
            except Exception:
                pass
            st['tag_index'][key] = idx
            elapsed = (time.perf_counter() - t0) * 1000
            print(f"[tag_index] built for {folder} ({len(idx)} files) in {elapsed:.1f} ms", flush=True)
        return idx

    def _invalidate_cache(file_path: Path) -> None:
        """Refresh the cache entry for a file after metadata write. Drops tag-index entry too."""
        cache = cache_for(file_path.parent)
        if cache is not None:
            try:
                entry = cache.get(file_path.name) or {}
                entry.update(stat_entry(file_path.stat()))
                entry.pop('exif_date', None)
                cache[file_path.name] = entry
            except Exception:
                pass
        # Tag index for this file is now stale — drop it; next filter call rebuilds.
        folder_key = str(file_path.parent.resolve())
        if folder_key in st['tag_index']:
            st['tag_index'][folder_key].pop(file_path.name, None)

    # Field name → ExifTool EXIF-only tag (one tag per field, no XMP/IPTC mirror).
    EDIT_TAG_MAP = {
        'image_title':   'EXIF:ImageTitle',         # 0xa436
        'artist':        'EXIF:Artist',             # 0x013b
        'description':   'EXIF:ImageDescription',   # 0x010e
        'document_name': 'EXIF:DocumentName',       # 0x010d
        'copyright':     'EXIF:Copyright',          # 0x8298
        'user_comment':  'EXIF:UserComment',        # 0x9286
    }
    STRIP_GROUP_MAP = {
        'all':       ['-all='],
        'sensitive': ['-GPS:all=', '-EXIF:SerialNumber=', '-EXIF:LensSerialNumber=',
                      '-EXIF:OwnerName=', '-XMP:CreatorTool=', '-EXIF:Software='],
        'icc':       ['-icc_profile:all='],
        'exif':      ['-EXIF:all='],
        'gps':       ['-GPS:all='],
    }

    def _exiftool_capabilities():
        """Probe exiftool. Never raises."""
        path = st['exiftool_path']
        try:
            proc = subprocess.run([path, '-ver'], capture_output=True, text=True, timeout=5)
            if proc.returncode == 0:
                return {'available': True, 'version': proc.stdout.strip(), 'executable': path, 'error': None}
            return {'available': False, 'version': None, 'executable': path,
                    'error': proc.stderr.strip() or f'exit {proc.returncode}'}
        except FileNotFoundError:
            return {'available': False, 'version': None, 'executable': path,
                    'error': 'exiftool binary not found'}
        except Exception as e:
            return {'available': False, 'version': None, 'executable': path, 'error': str(e)}

    def _exiftool_run(args, *, parse_json=False, timeout=10):
        """Run exiftool with the given args. Returns parsed JSON or stdout."""
        path = st['exiftool_path']
        proc = subprocess.run([path, *args], capture_output=True, text=True, timeout=timeout)
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or f'exiftool exit {proc.returncode}')
        if parse_json:
            return json.loads(proc.stdout) if proc.stdout.strip() else []
        return proc.stdout

    def _validate_ascii_fields(fields):
        """Validate every value is printable ASCII (0x20-0x7E). Returns error str or None."""
        for k, v in fields.items():
            if v is None or v == '':
                continue
            if not isinstance(v, str):
                return f'field {k} must be a string'
            if not all(0x20 <= ord(c) <= 0x7E for c in v):
                return f'field {k} contains non-ASCII characters'
        return None

    def _build_edit_args(fields):
        """Build exiftool args for the editable field set. Skips empty values."""
        args = []
        for field, value in fields.items():
            if field not in EDIT_TAG_MAP:
                raise ValueError(f'unknown field: {field}')
            if value is None or value == '':
                continue
            tag = EDIT_TAG_MAP[field]
            args.append(f'-{tag}={value}')
        return args

    # --- API routes ---

    @app.route('/api/photos')
    def list_photos():
        target      = resolve_path(request.args.get('path', ''))
        cache       = get_folder_cache(target)
        sort_by     = request.args.get('sort_by', 'name')
        sort_asc    = request.args.get('sort_asc', 'true') == 'true'
        offset      = int(request.args.get('offset', 0))
        limit       = int(request.args.get('limit', 50))
        filter_text = request.args.get('filter', '').strip().lower()
        date_field  = request.args.get('date_field', '')
        date_from   = request.args.get('date_from', '')
        date_to     = request.args.get('date_to', '')
        types_raw   = request.args.get('types', '')
        size_min    = request.args.get('size_min', '')
        size_max    = request.args.get('size_max', '')
        width_min   = request.args.get('width_min', '')
        width_max   = request.args.get('width_max', '')
        height_min  = request.args.get('height_min', '')
        height_max  = request.args.get('height_max', '')
        tags_raw    = request.args.get('tags', '')

        filter_types    = [t.strip() for t in types_raw.split(',') if t.strip()] if types_raw else []
        filter_size_min = int(size_min) if size_min else None
        filter_size_max = int(size_max) if size_max else None
        filter_w_min    = int(width_min)  if width_min  else None
        filter_w_max    = int(width_max)  if width_max  else None
        filter_h_min    = int(height_min) if height_min else None
        filter_h_max    = int(height_max) if height_max else None
        # Strip leading '#' from each tag and lowercase, so "#summer" and "summer" both work.
        filter_tags     = {t.lstrip('#').lower() for t in tags_raw.split(',') if t.strip()} if tags_raw else set()
        need_dims       = any(v is not None for v in (filter_w_min, filter_w_max, filter_h_min, filter_h_max))
        date_from_dt    = datetime.fromisoformat(date_from) if date_from else None
        date_to_dt      = datetime.fromisoformat(date_to + 'T23:59:59') if date_to else None

        # Lazy build of tag index — only when this filter is requested.
        tag_index = _ensure_tag_index(target) if filter_tags else None

        filtered = []
        for name, entry in cache.items():
            ext = Path(name).suffix.lower()
            if filter_text:
                name_lower = name.lower()
                invert = filter_text.startswith('!')
                pattern = filter_text[1:] if invert else filter_text
                if pattern:
                    if any(c in pattern for c in ('*', '?', '.')):
                        matched = fnmatch.fnmatch(name_lower, pattern)
                    else:
                        matched = pattern in name_lower
                    if invert == matched:
                        continue
            if filter_types and ext not in filter_types:
                continue
            if filter_tags:
                # Lazy per-file rebuild if entry was invalidated by an edit.
                file_tags = tag_index.get(name)
                if file_tags is None:
                    file_tags = frozenset(extract_tags_from_comment(_user_comment_text(target / name)))
                    tag_index[name] = file_tags
                if not (filter_tags & file_tags):
                    continue
            if filter_size_min is not None and entry['size'] < filter_size_min:
                continue
            if filter_size_max is not None and entry['size'] > filter_size_max:
                continue
            if need_dims:
                ensure_dimensions(target, name, entry)
                w = entry.get('width')
                h = entry.get('height')
                if w is None or h is None:
                    continue
                if filter_w_min is not None and w < filter_w_min: continue
                if filter_w_max is not None and w > filter_w_max: continue
                if filter_h_min is not None and h < filter_h_min: continue
                if filter_h_max is not None and h > filter_h_max: continue
            if date_field and (date_from_dt or date_to_dt):
                if date_field == 'modified':
                    file_dt = datetime.fromtimestamp(entry['mtime'])
                elif date_field == 'created':
                    file_dt = datetime.fromtimestamp(entry['ctime'])
                elif date_field == 'exif':
                    ensure_exif_date(target, name, entry)
                    ed = entry.get('exif_date')
                    if not ed:
                        continue
                    try:
                        file_dt = datetime.fromisoformat(ed)
                    except ValueError:
                        continue
                else:
                    file_dt = None
                if file_dt is not None:
                    if date_from_dt and file_dt < date_from_dt: continue
                    if date_to_dt and file_dt > date_to_dt: continue
            filtered.append((name, entry))

        if sort_by == 'modified':
            filtered.sort(key=lambda kv: kv[1]['mtime'], reverse=not sort_asc)
        else:
            filtered.sort(key=lambda kv: kv[0].lower(), reverse=not sort_asc)

        total = len(filtered)
        page  = filtered[offset:offset + limit]

        photos = [{
            'filename':       name,
            'modified':       datetime.fromtimestamp(entry['mtime']).isoformat(),
            'modified_token': mtime_token(entry['mtime']),
            'size':           entry['size'],
            'size_human':     human_size(entry['size']),
            'width':          entry.get('width'),
            'height':         entry.get('height'),
        } for name, entry in page]

        return jsonify({'photos': photos, 'total': total, 'offset': offset, 'source_name': target.name})

    @app.route('/api/photo')
    def serve_photo():
        # `modified` query param is accepted for browser cache busting and ignored here.
        file_path = resolve_path(request.args.get('path', ''))
        if not file_path.is_file():
            abort(404)
        resp = send_file(file_path, max_age=31536000)
        resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        return resp

    @app.route('/api/thumbnail')
    def serve_thumbnail():
        # `modified` query param is for browser cache; on-disk cache uses the actual file mtime.
        img_path = resolve_path(request.args.get('path', ''))
        if not img_path.is_file():
            abort(404)
        tok        = mtime_token(img_path.stat().st_mtime)
        thumb_path = img_path.parent / THUMBNAILS_DIR / f'{img_path.name}.{tok}.jpg'
        if not thumb_path.is_file():
            thumb_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                img = Image.open(img_path)
                img.thumbnail((300, 300))
                img.convert('RGB').save(thumb_path, 'JPEG', quality=80)
            except Exception:
                return send_file(img_path, max_age=3600)
        resp = send_file(thumb_path, mimetype='image/jpeg', max_age=31536000)
        resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        return resp

    @app.route('/api/info')
    def photo_info():
        file_path = resolve_path(request.args.get('path', ''))
        if not file_path.is_file():
            return jsonify({'error': 'not found'}), 404
        cache = get_folder_cache(file_path.parent)
        entry = cache.setdefault(file_path.name, stat_entry(file_path.stat()))
        ensure_dimensions(file_path.parent, file_path.name, entry)
        ensure_exif_date(file_path.parent, file_path.name, entry)
        try:
            img = Image.open(file_path)
            fmt = img.format or file_path.suffix.upper().lstrip('.')
        except Exception:
            fmt = file_path.suffix.upper().lstrip('.')
        mtime_iso = datetime.fromtimestamp(entry['mtime']).isoformat()
        ctime_iso = datetime.fromtimestamp(entry['ctime']).isoformat()
        exif_data = extract_exif(file_path) if config.get('parameters', {}).get('extract_exif', True) else {}
        png_metadata = extract_png_metadata(file_path) if config.get('parameters', {}).get('extract_png', False) else None
        comfyui =  extract_comfyui_data(png_metadata['prompt']) if png_metadata and png_metadata['prompt'] else None
        return jsonify({
            'filename':       file_path.name,
            'modified':       mtime_iso,
            'modified_token': mtime_token(entry['mtime']),
            'created':        ctime_iso if int(entry['ctime']) != int(entry['mtime']) else None,
            'size':           entry['size'],
            'size_human':     human_size(entry['size']),
            'width':          entry.get('width') or 0,
            'height':         entry.get('height') or 0,
            'format':         fmt,
            'comfyui':        comfyui,
            'exif':           exif_data,
            'gps':            extract_gps(file_path) if config.get('parameters', {}).get('extract_gps', False) else None,
            'icc':            extract_icc(file_path) if config.get('parameters', {}).get('extract_icc', False) else None,
            'png_metadata':   png_metadata,
            'tags':           ", ".join(extract_tags_from_comment(exif_data.get('UserComment'))) if exif_data.get('UserComment') else ""
        })

    @app.route('/api/move', methods=['POST'])
    def move_photo():
        src_path = resolve_path(request.args.get('path', ''))
        dest_dir = resolve_path(request.get_json().get('destination', ''))
        if not src_path.is_file():
            return jsonify({'error': 'file not found'}), 404
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_path = dest_dir / src_path.name
        shutil.move(str(src_path), str(dest_path))
        src_cache = cache_for(src_path.parent)
        if src_cache is not None:
            src_cache.pop(src_path.name, None)
        dst_cache = cache_for(dest_dir)
        if dst_cache is not None:
            try:
                dst_cache[src_path.name] = stat_entry(dest_path.stat())
            except Exception:
                pass
        undo_stack.append({'filename': src_path.name, 'from': str(src_path), 'to': str(dest_path)})
        return jsonify({'ok': True, 'filename': src_path.name})

    @app.route('/api/undo', methods=['POST'])
    def undo():
        if not undo_stack:
            return jsonify({'ok': False, 'error': 'nothing to undo'}), 400
        entry     = undo_stack.pop()
        to_path   = Path(entry['to'])
        from_path = Path(entry['from'])
        if not to_path.is_file():
            return jsonify({'ok': False, 'error': 'file not found'}), 404
        from_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(to_path), str(from_path))
        to_cache = cache_for(to_path.parent)
        if to_cache is not None:
            to_cache.pop(to_path.name, None)
        from_cache = cache_for(from_path.parent)
        if from_cache is not None:
            try:
                from_cache[from_path.name] = stat_entry(from_path.stat())
            except Exception:
                pass
        return jsonify({'ok': True, 'filename': entry['filename']})

    @app.route('/api/comfy/free', methods=['POST'])
    def comfy_free():
        data = request.get_json()
        comfy_url = data.get('comfy_url', 'http://127.0.0.1:8188')
        try:
            http_requests.post(f"{comfy_url}/free",
                               json={"unload_models": True, "free_memory": True}, timeout=5)
        except Exception:
            pass
        return jsonify({'ok': True})

    @app.route('/api/comfy/check', methods=['POST'])
    def comfy_check():
        data = request.get_json()
        comfy_url = data.get('comfy_url', 'http://127.0.0.1:8188')
        try:
            resp = http_requests.get(f"{comfy_url}/system_stats", timeout=5)
            return jsonify(resp.json()), resp.status_code
        except Exception as e:
            return jsonify({'error': str(e)}), 502

    @app.route('/api/comfy/loras', methods=['POST'])
    def comfy_loras():
        data = request.get_json()
        comfy_url = data.get('comfy_url', 'http://127.0.0.1:8188')
        try:
            resp = http_requests.get(f"{comfy_url}/object_info", timeout=10)
            info = resp.json()
            loras = info.get('LoraLoader', {}).get('input', {}).get('required', {}).get('lora_name', [[]])[0]
            return jsonify({'loras': loras})
        except Exception as e:
            return jsonify({'error': str(e)}), 502

    @app.route('/api/comfy/checkpoints', methods=['POST'])
    def comfy_checkpoints():
        data = request.get_json()
        comfy_url = data.get('comfy_url', 'http://127.0.0.1:8188')
        try:
            resp = http_requests.get(f"{comfy_url}/object_info", timeout=10)
            info = resp.json()
            checkpoints = info.get('CheckpointLoaderSimple', {}).get('input', {}).get('required', {}).get('ckpt_name', [[]])[0]
            return jsonify({'checkpoints': checkpoints})
        except Exception as e:
            return jsonify({'error': str(e)}), 502

    @app.route('/api/comfy/samplers', methods=['POST'])
    def comfy_samplers():
        data = request.get_json()
        comfy_url = data.get('comfy_url', 'http://127.0.0.1:8188')
        try:
            resp = http_requests.get(f"{comfy_url}/object_info/KSampler", timeout=10)
            info = resp.json().get('KSampler', {}).get('input', {}).get('required', {})
            samplers = info.get('sampler_name', [[]])[0]
            schedulers = info.get('scheduler', [[]])[0]
            return jsonify({'samplers': samplers, 'schedulers': schedulers})
        except Exception as e:
            return jsonify({'error': str(e)}), 502

    @app.route('/api/comfy/prompt', methods=['POST'])
    def comfy_prompt():
        data = request.get_json()
        comfy_url = data.get('comfy_url', 'http://127.0.0.1:8188')
        prompt = data.get('prompt')
        if not prompt:
            return jsonify({'error': 'no prompt data'}), 400
        try:
            resp = http_requests.post(f"{comfy_url}/prompt", json={"prompt": prompt}, timeout=10)
            return jsonify(resp.json()), resp.status_code
        except Exception as e:
            return jsonify({'error': str(e)}), 502

    @app.route('/api/lmstudio/unload', methods=['POST'])
    def lmstudio_unload():
        data = request.get_json()
        lmstudio_url = data.get('lmstudio_url', 'http://localhost:1234/v1')
        parsed = urlparse(lmstudio_url)
        base = f"{parsed.scheme}://{parsed.netloc}"
        try:
            resp = http_requests.get(f"{base}/api/v1/models", timeout=5)
            models = resp.json().get('models', [])
            for model in models:
                for instance in model.get('loaded_instances', []):
                    instance_id = instance.get('id')
                    if instance_id:
                        http_requests.post(
                            f"{base}/api/v1/models/unload",
                            json={"instance_id": instance_id},
                            timeout=5,
                        )
        except Exception:
            pass
        return jsonify({'ok': True})

    @app.route('/api/lmstudio/check', methods=['POST'])
    def lmstudio_check():
        data = request.get_json()
        lmstudio_url = data.get('lmstudio_url', 'http://localhost:1234/v1')
        try:
            resp = http_requests.get(f"{lmstudio_url}/models", timeout=5)
            return jsonify(resp.json()), resp.status_code
        except Exception as e:
            return jsonify({'error': str(e)}), 502

    @app.route('/api/lmstudio/prompt', methods=['POST'])
    def lmstudio_prompt():
        data    = request.get_json()
        lms_url = data.get('lmstudio_url', 'http://localhost:1234/v1')
        prompt  = data.get('prompt', '')
        model   = data.get('model', 'model-identifier')
        try:
            resp = http_requests.post(
                f"{lms_url}/chat/completions",
                json={'model': model, 'messages': [{'role': 'user', 'content': prompt}], 'temperature': 0.7},
                timeout=60,
            )
            return jsonify({'description': resp.json()['choices'][0]['message']['content']})
        except Exception as e:
            return jsonify({'error': str(e)}), 502

    @app.route('/api/describe', methods=['POST'])
    def describe_photo():
        data      = request.get_json()
        file_path = resolve_path(request.args.get('path', ''))
        if not file_path.is_file():
            return jsonify({'error': 'not found'}), 404
        lms_url = data.get('lmstudio_url', 'http://localhost:1234/v1')
        prompt  = data.get('prompt', 'Describe this image in detail.')
        model   = data.get('model', 'model-identifier')
        mt, _   = mimetypes.guess_type(str(file_path))
        mt      = mt or 'image/png'
        with open(file_path, 'rb') as f:
            b64 = base64.b64encode(f.read()).decode('ascii')
        try:
            resp = http_requests.post(
                f"{lms_url}/chat/completions",
                json={'model': model, 'messages': [{'role': 'user', 'content': [
                    {'type': 'text', 'text': prompt},
                    {'type': 'image_url', 'image_url': {'url': f'data:{mt};base64,{b64}'}},
                ]}], 'temperature': 0.2},
                timeout=120,
            )
            return jsonify({'description': resp.json()['choices'][0]['message']['content']})
        except Exception as e:
            return jsonify({'error': str(e)}), 502

    @app.route('/api/write-meta', methods=['POST'])
    def write_meta():
        data        = request.get_json()
        file_path   = resolve_path(request.args.get('path', ''))
        description = data.get('description', '')
        key         = data.get('key', 'Description')
        if not file_path.is_file():
            return jsonify({'error': 'not found'}), 404
        try:
            img = Image.open(file_path)
            ext = file_path.suffix.lower()
            if ext == '.png':
                info = PngInfo()
                for k, v in img.info.items():
                    if isinstance(v, str):
                        info.add_text(k, v)
                info.add_text(key, description)
                img.save(file_path, pnginfo=info)
            elif ext in ('.jpg', '.jpeg', '.webp'):
                exif = img.getexif()
                exif[0x010E] = description
                img.save(file_path, quality=98, exif=exif.tobytes())
            else:
                return jsonify({'error': f'Unsupported format: {ext}'}), 400
            cache = cache_for(file_path.parent)
            if cache is not None:
                try:
                    entry = cache.get(file_path.name) or {}
                    entry.update(stat_entry(file_path.stat()))
                    entry.pop('exif_date', None)
                    cache[file_path.name] = entry
                except Exception:
                    pass
            return jsonify({'ok': True})
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    @app.route('/api/exiftool/capabilities')
    def exiftool_capabilities():
        return jsonify(_exiftool_capabilities())

    @app.route('/api/exiftool/metadata', methods=['GET'])
    def exiftool_metadata():
        file_path = resolve_path(request.args.get('path', ''))
        if not file_path.is_file():
            return jsonify({'error': 'not found'}), 404
        caps = _exiftool_capabilities()
        if not caps['available']:
            return jsonify({'error': caps.get('error') or 'exiftool unavailable'}), 503
        try:
            data = _exiftool_run(['-j', '-G1', '-a', '-s', str(file_path)], parse_json=True)
            if not data:
                return jsonify({})
            obj = data[0]
            obj.pop('SourceFile', None)
            return jsonify(obj)
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    @app.route('/api/exiftool/edit', methods=['POST'])
    def exiftool_edit():
        file_path = resolve_path(request.args.get('path', ''))
        if not file_path.is_file():
            return jsonify({'error': 'not found'}), 404
        caps = _exiftool_capabilities()
        if not caps['available']:
            return jsonify({'error': caps.get('error') or 'exiftool unavailable'}), 503
        body   = request.get_json(silent=True) or {}
        fields = body.get('fields') or {}
        if not isinstance(fields, dict):
            return jsonify({'error': 'fields must be an object'}), 400
        err = _validate_ascii_fields(fields)
        if err:
            return jsonify({'error': err}), 400
        try:
            tag_args = _build_edit_args(fields)
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        if not tag_args:
            return jsonify({'ok': True})
        try:
            _exiftool_run(['-overwrite_original', *tag_args, str(file_path)])
            _invalidate_cache(file_path)
            return jsonify({'ok': True})
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    @app.route('/api/exiftool/edit-batch', methods=['POST'])
    def exiftool_edit_batch():
        caps = _exiftool_capabilities()
        if not caps['available']:
            return jsonify({'error': caps.get('error') or 'exiftool unavailable'}), 503
        body      = request.get_json(silent=True) or {}
        filenames = body.get('filenames') or []
        folder    = body.get('folder', '')
        fields    = body.get('fields') or {}
        if not isinstance(filenames, list) or not filenames:
            return jsonify({'error': 'filenames must be a non-empty list'}), 400
        if not isinstance(fields, dict):
            return jsonify({'error': 'fields must be an object'}), 400
        err = _validate_ascii_fields(fields)
        if err:
            return jsonify({'error': err}), 400
        try:
            tag_args = _build_edit_args(fields)
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        if not tag_args:
            return jsonify({'ok': True, 'count': 0, 'succeeded': [], 'errors': []})
        succeeded, errors = [], []
        for name in filenames:
            try:
                p = resolve_path(f'{folder}/{name}' if folder else name)
                if not p.is_file():
                    errors.append({'path': str(name), 'error': 'not found'})
                    continue
                _exiftool_run(['-overwrite_original', *tag_args, str(p)])
                _invalidate_cache(p)
                succeeded.append(str(p))
            except Exception as e:
                errors.append({'path': str(name), 'error': str(e)})
        return jsonify({'ok': not errors, 'count': len(succeeded),
                        'succeeded': succeeded, 'errors': errors})

    @app.route('/api/exiftool/strip', methods=['POST'])
    def exiftool_strip():
        file_path = resolve_path(request.args.get('path', ''))
        if not file_path.is_file():
            return jsonify({'error': 'not found'}), 404
        caps = _exiftool_capabilities()
        if not caps['available']:
            return jsonify({'error': caps.get('error') or 'exiftool unavailable'}), 503
        body   = request.get_json(silent=True) or {}
        groups = body.get('groups') or []
        if not isinstance(groups, list) or not groups:
            return jsonify({'error': 'groups must be a non-empty list'}), 400
        flags = ['-overwrite_original']
        if 'all' in groups:
            flags += STRIP_GROUP_MAP['all']
        else:
            for g in groups:
                if g not in STRIP_GROUP_MAP:
                    return jsonify({'error': f'unknown group: {g}'}), 400
                flags += STRIP_GROUP_MAP[g]
        flags.append(str(file_path))
        try:
            _exiftool_run(flags)
            _invalidate_cache(file_path)
            return jsonify({'ok': True})
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    @app.route('/api/locate', methods=['POST'])
    def locate_photo():
        file_path = resolve_path(request.args.get('path', ''))
        if not file_path.is_file():
            return jsonify({'error': 'not found'}), 404
        try:
            subprocess.Popen(['explorer', f'/select,{file_path}'])
            return jsonify({'ok': True})
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    @app.route('/api/folders')
    def list_folders():
        folders = []
        try:
            for f in sorted(root_dir.rglob('*')):
                if not f.is_dir():
                    continue
                rel = f.relative_to(root_dir)
                if any(p.startswith('_') for p in rel.parts):
                    continue
                folders.append(str(rel).replace('\\', '/'))
        except Exception:
            pass
        co = st['comfy_output']
        return jsonify({
            'folders':           folders,
            'root_name':         root_dir.name,
            'comfy_output':      co or None,
            'comfy_output_name': Path(co).name if co else None,
            'selected_name':     selected_name,
            'dust_name':         dust_name,
        })

    @app.route('/api/tools')
    def list_tools():
        return jsonify({'tools': list(tools_cfg.keys())})

    @app.route('/api/tools/run', methods=['POST'])
    def run_tool():
        name      = request.json.get('name', '')
        file_path = resolve_path(request.args.get('path', ''))
        if name not in tools_cfg:
            return jsonify({'ok': False, 'error': 'Unknown tool'}), 400
        if not file_path.is_file():
            return jsonify({'ok': False, 'error': 'File not found'}), 404
        quoted = f'"{file_path}"' if sys.platform == 'win32' else shlex.quote(str(file_path))
        cmd = tools_cfg[name].replace('%filename%', quoted)
        try:
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
            return jsonify({
                'ok': result.returncode == 0,
                'stdout': result.stdout,
                'stderr': result.stderr,
                'returncode': result.returncode,
            })
        except subprocess.TimeoutExpired:
            return jsonify({'ok': False, 'error': 'Command timed out'}), 500
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e)}), 500

    @app.route('/api/batch', methods=['POST'])
    def batch_operation():
        data        = request.get_json()
        src_dir     = resolve_path(request.args.get('path', ''))
        filenames   = data.get('filenames', [])
        operation   = data.get('operation', 'copy')
        use_comfy   = data.get('use_comfy_output', False)
        destination = data.get('destination', '')
        do_zip      = data.get('zip', False)

        if use_comfy:
            co = st['comfy_output']
            if not co:
                return jsonify({'ok': False, 'error': 'comfy_output not configured'}), 400
            dst_dir = Path(co)
        else:
            dst_dir = resolve_path(destination) if destination else root_dir

        dst_dir.mkdir(parents=True, exist_ok=True)
        resolved = [(fn, src_dir / fn) for fn in filenames if (src_dir / fn).is_file()]
        processed, errors = [], []

        if do_zip:
            ts = datetime.now().strftime('%Y%m%d_%H%M%S')
            zip_path = dst_dir / f'batch_{ts}.zip'
            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
                for fn, p in resolved:
                    zf.write(p, fn)
                    processed.append(fn)
            if operation == 'move':
                for _, p in resolved:
                    p.unlink(missing_ok=True)
                src_cache = cache_for(src_dir)
                if src_cache is not None:
                    for fn in processed:
                        src_cache.pop(fn, None)
        else:
            src_cache = cache_for(src_dir)
            dst_cache = cache_for(dst_dir)
            for fn, p in resolved:
                try:
                    target = dst_dir / fn
                    if operation == 'move':
                        shutil.move(str(p), target)
                        if src_cache is not None:
                            src_cache.pop(fn, None)
                    else:
                        shutil.copy2(p, target)
                    if dst_cache is not None:
                        try:
                            dst_cache[fn] = stat_entry(target.stat())
                        except Exception:
                            pass
                    processed.append(fn)
                except Exception as e:
                    errors.append(str(e))

        return jsonify({'ok': True, 'count': len(processed), 'errors': errors})

    @app.route('/api/zip', methods=['POST'])
    def zip_files():
        data      = request.get_json()
        folder    = resolve_path(request.args.get('path', ''))
        filenames = data.get('filenames', [])
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            for fn in filenames:
                p = folder / fn
                if p.is_file():
                    zf.write(p, fn)
        buf.seek(0)
        return send_file(buf, mimetype='application/zip',
                         as_attachment=True, download_name='photos.zip')

    @app.route('/api/metrics/pause', methods=['POST'])
    def metrics_pause():
        client_id = request.json.get('client_id', '')
        paused = request.json.get('paused', True)
        with _sse_lock:
            if client_id in _sse_clients:
                _sse_clients[client_id]['metrics'] = not paused
        return jsonify({'ok': True})

    @app.route('/api/comfy-queue/pause', methods=['POST'])
    def comfy_queue_pause():
        client_id = request.json.get('client_id', '')
        paused = request.json.get('paused', True)
        with _sse_lock:
            if client_id in _sse_clients:
                _sse_clients[client_id]['comfy_queue'] = not paused
        return jsonify({'ok': True})

    @app.route('/api/refresh', methods=['POST'])
    def refresh():
        target = resolve_path(request.args.get('path', ''))
        st['folder_caches'][str(target.resolve())] = build_index(target)
        return jsonify({'ok': True})

    @app.route('/api/config')
    def api_config():
        return jsonify({
            'comfy_url':            comfy_url,
            'lmstudio_url':         lmstudio_url,
            'widgets':              {'gpu_monitor': monitor_enabled, 'comfy_queue': comfy_queue_enabled},
            'selected_name':        selected_name,
            'dust_name':            dust_name,
            'thumbnails_name':      THUMBNAILS_DIR,
            'root_name':            root_dir.name,
            'has_run_comfy_command':    bool(run_comfy_command),
            'has_run_lmstudio_command': bool(run_lmstudio_command),
        })

    @app.route('/api/run-command', methods=['POST'])
    def run_command():
        data = request.get_json() or {}
        service = data.get('service')
        if service == 'comfy':
            cmd = run_comfy_command
        elif service == 'lmstudio':
            cmd = run_lmstudio_command
        else:
            return jsonify({'error': 'unknown service'}), 400
        if not cmd:
            return jsonify({'error': 'no command configured'}), 400
        try:
            cmd_path = Path(cmd)
            cwd = str(cmd_path.parent) if cmd_path.parent.is_dir() else None
            subprocess.Popen(
                ['cmd', '/c', cmd],
                cwd=cwd,
                creationflags=subprocess.CREATE_NEW_CONSOLE,
            )
            return jsonify({'ok': True})
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    @app.route('/api/events')
    def sse_events():
        from flask import Response, stream_with_context
        client_id = str(_uuid.uuid4())
        q = queue.Queue(maxsize=8)

        def generate():
            with _sse_lock:
                _sse_clients[client_id] = {'queue': q, 'metrics': True, 'comfy_queue': True}
            try:
                yield f'data: client_id:{client_id}\n\n'
                while True:
                    try:
                        msg = q.get(timeout=25)
                        yield f'data: {msg}\n\n'
                    except queue.Empty:
                        yield ': heartbeat\n\n'
            finally:
                with _sse_lock:
                    _sse_clients.pop(client_id, None)

        return Response(
            stream_with_context(generate()),
            mimetype='text/event-stream',
            headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
        )

    @app.route('/api/file-types')
    def file_types():
        target = resolve_path(request.args.get('path', ''))
        cache  = get_folder_cache(target)
        types  = sorted({Path(name).suffix.lower() for name in cache.keys()})
        return jsonify({'types': types})

    # --- Static / SPA routes ---

    @app.route('/')
    def index():
        return send_from_directory(static_dir, 'index.html')

    @app.route('/<path:path>')
    def static_files(path):
        file_path = static_dir / path
        if file_path.is_file():
            return send_from_directory(static_dir, path)
        return send_from_directory(static_dir, 'index.html')

    return app


def main():
    config = load_config()
    defaults = config.get('defaults', {})

    if len(sys.argv) >= 2:
        source = Path(sys.argv[1]).resolve()
        if not source.is_dir():
            print(f"Error: '{source}' is not a valid directory")
            sys.exit(1)
    else:
        co = defaults.get('comfy_output', '')
        if not co:
            print("Usage: python app.py <source_folder>")
            sys.exit(1)
        source = Path(co).resolve()
        if not source.is_dir():
            print(f"Error: comfy_output '{source}' is not a valid directory")
            sys.exit(1)

    selected_name       = defaults.get('selected_dir_name', '__selected')
    dust_name           = defaults.get('dust_dir_name',     '__dust')
    port                = defaults.get('port', 1976)
    comfy_url              = defaults.get('comfy_url', 'http://127.0.0.1:8188')
    lmstudio_url           = defaults.get('lmstudio_url', 'http://localhost:1234/v1')
    comfy_output           = defaults.get('comfy_output', '')
    raw_interval           = defaults.get('index_validation_interval')  # None = auto-compute
    validation_interval    = None if raw_interval is None else int(raw_interval)
    thumb_cache_days       = defaults.get('thumb_cache_days', 3)
    exiftool_path          = defaults.get('exiftool_path', 'exiftool')
    run_comfy_command      = defaults.get('run_comfy_command', '')
    run_lmstudio_command   = defaults.get('run_lmstudio_command', '')
    widgets                = config.get('widgets', {})
    monitor_enabled        = widgets.get('gpu_monitor', False)
    comfy_queue_enabled    = widgets.get('comfy_queue', False)
    app = create_app(source, config, selected_name, dust_name,
                     comfy_url, lmstudio_url, comfy_output,
                     monitor_enabled, comfy_queue_enabled,
                     validation_interval, thumb_cache_days,
                     exiftool_path, run_comfy_command, run_lmstudio_command)

    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(('127.0.0.1', port)) == 0:
            print(f"Error: port {port} is already in use")
            # sys.exit(1)

    threading.Timer(1.0, webbrowser.open, args=[f'http://localhost:{port}']).start()
    app.run(host='127.0.0.1', port=port, debug=False, threaded=True)


def load_config():
    config_path = Path(__file__).parent / 'config.toml'
    if config_path.is_file():
        with open(config_path, 'rb') as f:
            return tomllib.load(f)
    return {}


if __name__ == '__main__':
    main()
