import sys
import json
import shutil
import threading
import webbrowser
import base64
import mimetypes
from datetime import datetime
from pathlib import Path

import requests as http_requests
from flask import Flask, jsonify, request, send_from_directory, send_file
from PIL import Image
from PIL.ExifTags import TAGS
from PIL.PngImagePlugin import PngInfo

EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp'}
undo_stack = []


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
        exif_data = img._getexif()
        if exif_data:
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


def create_app(source, selected_dir, dust_dir):
    static_dir = Path(__file__).parent / 'static'
    app = Flask(__name__, static_folder=None)

    def resolve_folder():
        folder = request.args.get('folder', 'source')
        if folder == 'selected':
            return selected_dir
        elif folder == 'dust':
            return dust_dir
        return source

    # --- API routes ---

    @app.route('/api/photos')
    def list_photos():
        target = resolve_folder()
        photos = []
        if target.is_dir():
            for f in sorted(target.iterdir()):
                if f.is_file() and f.suffix.lower() in EXTENSIONS:
                    stat = f.stat()
                    photos.append({
                        'filename': f.name,
                        'modified': datetime.fromtimestamp(stat.st_mtime).isoformat(),
                        'size': stat.st_size,
                        'size_human': human_size(stat.st_size),
                    })
        return jsonify({'photos': photos, 'total': len(photos), 'source_folder': str(target)})

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
        return send_file(filepath)

    @app.route('/api/photos/<path:filename>/move', methods=['POST'])
    def move_photo(filename):
        data = request.get_json()
        dest = data.get('destination')
        if dest not in ('selected', 'dust'):
            return jsonify({'error': 'destination must be "selected" or "dust"'}), 400

        src_path = source / filename
        if not src_path.is_file():
            return jsonify({'error': 'file not found'}), 404

        dest_dir = selected_dir if dest == 'selected' else dust_dir
        dest_path = dest_dir / filename

        shutil.move(str(src_path), str(dest_path))

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
        folder = data.get('folder', 'source')
        if folder == 'selected':
            target = selected_dir
        elif folder == 'dust':
            target = dust_dir
        else:
            target = source

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
        folder = data.get('folder', 'source')
        description = data.get('description', '')
        key = data.get('key', 'Description')

        if folder == 'selected':
            target = selected_dir
        elif folder == 'dust':
            target = dust_dir
        else:
            target = source

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

    selected_dir = source / '__selected'
    dust_dir = source / '__dust'
    selected_dir.mkdir(exist_ok=True)
    dust_dir.mkdir(exist_ok=True)

    app = create_app(source, selected_dir, dust_dir)

    threading.Timer(1.0, webbrowser.open, args=['http://localhost:1976']).start()
    app.run(host='127.0.0.1', port=1976, debug=False)


if __name__ == '__main__':
    main()
