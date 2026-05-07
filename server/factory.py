from __future__ import annotations

import base64
import fnmatch
import io
import mimetypes
import queue
import shlex
import shutil
import subprocess
import sys
import threading
import time
import uuid as _uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests as http_requests
from flask import Flask, Response, abort, g, jsonify, request, send_file, send_from_directory, stream_with_context
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from .background import _comfy_queue_loop, _comfy_ws_loop, _metrics_loop
from .events import _SSE_CLIENTS, _SSE_LOCK, _sse_broadcast
from .exiftool import (
    EDIT_TAG_MAP,
    STRIP_GROUP_MAP,
    build_edit_args,
    exiftool_capabilities,
    exiftool_run,
    validate_ascii_fields,
)
from .state import AppState
from .utils import (
    EXTENSIONS,
    LMS_CHECK_TIMEOUT,
    LMS_COMPLETION_TIMEOUT,
    LMS_TEXT_TEMPERATURE,
    LMS_VISION_TEMPERATURE,
    SSE_QUEUE_TIMEOUT,
    THUMBNAILS_DIR,
    THUMBNAIL_QUALITY,
    THUMBNAIL_SIZE,
    VISION_COMPLETION_TIMEOUT,
    _EXIF_TAG_IMAGE_DESC,
    _user_comment_text,
    build_index,
    cleanup_old_thumbnails,
    ensure_dimensions,
    ensure_exif_date,
    extract_comfyui_data,
    extract_exif,
    extract_gps,
    extract_icc,
    extract_png_metadata,
    extract_tags_from_comment,
    human_size,
    mtime_token,
    stat_entry,
)
from .watcher import start_watcher


def create_app(
    root_dir: str | Path,
    config: dict[str, Any],
    selected_name: str,
    dust_name: str,
    comfy_url: str = 'http://127.0.0.1:8188',
    lmstudio_url: str = 'http://localhost:1234/v1',
    comfy_output: str = '',
    monitor_enabled: bool = False,
    comfy_queue_enabled: bool = False,
    validation_interval: int | None = None,
    thumb_cache_days: int = 3,
    exiftool_path: str = 'exiftool',
    run_comfy_command: str = '',
    run_lmstudio_command: str = '',
) -> Flask:
    static_dir = Path(__file__).parent.parent / 'static'
    root_dir = Path(root_dir)
    root_resolved = root_dir.resolve()
    co_resolved = Path(comfy_output).resolve() if comfy_output else None

    state = AppState(
        root_dir=root_dir,
        root_resolved=root_resolved,
        selected_name=selected_name,
        dust_name=dust_name,
        config=config,
        comfy_url=comfy_url,
        lmstudio_url=lmstudio_url,
        co_resolved=co_resolved,
        exiftool_path=exiftool_path,
        thumb_cache_days=thumb_cache_days,
        run_comfy_command=run_comfy_command,
        run_lmstudio_command=run_lmstudio_command,
        monitor_enabled=monitor_enabled,
        comfy_queue_enabled=comfy_queue_enabled,
        tools_cfg=config.get('tools', {}),
        validation_interval=validation_interval,
        comfy_output_str=str(co_resolved) if co_resolved else '',
    )

    app = Flask(__name__, static_folder=None)

    @app.errorhandler(400)
    @app.errorhandler(403)
    @app.errorhandler(404)
    def json_http_error(e):
        return jsonify({'error': getattr(e, 'description', str(e))}), e.code

    @app.before_request
    def log_request():
        if config.get('defaults', {}).get('debug') is not True:
            return
        g.request_id = str(_uuid.uuid4())[:8]
        g.start_time = time.perf_counter()
        print(f'[{g.request_id}] --> {request.method} {request.path}')

    @app.after_request
    def log_response(response):
        if config.get('defaults', {}).get('debug') is not True:
            return response
        elapsed = (time.perf_counter() - g.start_time) * 1000
        print(f'[{g.request_id}] <-- {response.status} {elapsed:.1f}ms')
        return response

    start_watcher(state)
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

    # --- Shared helpers ---

    def resolve_path(rel: str) -> Path:
        rel = (rel or '').strip().lstrip('/')
        if rel.startswith('%comfy_output%'):
            if not state.co_resolved:
                abort(404, 'ComfyUI output not configured')
            suffix = rel[len('%comfy_output%'):].lstrip('/')
            target = (state.co_resolved / suffix).resolve() if suffix else state.co_resolved
            if not target.is_relative_to(state.co_resolved):
                abort(400, 'invalid path')
            return target
        target = (root_resolved / rel).resolve() if rel else root_resolved
        if not target.is_relative_to(root_resolved):
            abort(400, 'invalid path')
        return target

    def get_folder_cache(folder_path: Path) -> dict:
        key = str(folder_path.resolve())
        if key not in state.folder_caches:
            state.folder_caches[key] = build_index(folder_path)
        return state.folder_caches[key]

    def cache_for(folder_path: Path) -> dict | None:
        return state.folder_caches.get(str(folder_path.resolve()))

    def _ensure_tag_index(folder: Path) -> dict:
        key = str(folder.resolve())
        idx = state.tag_index.get(key)
        if idx is None:
            t0 = time.perf_counter()
            idx = {}
            try:
                for f in folder.iterdir():
                    if f.is_file() and f.suffix.lower() in EXTENSIONS and not f.name.startswith(('.', '_')):
                        idx[f.name] = frozenset(extract_tags_from_comment(_user_comment_text(f)))
            except Exception:
                pass
            state.tag_index[key] = idx
            elapsed = (time.perf_counter() - t0) * 1000
            print(f'[tag_index] built for {folder} ({len(idx)} files) in {elapsed:.1f} ms', flush=True)
        return idx

    def _invalidate_cache(file_path: Path) -> None:
        cache = cache_for(file_path.parent)
        if cache is not None:
            try:
                entry = cache.get(file_path.name) or {}
                entry.update(stat_entry(file_path.stat()))
                entry.pop('exif_date', None)
                cache[file_path.name] = entry
            except Exception:
                pass
        folder_key = str(file_path.parent.resolve())
        if folder_key in state.tag_index:
            state.tag_index[folder_key].pop(file_path.name, None)

    # --- Routes ---

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
        filter_tags     = {t.lstrip('#').lower() for t in tags_raw.split(',') if t.strip()} if tags_raw else set()
        need_dims       = any(v is not None for v in (filter_w_min, filter_w_max, filter_h_min, filter_h_max))
        date_from_dt    = datetime.fromisoformat(date_from) if date_from else None
        date_to_dt      = datetime.fromisoformat(date_to + 'T23:59:59') if date_to else None

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
        file_path = resolve_path(request.args.get('path', ''))
        if not file_path.is_file():
            return jsonify({'error': 'Not found'}), 404
        resp = send_file(file_path, max_age=31536000)
        resp.headers['Cache-Control'] = 'public, max-age=31536000, immutable'
        return resp

    @app.route('/api/thumbnail')
    def serve_thumbnail():
        img_path = resolve_path(request.args.get('path', ''))
        if not img_path.is_file():
            return jsonify({'error': 'Not found'}), 404
        tok        = mtime_token(img_path.stat().st_mtime)
        thumb_path = img_path.parent / THUMBNAILS_DIR / f'{img_path.name}.{tok}.jpg'
        if not thumb_path.is_file():
            thumb_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                img = Image.open(img_path)
                img.thumbnail(THUMBNAIL_SIZE)
                img.convert('RGB').save(thumb_path, 'JPEG', quality=THUMBNAIL_QUALITY)
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
        params       = config.get('parameters', {})
        exif_data    = extract_exif(file_path) if params.get('extract_exif', True) else {}
        png_metadata = extract_png_metadata(file_path) if params.get('extract_png', False) else None
        comfyui      = extract_comfyui_data(png_metadata['prompt']) if png_metadata and png_metadata.get('prompt') else None
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
            'gps':            extract_gps(file_path) if params.get('extract_gps', False) else None,
            'icc':            extract_icc(file_path) if params.get('extract_icc', False) else None,
            'png_metadata':   png_metadata,
            'tags':           ', '.join(extract_tags_from_comment(exif_data.get('UserComment'))) if exif_data.get('UserComment') else '',
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
        with state.undo_lock:
            state.undo_stack.append({'filename': src_path.name, 'from': str(src_path), 'to': str(dest_path)})
        return jsonify({'ok': True, 'filename': src_path.name})

    @app.route('/api/undo', methods=['POST'])
    def undo():
        with state.undo_lock:
            if not state.undo_stack:
                return jsonify({'ok': False, 'error': 'nothing to undo'}), 400
            entry = state.undo_stack.pop()
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
        cu = data.get('comfy_url', 'http://127.0.0.1:8188')
        try:
            http_requests.post(f'{cu}/free', json={'unload_models': True, 'free_memory': True}, timeout=5)
        except Exception:
            pass
        return jsonify({'ok': True})

    @app.route('/api/comfy/check', methods=['POST'])
    def comfy_check():
        data = request.get_json()
        cu = data.get('comfy_url', 'http://127.0.0.1:8188')
        try:
            resp = http_requests.get(f'{cu}/system_stats', timeout=5)
            return jsonify(resp.json()), resp.status_code
        except Exception as e:
            return jsonify({'error': str(e)}), 502

    @app.route('/api/comfy/loras', methods=['POST'])
    def comfy_loras():
        data = request.get_json()
        cu = data.get('comfy_url', 'http://127.0.0.1:8188')
        try:
            resp = http_requests.get(f'{cu}/object_info', timeout=10)
            info = resp.json()
            loras = info.get('LoraLoader', {}).get('input', {}).get('required', {}).get('lora_name', [[]])[0]
            return jsonify({'loras': loras})
        except Exception as e:
            return jsonify({'error': str(e)}), 502

    @app.route('/api/comfy/checkpoints', methods=['POST'])
    def comfy_checkpoints():
        data = request.get_json()
        cu = data.get('comfy_url', 'http://127.0.0.1:8188')
        try:
            resp = http_requests.get(f'{cu}/object_info', timeout=10)
            info = resp.json()
            checkpoints = info.get('CheckpointLoaderSimple', {}).get('input', {}).get('required', {}).get('ckpt_name', [[]])[0]
            return jsonify({'checkpoints': checkpoints})
        except Exception as e:
            return jsonify({'error': str(e)}), 502

    @app.route('/api/comfy/samplers', methods=['POST'])
    def comfy_samplers():
        data = request.get_json()
        cu = data.get('comfy_url', 'http://127.0.0.1:8188')
        try:
            resp = http_requests.get(f'{cu}/object_info/KSampler', timeout=10)
            info = resp.json().get('KSampler', {}).get('input', {}).get('required', {})
            samplers   = info.get('sampler_name', [[]])[0]
            schedulers = info.get('scheduler', [[]])[0]
            return jsonify({'samplers': samplers, 'schedulers': schedulers})
        except Exception as e:
            return jsonify({'error': str(e)}), 502

    @app.route('/api/comfy/prompt', methods=['POST'])
    def comfy_prompt():
        data = request.get_json()
        cu = data.get('comfy_url', 'http://127.0.0.1:8188')
        prompt = data.get('prompt')
        if not prompt:
            return jsonify({'error': 'no prompt data'}), 400
        try:
            resp = http_requests.post(f'{cu}/prompt', json={'prompt': prompt}, timeout=10)
            return jsonify(resp.json()), resp.status_code
        except Exception as e:
            return jsonify({'error': str(e)}), 502

    @app.route('/api/lmstudio/unload', methods=['POST'])
    def lmstudio_unload():
        data = request.get_json()
        lms_url = data.get('lmstudio_url', 'http://localhost:1234/v1')
        parsed = urlparse(lms_url)
        base = f'{parsed.scheme}://{parsed.netloc}'
        try:
            resp = http_requests.get(f'{base}/api/v1/models', timeout=LMS_CHECK_TIMEOUT)
            models = resp.json().get('models', [])
            for model in models:
                for instance in model.get('loaded_instances', []):
                    instance_id = instance.get('id')
                    if instance_id:
                        http_requests.post(
                            f'{base}/api/v1/models/unload',
                            json={'instance_id': instance_id},
                            timeout=LMS_CHECK_TIMEOUT,
                        )
        except Exception:
            pass
        return jsonify({'ok': True})

    @app.route('/api/lmstudio/check', methods=['POST'])
    def lmstudio_check():
        data = request.get_json()
        lms_url = data.get('lmstudio_url', 'http://localhost:1234/v1')
        try:
            resp = http_requests.get(f'{lms_url}/models', timeout=LMS_CHECK_TIMEOUT)
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
                f'{lms_url}/chat/completions',
                json={'model': model, 'messages': [{'role': 'user', 'content': prompt}],
                      'temperature': LMS_TEXT_TEMPERATURE},
                timeout=LMS_COMPLETION_TIMEOUT,
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
                f'{lms_url}/chat/completions',
                json={'model': model, 'messages': [{'role': 'user', 'content': [
                    {'type': 'text', 'text': prompt},
                    {'type': 'image_url', 'image_url': {'url': f'data:{mt};base64,{b64}'}},
                ]}], 'temperature': LMS_VISION_TEMPERATURE},
                timeout=VISION_COMPLETION_TIMEOUT,
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
                exif[_EXIF_TAG_IMAGE_DESC] = description
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
    def api_exiftool_capabilities():
        return jsonify(exiftool_capabilities(state))

    @app.route('/api/exiftool/metadata', methods=['GET'])
    def api_exiftool_metadata():
        file_path = resolve_path(request.args.get('path', ''))
        if not file_path.is_file():
            return jsonify({'error': 'not found'}), 404
        caps = exiftool_capabilities(state)
        if not caps['available']:
            return jsonify({'error': caps.get('error') or 'exiftool unavailable'}), 503
        try:
            data = exiftool_run(state, ['-j', '-G1', '-a', '-s', str(file_path)], parse_json=True)
            if not data:
                return jsonify({})
            obj = data[0]
            obj.pop('SourceFile', None)
            return jsonify(obj)
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    @app.route('/api/exiftool/edit', methods=['POST'])
    def api_exiftool_edit():
        file_path = resolve_path(request.args.get('path', ''))
        if not file_path.is_file():
            return jsonify({'error': 'not found'}), 404
        caps = exiftool_capabilities(state)
        if not caps['available']:
            return jsonify({'error': caps.get('error') or 'exiftool unavailable'}), 503
        body   = request.get_json(silent=True) or {}
        fields = body.get('fields') or {}
        if not isinstance(fields, dict):
            return jsonify({'error': 'fields must be an object'}), 400
        err = validate_ascii_fields(fields)
        if err:
            return jsonify({'error': err}), 400
        try:
            tag_args = build_edit_args(fields)
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        if not tag_args:
            return jsonify({'ok': True})
        try:
            exiftool_run(state, ['-overwrite_original', *tag_args, str(file_path)])
            _invalidate_cache(file_path)
            return jsonify({'ok': True})
        except Exception as e:
            return jsonify({'error': str(e)}), 500

    @app.route('/api/exiftool/edit-batch', methods=['POST'])
    def api_exiftool_edit_batch():
        caps = exiftool_capabilities(state)
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
        err = validate_ascii_fields(fields)
        if err:
            return jsonify({'error': err}), 400
        try:
            tag_args = build_edit_args(fields)
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
                exiftool_run(state, ['-overwrite_original', *tag_args, str(p)])
                _invalidate_cache(p)
                succeeded.append(str(p))
            except Exception as e:
                errors.append({'path': str(name), 'error': str(e)})
        return jsonify({'ok': not errors, 'count': len(succeeded),
                        'succeeded': succeeded, 'errors': errors})

    @app.route('/api/exiftool/strip', methods=['POST'])
    def api_exiftool_strip():
        file_path = resolve_path(request.args.get('path', ''))
        if not file_path.is_file():
            return jsonify({'error': 'not found'}), 404
        caps = exiftool_capabilities(state)
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
            for grp in groups:
                if grp not in STRIP_GROUP_MAP:
                    return jsonify({'error': f'unknown group: {grp}'}), 400
                flags += STRIP_GROUP_MAP[grp]
        flags.append(str(file_path))
        try:
            exiftool_run(state, flags)
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
            for f in sorted(state.root_dir.rglob('*')):
                if not f.is_dir():
                    continue
                rel = f.relative_to(state.root_dir)
                if any(p.startswith('_') for p in rel.parts):
                    continue
                folders.append(str(rel).replace('\\', '/'))
        except Exception:
            pass
        co = state.comfy_output_str
        return jsonify({
            'folders':           folders,
            'root_name':         state.root_dir.name,
            'comfy_output':      co or None,
            'comfy_output_name': Path(co).name if co else None,
            'selected_name':     state.selected_name,
            'dust_name':         state.dust_name,
        })

    @app.route('/api/tools')
    def list_tools():
        return jsonify({'tools': list(state.tools_cfg.keys())})

    @app.route('/api/tools/run', methods=['POST'])
    def run_tool():
        name      = request.json.get('name', '')
        file_path = resolve_path(request.args.get('path', ''))
        if name not in state.tools_cfg:
            return jsonify({'ok': False, 'error': 'Unknown tool'}), 400
        if not file_path.is_file():
            return jsonify({'ok': False, 'error': 'File not found'}), 404
        quoted = f'"{file_path}"' if sys.platform == 'win32' else shlex.quote(str(file_path))
        cmd = state.tools_cfg[name].replace('%filename%', quoted)
        try:
            result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
            return jsonify({
                'ok':         result.returncode == 0,
                'stdout':     result.stdout,
                'stderr':     result.stderr,
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
            co = state.comfy_output_str
            if not co:
                return jsonify({'ok': False, 'error': 'comfy_output not configured'}), 400
            dst_dir = Path(co)
        else:
            dst_dir = resolve_path(destination) if destination else state.root_dir

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
        paused    = request.json.get('paused', True)
        with _SSE_LOCK:
            if client_id in _SSE_CLIENTS:
                _SSE_CLIENTS[client_id]['metrics'] = not paused
        return jsonify({'ok': True})

    @app.route('/api/comfy-queue/pause', methods=['POST'])
    def comfy_queue_pause():
        client_id = request.json.get('client_id', '')
        paused    = request.json.get('paused', True)
        with _SSE_LOCK:
            if client_id in _SSE_CLIENTS:
                _SSE_CLIENTS[client_id]['comfy_queue'] = not paused
        return jsonify({'ok': True})

    @app.route('/api/refresh', methods=['POST'])
    def refresh():
        target = resolve_path(request.args.get('path', ''))
        state.folder_caches[str(target.resolve())] = build_index(target)
        return jsonify({'ok': True})

    @app.route('/api/config')
    def api_config():
        return jsonify({
            'comfy_url':               state.comfy_url,
            'lmstudio_url':            state.lmstudio_url,
            'widgets':                 {'gpu_monitor': state.monitor_enabled, 'comfy_queue': state.comfy_queue_enabled},
            'selected_name':           state.selected_name,
            'dust_name':               state.dust_name,
            'thumbnails_name':         THUMBNAILS_DIR,
            'root_name':               state.root_dir.name,
            'has_run_comfy_command':   bool(state.run_comfy_command),
            'has_run_lmstudio_command': bool(state.run_lmstudio_command),
        })

    @app.route('/api/run-command', methods=['POST'])
    def run_command():
        data    = request.get_json() or {}
        service = data.get('service')
        if service == 'comfy':
            cmd = state.run_comfy_command
        elif service == 'lmstudio':
            cmd = state.run_lmstudio_command
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
        client_id = str(_uuid.uuid4())
        q = queue.Queue(maxsize=8)

        def generate():
            with _SSE_LOCK:
                _SSE_CLIENTS[client_id] = {'queue': q, 'metrics': True, 'comfy_queue': True}
            try:
                yield f'data: client_id:{client_id}\n\n'
                while True:
                    try:
                        msg = q.get(timeout=SSE_QUEUE_TIMEOUT)
                        yield f'data: {msg}\n\n'
                    except queue.Empty:
                        yield ': heartbeat\n\n'
            finally:
                with _SSE_LOCK:
                    _SSE_CLIENTS.pop(client_id, None)

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
