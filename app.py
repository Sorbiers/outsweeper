from __future__ import annotations

import socket
import sys
import threading
import webbrowser
from pathlib import Path
from typing import Any

try:
    import tomllib
except ImportError:
    import tomli as tomllib  # type: ignore[no-redef]

from server import create_app


def load_config() -> dict[str, Any]:
    config_path = Path(__file__).parent / 'config.toml'
    if config_path.is_file():
        with open(config_path, 'rb') as f:
            return tomllib.load(f)
    return {}


def main() -> None:
    config   = load_config()
    defaults = config.get('defaults', {})

    if len(sys.argv) >= 2:
        source = Path(sys.argv[1]).resolve()
        if not source.is_dir():
            print(f"Error: '{source}' is not a valid directory")
            sys.exit(1)
    else:
        co = defaults.get('comfy_output', '')
        if not co:
            print('Usage: python app.py <source_folder>')
            sys.exit(1)
        source = Path(co).resolve()
        if not source.is_dir():
            print(f"Error: comfy_output '{source}' is not a valid directory")
            sys.exit(1)

    selected_name        = defaults.get('selected_dir_name', '__selected')
    dust_name            = defaults.get('dust_dir_name', '__dust')
    port                 = defaults.get('port', 1976)
    comfy_url            = defaults.get('comfy_url', 'http://127.0.0.1:8188')
    lmstudio_url         = defaults.get('lmstudio_url', 'http://localhost:1234/v1')
    comfy_output         = defaults.get('comfy_output', '')
    raw_interval         = defaults.get('index_validation_interval')
    validation_interval  = None if raw_interval is None else int(raw_interval)
    thumb_cache_days     = defaults.get('thumb_cache_days', 3)
    exiftool_path        = defaults.get('exiftool_path', 'exiftool')
    run_comfy_command    = defaults.get('run_comfy_command', '')
    run_lmstudio_command = defaults.get('run_lmstudio_command', '')
    widgets              = config.get('widgets', {})
    monitor_enabled      = widgets.get('gpu_monitor', False)
    comfy_queue_enabled  = widgets.get('comfy_queue', False)

    app = create_app(
        source, config, selected_name, dust_name,
        comfy_url, lmstudio_url, comfy_output,
        monitor_enabled, comfy_queue_enabled,
        validation_interval, thumb_cache_days,
        exiftool_path, run_comfy_command, run_lmstudio_command,
    )

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if s.connect_ex(('127.0.0.1', port)) == 0:
            print(f'Error: port {port} is already in use')
            sys.exit(1)

    threading.Timer(1.0, webbrowser.open, args=[f'http://localhost:{port}']).start()
    app.run(host='127.0.0.1', port=port, debug=False, threaded=True)


if __name__ == '__main__':
    main()
