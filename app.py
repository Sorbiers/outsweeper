import sys
import io
import json
import queue
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

try:
    import tomllib
except ImportError:
    import tomli as tomllib


import requests as http_requests
from flask import Flask, jsonify, request, send_from_directory, send_file, abort
from PIL import Image
from PIL.ExifTags import TAGS
from PIL.PngImagePlugin import PngInfo

EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp'}
undo_stack = []

# SSE client registry
_sse_clients: dict = {}   # client_id -> {'queue': Queue, 'metrics': bool, 'comfy_queue': bool}
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
        if not any(c['metrics'] for c in _sse_clients.values()):
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
        if not any(c.get('comfy_queue', True) for c in _sse_clients.values()):
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


class _SourceWatcher:
    """Watchdog-based file-system watcher that broadcasts SSE events."""
    def __init__(self, root: Path, st: dict):
        self.root = root
        self.st = st

    def _relevant(self, path: str) -> bool:
        return Path(path).suffix.lower() in EXTENSIONS

    def dispatch(self, event) -> None:
        if event.is_directory:
            return
        src = getattr(event, 'src_path', '')
        dest = getattr(event, 'dest_path', '')
        changed = False
        for p in (src, dest):
            if p and self._relevant(p):
                self.st['folder_caches'].pop(str(Path(p).parent), None)
                changed = True
        if changed:
            _sse_broadcast('files_changed')


def get_exif_date(filepath):
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


def save_folder_cache(folder_path: Path, cache: dict, index_filename: str = '__photoparser_index.json'):
    index_path = folder_path / index_filename
    try:
        with open(index_path, 'w', encoding='utf-8') as fh:
            json.dump(cache, fh)
    except Exception:
        pass


def build_index(source: Path, st: dict):
    """Scan source folder, build metadata index, update st['folder_caches']."""
    index_filename = st.get('index_filename', '__photoparser_index.json')
    old_cache = st.get('folder_caches', {}).get(str(source), {})
    new_cache = {}
    if source.is_dir():
        for f in source.iterdir():
            if not f.is_file() or f.suffix.lower() not in EXTENSIONS:
                continue
            try:
                stat = f.stat()
                w = h = None
                try:
                    with Image.open(f) as im:
                        w, h = im.size
                except Exception:
                    pass
                new_cache[f.name] = {
                    'created':   datetime.fromtimestamp(stat.st_ctime).isoformat(),
                    'modified':  datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    'exif_date': get_exif_date(f),
                    'size':      stat.st_size,
                    'type':      f.suffix.lower(),
                    'width':     w,
                    'height':    h,
                    'favorite':  old_cache.get(f.name, {}).get('favorite', False),
                }
            except Exception:
                pass
    save_folder_cache(source, new_cache, index_filename)
    if 'folder_caches' not in st:
        st['folder_caches'] = {}
    st['folder_caches'][str(source)] = new_cache


def human_size(nbytes):
    for unit in ('B', 'KB', 'MB', 'GB'):
        if nbytes < 1024:
            return f"{nbytes:.1f} {unit}"
        nbytes /= 1024
    return f"{nbytes:.1f} TB"


def extract_comfyui_data(filepath):
    """Extract ComfyUI workflow data from PNG metadata."""
    result = {'found': False}
    if filepath.suffix.lower() != '.png':
        return result

    try:
        img = Image.open(filepath)
        meta = img.info
        if 'prompt' not in meta:
            return result

        prompt = json.loads(meta['prompt'])
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
    """Extract EXIF data from any image file that supports it."""
    result = {}
    try:
        img = Image.open(filepath)
        exif_data = img.getexif()
        for tag_id, value in exif_data.items():
            tag_name = TAGS.get(tag_id, tag_id)
            if isinstance(value, bytes) and len(value) > 256:
                continue
            result[str(tag_name)] = str(value)
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
               index_filename='__photoparser_index.json', watch_enabled=False,
               comfy_url='http://127.0.0.1:8188', lmstudio_url='http://localhost:1234/v1',
               comfy_output='', monitor_enabled=False, comfy_queue_enabled=False,
               thumbnails_name='__thumbnails'):
    static_dir = Path(__file__).parent / 'static'
    app = Flask(__name__, static_folder=None)
    allow_dir_change = config.get('permissions', {}).get('allow_dir_change', False)
    tools_cfg = config.get('tools', {})

    initial_cache = {}
    index_path = root_dir / index_filename
    if index_path.is_file():
        try:
            with open(index_path, encoding='utf-8') as fh:
                initial_cache = json.load(fh)
        except Exception:
            pass

    st = {
        'root':           root_dir,
        'folder_caches':  {str(root_dir): initial_cache},
        'index_filename': index_filename,
        'observer':       None,
        'comfy_output':   str(Path(comfy_output).resolve()) if comfy_output else '',
    }

    def _start_observer() -> None:
        if watch_enabled:
            from watchdog.observers import Observer
            obs = Observer()
            obs.schedule(_SourceWatcher(root_dir, st), str(root_dir), recursive=True)
            obs.start()
            st['observer'] = obs

    threading.Thread(target=build_index, args=(root_dir, st), daemon=True).start()
    _start_observer()
    if monitor_enabled:
        threading.Thread(target=_metrics_loop, daemon=True).start()
    if comfy_queue_enabled:
        threading.Thread(target=_comfy_queue_loop, args=(comfy_url,), daemon=True).start()
        threading.Thread(target=_comfy_ws_loop, args=(comfy_url,), daemon=True).start()

    def resolve_folder_path(rel: str) -> Path:
        if not rel or rel == '.':
            return root_dir
        if rel == '__comfy_output':
            co = st['comfy_output']
            if not co:
                abort(404, 'comfy_output not configured')
            return Path(co)
        target = (root_dir / rel).resolve()
        if not target.is_relative_to(root_dir):
            abort(400, 'invalid path')
        if not allow_dir_change:
            allowed = {root_dir, root_dir / selected_name, root_dir / dust_name}
            if target not in allowed:
                abort(403, 'not permitted')
        return target

    def get_folder_cache(folder_path: Path) -> dict:
        key = str(folder_path)
        if key not in st['folder_caches']:
            cache = {}
            idx_path = folder_path / index_filename
            if idx_path.is_file():
                try:
                    with open(idx_path, encoding='utf-8') as fh:
                        cache = json.load(fh)
                except Exception:
                    pass
            st['folder_caches'][key] = cache
        return st['folder_caches'][key]

    def save_cache(folder_path: Path) -> None:
        cache = st['folder_caches'].get(str(folder_path), {})
        save_folder_cache(folder_path, cache, index_filename)

    # --- API routes ---

    @app.route('/api/photos')
    def list_photos():
        target = resolve_folder_path(request.args.get('folder', ''))
        cache  = get_folder_cache(target)
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
        favorites_only = request.args.get('favorites_only', 'false') == 'true'

        filter_types    = [t.strip() for t in types_raw.split(',') if t.strip()] if types_raw else []
        filter_size_min = int(size_min) if size_min else None
        filter_size_max = int(size_max) if size_max else None
        filter_w_min    = int(width_min)  if width_min  else None
        filter_w_max    = int(width_max)  if width_max  else None
        filter_h_min    = int(height_min) if height_min else None
        filter_h_max    = int(height_max) if height_max else None
        need_dims       = any(v is not None for v in (filter_w_min, filter_w_max, filter_h_min, filter_h_max))
        date_from_dt    = datetime.fromisoformat(date_from) if date_from else None
        date_to_dt      = datetime.fromisoformat(date_to + 'T23:59:59') if date_to else None

        photos = []
        if target.is_dir():
            for f in target.iterdir():
                if not f.is_file() or f.suffix.lower() not in EXTENSIONS:
                    continue
                if filter_text:
                    name_lower = f.name.lower()
                    invert = filter_text.startswith('!')
                    pattern = filter_text[1:] if invert else filter_text
                    if pattern:
                        if any(c in pattern for c in ('*', '?', '.')):
                            matched = fnmatch.fnmatch(name_lower, pattern)
                        else:
                            matched = pattern in name_lower
                        if invert == matched:
                            continue
                if filter_types and f.suffix.lower() not in filter_types:
                    continue

                stat = f.stat()

                if filter_size_min is not None and stat.st_size < filter_size_min:
                    continue
                if filter_size_max is not None and stat.st_size > filter_size_max:
                    continue

                if need_dims:
                    entry = cache.get(f.name, {})
                    w = entry.get('width')
                    h = entry.get('height')
                    if w is None or h is None:
                        try:
                            with Image.open(f) as im:
                                w, h = im.size
                        except Exception:
                            continue
                    if filter_w_min is not None and w < filter_w_min:
                        continue
                    if filter_w_max is not None and w > filter_w_max:
                        continue
                    if filter_h_min is not None and h < filter_h_min:
                        continue
                    if filter_h_max is not None and h > filter_h_max:
                        continue

                if date_field and (date_from_dt or date_to_dt):
                    entry = cache.get(f.name, {})
                    if date_field == 'created':
                        date_str = entry.get('created') or datetime.fromtimestamp(stat.st_ctime).isoformat()
                    elif date_field == 'modified':
                        date_str = entry.get('modified') or datetime.fromtimestamp(stat.st_mtime).isoformat()
                    elif date_field == 'exif':
                        date_str = entry.get('exif_date')
                        if not date_str:
                            continue
                    else:
                        date_str = None
                    if date_str:
                        try:
                            file_dt = datetime.fromisoformat(date_str)
                            if date_from_dt and file_dt < date_from_dt:
                                continue
                            if date_to_dt and file_dt > date_to_dt:
                                continue
                        except ValueError:
                            continue

                if favorites_only and not cache.get(f.name, {}).get('favorite', False):
                    continue

                cache_entry = cache.get(f.name, {})
                if need_dims:
                    photo_w, photo_h = w, h
                else:
                    photo_w = cache_entry.get('width')
                    photo_h = cache_entry.get('height')

                photos.append({
                    'filename':  f.name,
                    'modified':  datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    'size':      stat.st_size,
                    'size_human': human_size(stat.st_size),
                    'favorite':  cache_entry.get('favorite', False),
                    'width':     photo_w,
                    'height':    photo_h,
                })

        if sort_by == 'modified':
            photos.sort(key=lambda p: p['modified'], reverse=not sort_asc)
        else:
            photos.sort(key=lambda p: p['filename'].lower(), reverse=not sort_asc)

        total = len(photos)
        page = photos[offset:offset + limit]

        return jsonify({'photos': page, 'total': total, 'offset': offset, 'source_folder': str(target), 'source_name': target.name})

    @app.route('/api/photos/<path:filename>/info')
    def photo_info(filename):
        filepath = resolve_folder_path(request.args.get('folder', '')) / filename
        if not filepath.is_file():
            return jsonify({'error': 'not found'}), 404

        stat = filepath.stat()
        try:
            img = Image.open(filepath)
            width, height = img.size
            fmt = img.format or filepath.suffix.upper().lstrip('.')
        except Exception:
            width, height, fmt = 0, 0, filepath.suffix.upper().lstrip('.')

        info = {
            'filename': filename,
            'modified': datetime.fromtimestamp(stat.st_mtime).isoformat(),
            'size': stat.st_size,
            'size_human': human_size(stat.st_size),
            'width': width,
            'height': height,
            'format': fmt,
            'comfyui': extract_comfyui_data(filepath),
            'exif': extract_exif(filepath),
            'png_metadata': extract_png_metadata(filepath),
        }
        return jsonify(info)

    @app.route('/api/photos/<path:rel>')
    def serve_file(rel):
        parts = rel.split('/')

        if parts[0] == '__comfy_output':
            co = st['comfy_output']
            if not co:
                abort(404)
            file_path = Path(co).joinpath(*parts[1:]) if len(parts) > 1 else abort(400)
        else:
            if not allow_dir_change and parts[0] and not parts[0].startswith('__'):
                abort(403, 'not permitted')
            file_path = (root_dir / rel).resolve()
            if not file_path.is_relative_to(root_dir):
                abort(400, 'invalid path')

        if thumbnails_name in parts:
            idx = parts.index(thumbnails_name)
            src_parts = parts[:idx] + parts[idx + 1:]
            if parts[0] == '__comfy_output':
                source = Path(co).joinpath(*src_parts[1:]) if len(src_parts) > 1 else abort(400)
            else:
                source = (root_dir / '/'.join(src_parts)).resolve()
            if not source.is_file():
                abort(404)
            file_path.parent.mkdir(parents=True, exist_ok=True)
            if not file_path.is_file() or file_path.stat().st_mtime < source.stat().st_mtime:
                try:
                    img = Image.open(source)
                    img.thumbnail((300, 300))
                    img.convert('RGB').save(file_path, 'JPEG', quality=80)
                except Exception:
                    return send_file(source, max_age=3600)
            return send_file(file_path, mimetype='image/jpeg', max_age=86400)

        if not file_path.is_file():
            abort(404)
        return send_file(file_path, max_age=3600)

    @app.route('/api/photos/<path:filename>/move', methods=['POST'])
    def move_photo(filename):
        data     = request.get_json()
        src_rel  = data.get('folder', '')
        dest_rel = data.get('destination', '')
        src_dir  = resolve_folder_path(src_rel)
        dest_dir = resolve_folder_path(dest_rel)

        src_path = src_dir / filename
        if not src_path.is_file():
            return jsonify({'error': 'file not found'}), 404

        dest_dir.mkdir(parents=True, exist_ok=True)
        dest_path = dest_dir / filename
        shutil.move(str(src_path), str(dest_path))

        get_folder_cache(src_dir).pop(filename, None)

        undo_stack.append({
            'filename': filename,
            'from': str(src_path),
            'to':   str(dest_path),
        })

        return jsonify({'ok': True, 'action': 'moved', 'filename': filename, 'destination': dest_rel})

    @app.route('/api/undo', methods=['POST'])
    def undo():
        if not undo_stack:
            return jsonify({'ok': False, 'error': 'nothing to undo'}), 400

        entry = undo_stack.pop()
        to_path = Path(entry['to'])
        from_path = Path(entry['from'])

        if to_path.is_file():
            shutil.move(str(to_path), str(from_path))
            return jsonify({
                'ok': True,
                'action': 'undo',
                'filename': entry['filename'],
                'restored_to': str(from_path),
            })
        else:
            return jsonify({'ok': False, 'error': 'file not found in destination'}), 404

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

    @app.route('/api/photos/<path:filename>/describe', methods=['POST'])
    def describe_photo(filename):
        data = request.get_json()
        target = resolve_folder_path(data.get('folder', ''))

        filepath = target / filename
        if not filepath.is_file():
            return jsonify({'error': 'not found'}), 404

        lmstudio_url = data.get('lmstudio_url', 'http://localhost:1234/v1')
        prompt = data.get('prompt', 'Describe this image in detail.')
        model = data.get('model', 'model-identifier')

        mt, _ = mimetypes.guess_type(str(filepath))
        mt = mt or 'image/png'
        with open(filepath, 'rb') as f:
            b64 = base64.b64encode(f.read()).decode('ascii')
        data_url = f"data:{mt};base64,{b64}"

        try:
            resp = http_requests.post(
                f"{lmstudio_url}/chat/completions",
                json={
                    'model': model,
                    'messages': [{
                        'role': 'user',
                        'content': [
                            {'type': 'text', 'text': prompt},
                            {'type': 'image_url', 'image_url': {'url': data_url}},
                        ],
                    }],
                    'temperature': 0.2,
                },
                timeout=120,
            )
            result = resp.json()
            description = result['choices'][0]['message']['content']
            return jsonify({'description': description})
        except Exception as e:
            return jsonify({'error': str(e)}), 502

    @app.route('/api/photos/<path:filename>/write-meta', methods=['POST'])
    def write_meta(filename):
        data = request.get_json()
        description = data.get('description', '')
        key = data.get('key', 'Description')
        target = resolve_folder_path(data.get('folder', ''))

        filepath = target / filename
        if not filepath.is_file():
            return jsonify({'error': 'not found'}), 404

        try:
            img = Image.open(filepath)
            ext = filepath.suffix.lower()

            if ext == '.png':
                info = PngInfo()
                for k, v in img.info.items():
                    if isinstance(v, str):
                        info.add_text(k, v)
                info.add_text(key, description)
                img.save(filepath, pnginfo=info)
            elif ext in ('.jpg', '.jpeg'):
                exif = img.getexif()
                exif[0x010E] = description  # ImageDescription
                img.save(filepath, quality=98, exif=exif.tobytes())
            elif ext == '.webp':
                exif = img.getexif()
                exif[0x010E] = description
                img.save(filepath, quality=98, exif=exif.tobytes())
            else:
                return jsonify({'error': f'Unsupported format: {ext}'}), 400

            return jsonify({'ok': True})
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    @app.route('/api/photos/<path:filename>/locate', methods=['POST'])
    def locate_photo(filename):
        data = request.get_json(silent=True, force=True) or {}
        target = resolve_folder_path(data.get('folder', ''))
        filepath = target / filename
        if not filepath.is_file():
            return jsonify({'error': 'not found'}), 404
        try:
            subprocess.Popen(['explorer', f'/select,{filepath}'])
            return jsonify({'ok': True})
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    @app.route('/api/folders')
    def list_folders():
        folders = []
        for f in sorted(root_dir.rglob('*')):
            if not f.is_dir():
                continue
            rel = f.relative_to(root_dir)
            if any(p.startswith('__') for p in rel.parts):
                continue
            folders.append(str(rel).replace('\\', '/'))
        co = st['comfy_output']
        return jsonify({
            'folders': folders,
            'root_name': root_dir.name,
            'current': None,
            'comfy_output': co or None,
            'comfy_output_name': Path(co).name if co else None,
            'comfy_output_active': False,
            'selected_name': selected_name,
            'dust_name': dust_name,
        })

    @app.route('/api/tools')
    def list_tools():
        return jsonify({'tools': list(tools_cfg.keys())})

    @app.route('/api/tools/run', methods=['POST'])
    def run_tool():
        data     = request.json
        name     = data.get('name', '')
        filename = data.get('filename', '')
        folder   = data.get('folder', '')
        if name not in tools_cfg:
            return jsonify({'ok': False, 'error': 'Unknown tool'}), 400
        dir_path = resolve_folder_path(folder)
        filepath = dir_path / filename
        if not filepath.is_file():
            return jsonify({'ok': False, 'error': 'File not found'}), 404
        quoted = f'"{filepath}"' if sys.platform == 'win32' else shlex.quote(str(filepath))
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
        filenames   = data.get('filenames', [])
        operation   = data.get('operation', 'copy')
        use_comfy   = data.get('use_comfy_output', False)
        destination = data.get('destination', '')
        do_zip      = data.get('zip', False)
        src_folder  = data.get('folder', '')

        src_dir = resolve_folder_path(src_folder)

        if use_comfy:
            co = st['comfy_output']
            if not co:
                return jsonify({'ok': False, 'error': 'comfy_output not configured'}), 400
            dst_dir = Path(co)
        else:
            dst_dir = resolve_folder_path(destination) if destination else root_dir

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
        else:
            for fn, p in resolved:
                try:
                    if operation == 'move':
                        shutil.move(str(p), dst_dir / fn)
                    else:
                        shutil.copy2(p, dst_dir / fn)
                    processed.append(fn)
                except Exception as e:
                    errors.append(str(e))

        return jsonify({'ok': True, 'count': len(processed), 'errors': errors})

    @app.route('/api/photos/<path:filename>/favorite', methods=['POST'])
    def toggle_favorite(filename):
        folder_rel = request.args.get('folder', '')
        dir_path = resolve_folder_path(folder_rel)
        if not (dir_path / filename).is_file():
            return jsonify({'ok': False, 'error': 'not found'}), 404
        cache = get_folder_cache(dir_path)
        entry = cache.setdefault(filename, {})
        entry['favorite'] = not entry.get('favorite', False)
        save_cache(dir_path)
        return jsonify({'ok': True, 'favorite': entry['favorite']})

    @app.route('/api/favorites', methods=['POST'])
    def set_favorites():
        data = request.get_json()
        filenames  = data.get('filenames', [])
        favorite   = data.get('favorite', True)
        folder_rel = data.get('folder', '')
        dir_path = resolve_folder_path(folder_rel)
        cache = get_folder_cache(dir_path)
        for fn in filenames:
            cache.setdefault(fn, {})['favorite'] = favorite
        save_cache(dir_path)
        return jsonify({'ok': True})

    @app.route('/api/favorites/download')
    def download_favorites():
        folder_rel = request.args.get('folder', '')
        dir_path   = resolve_folder_path(folder_rel)
        cache      = get_folder_cache(dir_path)
        fav_files  = [fn for fn, e in cache.items()
                      if e.get('favorite') and (dir_path / fn).is_file()]
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            for fn in fav_files:
                zf.write(dir_path / fn, fn)
        buf.seek(0)
        return send_file(buf, mimetype='application/zip',
                         as_attachment=True, download_name='favorites.zip')

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
        data = request.get_json(silent=True) or {}
        folder_rel = data.get('folder', '')
        target = resolve_folder_path(folder_rel)
        st['folder_caches'].pop(str(target), None)
        threading.Thread(target=build_index, args=(target, st), daemon=True).start()
        return jsonify({'ok': True})

    @app.route('/api/config')
    def api_config():
        return jsonify({
            'comfy_url':       comfy_url,
            'lmstudio_url':    lmstudio_url,
            'comfy_output':    st['comfy_output'],
            'widgets':         {'gpu_monitor': monitor_enabled, 'comfy_queue': comfy_queue_enabled},
            'selected_name':   selected_name,
            'dust_name':       dust_name,
            'thumbnails_name': thumbnails_name,
            'root_name':       root_dir.name,
        })

    @app.route('/api/events')
    def sse_events():
        import uuid as _uuid
        from flask import Response, stream_with_context
        client_id = str(_uuid.uuid4())
        q = queue.Queue(maxsize=8)
        with _sse_lock:
            _sse_clients[client_id] = {'queue': q, 'metrics': True, 'comfy_queue': True}
        def generate():
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
        folder_rel = request.args.get('folder', '')
        target = resolve_folder_path(folder_rel)
        types = set()
        if target.is_dir():
            for f in target.iterdir():
                if f.is_file() and f.suffix.lower() in EXTENSIONS:
                    types.add(f.suffix.lower())
        return jsonify({'types': sorted(types)})

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

    selected_name    = defaults.get('selected_dir_name',  '__selected')
    dust_name        = defaults.get('dust_dir_name',      '__dust')
    thumbnails_name  = defaults.get('thumbnails_dir_name','__thumbnails')
    index_filename   = defaults.get('index_filename',     '__photoparser_index.json')
    port             = defaults.get('port', 1976)
    watch_enabled    = defaults.get('live_updates', True)
    comfy_url        = defaults.get('comfy_url', 'http://127.0.0.1:8188')
    lmstudio_url     = defaults.get('lmstudio_url', 'http://localhost:1234/v1')
    comfy_output     = defaults.get('comfy_output', '')
    widgets              = config.get('widgets', {})
    monitor_enabled      = widgets.get('gpu_monitor', False)
    comfy_queue_enabled  = widgets.get('comfy_queue', False)
    app = create_app(source, config, selected_name, dust_name,
                     index_filename, watch_enabled, comfy_url, lmstudio_url,
                     comfy_output, monitor_enabled, comfy_queue_enabled,
                     thumbnails_name)

    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(('127.0.0.1', port)) == 0:
            print(f"Error: port {port} is already in use")
            sys.exit(1)

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
