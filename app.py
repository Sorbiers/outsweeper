import sys
import json
import queue
import shutil
import threading
import webbrowser
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
from flask import Flask, jsonify, request, send_from_directory, send_file
from PIL import Image
from PIL.ExifTags import TAGS
from PIL.PngImagePlugin import PngInfo

EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp'}
undo_stack = []

# SSE client registry
_sse_clients: list = []
_sse_lock = threading.Lock()

def _sse_broadcast(msg: str) -> None:
    with _sse_lock:
        for q in list(_sse_clients):
            try:
                q.put_nowait(msg)
            except queue.Full:
                pass


class _SourceWatcher:
    """Watchdog-based file-system watcher that broadcasts SSE events."""
    def __init__(self, source: Path):
        self.source = source

    def _relevant(self, path: str) -> bool:
        try:
            rel = Path(path).relative_to(self.source)
            if any(part.startswith('__') for part in rel.parts):
                return False
            return Path(path).suffix.lower() in EXTENSIONS
        except ValueError:
            return False

    def dispatch(self, event) -> None:
        if event.is_directory:
            return
        src = getattr(event, 'src_path', '')
        dest = getattr(event, 'dest_path', '')
        if self._relevant(src) or (dest and self._relevant(dest)):
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


def build_index(source, st):
    """Scan source folder, build metadata index, update st['index_cache']."""
    new_index = {}
    if source.is_dir():
        for f in source.iterdir():
            if not f.is_file() or f.suffix.lower() not in EXTENSIONS:
                continue
            try:
                stat = f.stat()
                new_index[f.name] = {
                    'created':   datetime.fromtimestamp(stat.st_ctime).isoformat(),
                    'modified':  datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    'exif_date': get_exif_date(f),
                    'size':      stat.st_size,
                    'type':      f.suffix.lower(),
                }
            except Exception:
                pass
    index_path = source / st.get('index_filename', '__photoparser_index.json')
    try:
        with open(index_path, 'w', encoding='utf-8') as fh:
            json.dump(new_index, fh)
    except Exception:
        pass
    st['index_cache'] = new_index


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


def create_app(root_dir, source, config, selected_name, dust_name,
               index_filename='__photoparser_index.json', watch_enabled=False,
               comfy_url='http://127.0.0.1:8188', lmstudio_url='http://localhost:1234/v1'):
    static_dir = Path(__file__).parent / 'static'
    app = Flask(__name__, static_folder=None)
    allow_dir_change = config.get('permissions', {}).get('allow_dir_change', False)

    index_cache = {}
    index_path = source / index_filename
    if index_path.is_file():
        try:
            with open(index_path, encoding='utf-8') as fh:
                index_cache = json.load(fh)
        except Exception:
            pass

    st = {
        'source':         source,
        'selected_dir':   source / selected_name,
        'dust_dir':       source / dust_name,
        'index_cache':    index_cache,
        'index_filename': index_filename,
        'observer':       None,
    }

    def _start_observer(src: Path) -> None:
        obs = st['observer']
        if obs is not None:
            obs.stop()
            obs.join()
            st['observer'] = None
        if watch_enabled:
            from watchdog.observers import Observer
            obs = Observer()
            obs.schedule(_SourceWatcher(src), str(src), recursive=False)
            obs.start()
            st['observer'] = obs

    threading.Thread(target=build_index, args=(source, st), daemon=True).start()
    _start_observer(source)

    def resolve_folder():
        folder = request.args.get('folder', 'source')
        if folder == 'selected':
            return st['selected_dir']
        elif folder == 'dust':
            return st['dust_dir']
        return st['source']

    def resolve_folder_from_name(name):
        if name == 'selected': return st['selected_dir']
        if name == 'dust':     return st['dust_dir']
        return st['source']

    # --- API routes ---

    @app.route('/api/photos')
    def list_photos():
        target = resolve_folder()
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

        filter_types    = [t.strip() for t in types_raw.split(',') if t.strip()] if types_raw else []
        filter_size_min = int(size_min) if size_min else None
        filter_size_max = int(size_max) if size_max else None
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

                if date_field and (date_from_dt or date_to_dt):
                    entry = st['index_cache'].get(f.name, {})
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

                photos.append({
                    'filename':  f.name,
                    'modified':  datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    'size':      stat.st_size,
                    'size_human': human_size(stat.st_size),
                })

        if sort_by == 'modified':
            photos.sort(key=lambda p: p['modified'], reverse=not sort_asc)
        else:
            photos.sort(key=lambda p: p['filename'].lower(), reverse=not sort_asc)

        total = len(photos)
        page = photos[offset:offset + limit]

        return jsonify({'photos': page, 'total': total, 'offset': offset, 'source_folder': str(target), 'source_name': st['source'].name})

    @app.route('/api/photos/<path:filename>/info')
    def photo_info(filename):
        filepath = resolve_folder() / filename
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

    @app.route('/api/photos/<path:filename>/image')
    def serve_image(filename):
        filepath = resolve_folder() / filename
        if not filepath.is_file():
            return jsonify({'error': 'not found'}), 404
        return send_file(filepath)

    @app.route('/api/photos/<path:filename>/thumbnail')
    def serve_thumbnail(filename):
        filepath = resolve_folder() / filename
        if not filepath.is_file():
            return jsonify({'error': 'not found'}), 404

        thumb_dir = st['source'] / '__thumbnails'
        thumb_dir.mkdir(exist_ok=True)
        thumb_path = thumb_dir / (filename + '.jpg')

        if not thumb_path.is_file() or thumb_path.stat().st_mtime < filepath.stat().st_mtime:
            try:
                img = Image.open(filepath)
                img.thumbnail((300, 300))
                img = img.convert('RGB')
                img.save(thumb_path, 'JPEG', quality=80)
            except Exception:
                return send_file(filepath)

        return send_file(thumb_path, mimetype='image/jpeg')

    @app.route('/api/photos/<path:filename>/move', methods=['POST'])
    def move_photo(filename):
        data = request.get_json()
        dest = data.get('destination')
        folder = data.get('folder', 'source')
        if dest not in ('selected', 'dust', 'source'):
            return jsonify({'error': 'invalid destination'}), 400

        if folder == 'selected':
            src_dir = st['selected_dir']
        elif folder == 'dust':
            src_dir = st['dust_dir']
        else:
            src_dir = st['source']

        src_path = src_dir / filename
        if not src_path.is_file():
            return jsonify({'error': 'file not found'}), 404

        if dest == 'selected':
            dest_dir = st['selected_dir']
        elif dest == 'dust':
            dest_dir = st['dust_dir']
        else:
            dest_dir = st['source']

        dest_dir.mkdir(exist_ok=True)
        dest_path = dest_dir / filename

        shutil.move(str(src_path), str(dest_path))
        if folder == 'source':
            st['index_cache'].pop(filename, None)

        undo_stack.append({
            'filename': filename,
            'from': str(src_path),
            'to': str(dest_path),
            'destination': dest,
        })

        return jsonify({
            'ok': True,
            'action': 'moved',
            'filename': filename,
            'destination': dest,
        })

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
        target = resolve_folder_from_name(data.get('folder', 'source'))

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
        target = resolve_folder_from_name(data.get('folder', 'source'))

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

    @app.route('/api/folders')
    def list_folders():
        if not allow_dir_change:
            return jsonify({'error': 'not allowed'}), 403
        folders = []
        for f in sorted(root_dir.rglob('*')):
            if not f.is_dir():
                continue
            rel = f.relative_to(root_dir)
            if any(p.startswith('__') for p in rel.parts):
                continue
            folders.append(str(rel).replace('\\', '/'))
        try:
            current = str(st['source'].relative_to(root_dir)).replace('\\', '/')
            if current == '.':
                current = ''
        except ValueError:
            current = ''
        return jsonify({'folders': folders, 'root_name': root_dir.name, 'current': current})

    @app.route('/api/change-folder', methods=['POST'])
    def change_folder():
        if not allow_dir_change:
            return jsonify({'error': 'not allowed'}), 403
        data = request.get_json()
        rel = data.get('folder', '')
        new_source = (root_dir / rel).resolve() if rel else root_dir
        try:
            new_source.relative_to(root_dir)
        except ValueError:
            return jsonify({'error': 'invalid path'}), 400
        if not new_source.is_dir():
            return jsonify({'error': 'not a directory'}), 400
        st['source']       = new_source
        st['selected_dir'] = new_source / selected_name
        st['dust_dir']     = new_source / dust_name
        st['index_cache']  = {}
        undo_stack.clear()
        threading.Thread(target=build_index, args=(new_source, st), daemon=True).start()
        _start_observer(new_source)
        return jsonify({'ok': True, 'source_name': new_source.name})

    @app.route('/api/refresh', methods=['POST'])
    def refresh():
        st['index_cache'] = {}
        threading.Thread(target=build_index, args=(st['source'], st), daemon=True).start()
        return jsonify({'ok': True})

    @app.route('/api/config')
    def api_config():
        return jsonify({'comfy_url': comfy_url, 'lmstudio_url': lmstudio_url})

    @app.route('/api/events')
    def sse_events():
        from flask import Response, stream_with_context
        def generate(q):
            try:
                while True:
                    try:
                        msg = q.get(timeout=25)
                        yield f'data: {msg}\n\n'
                    except queue.Empty:
                        yield ': heartbeat\n\n'
            finally:
                with _sse_lock:
                    if q in _sse_clients:
                        _sse_clients.remove(q)
        q = queue.Queue(maxsize=8)
        with _sse_lock:
            _sse_clients.append(q)
        return Response(
            stream_with_context(generate(q)),
            mimetype='text/event-stream',
            headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
        )

    @app.route('/api/file-types')
    def file_types():
        types = set()
        if st['source'].is_dir():
            for f in st['source'].iterdir():
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
    if len(sys.argv) < 2:
        print("Usage: python app.py <source_folder>")
        sys.exit(1)

    source = Path(sys.argv[1]).resolve()
    if not source.is_dir():
        print(f"Error: '{source}' is not a valid directory")
        sys.exit(1)

    config = load_config()
    defaults = config.get('defaults', {})
    selected_name  = defaults.get('selected_dir_name', '__selected')
    dust_name      = defaults.get('dust_dir_name',     '__dust')
    index_filename = defaults.get('index_filename',    '__photoparser_index.json')
    port           = defaults.get('port', 1976)
    watch_enabled    = defaults.get('live_updates', True)
    comfy_url        = defaults.get('comfy_url', 'http://127.0.0.1:8188')
    lmstudio_url     = defaults.get('lmstudio_url', 'http://localhost:1234/v1')
    app = create_app(source, source, config, selected_name, dust_name,
                     index_filename, watch_enabled, comfy_url, lmstudio_url)

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
