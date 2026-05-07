from __future__ import annotations

import json
import subprocess
from typing import Any

from .state import AppState
from .utils import EXIFTOOL_CHECK_TIMEOUT, EXIFTOOL_RUN_TIMEOUT

EDIT_TAG_MAP = {
    'image_title':   'EXIF:ImageTitle',
    'artist':        'EXIF:Artist',
    'description':   'EXIF:ImageDescription',
    'document_name': 'EXIF:DocumentName',
    'copyright':     'EXIF:Copyright',
    'user_comment':  'EXIF:UserComment',
}

STRIP_GROUP_MAP = {
    'all':       ['-all='],
    'sensitive': ['-GPS:all=', '-EXIF:SerialNumber=', '-EXIF:LensSerialNumber=',
                  '-EXIF:OwnerName=', '-XMP:CreatorTool=', '-EXIF:Software='],
    'icc':       ['-icc_profile:all='],
    'exif':      ['-EXIF:all='],
    'gps':       ['-GPS:all='],
}


def exiftool_capabilities(state: AppState) -> dict[str, Any]:
    path = state.exiftool_path
    try:
        proc = subprocess.run(
            [path, '-ver'], capture_output=True, text=True, timeout=EXIFTOOL_CHECK_TIMEOUT,
        )
        if proc.returncode == 0:
            return {'available': True, 'version': proc.stdout.strip(), 'executable': path, 'error': None}
        return {
            'available': False, 'version': None, 'executable': path,
            'error': proc.stderr.strip() or f'exit {proc.returncode}',
        }
    except FileNotFoundError:
        return {'available': False, 'version': None, 'executable': path,
                'error': 'exiftool binary not found'}
    except Exception as e:
        return {'available': False, 'version': None, 'executable': path, 'error': str(e)}


def exiftool_run(
    state: AppState,
    args: list[str],
    *,
    parse_json: bool = False,
    timeout: int = EXIFTOOL_RUN_TIMEOUT,
) -> list | str:
    path = state.exiftool_path
    proc = subprocess.run([path, *args], capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f'exiftool exit {proc.returncode}')
    if parse_json:
        return json.loads(proc.stdout) if proc.stdout.strip() else []
    return proc.stdout


def validate_ascii_fields(fields: dict[str, str]) -> str | None:
    for k, v in fields.items():
        if v is None or v == '':
            continue
        if not isinstance(v, str):
            return f'field {k} must be a string'
        if not all(0x20 <= ord(c) <= 0x7E for c in v):
            return f'field {k} contains non-ASCII characters'
    return None


def build_edit_args(fields: dict[str, str]) -> list[str]:
    args = []
    for field, value in fields.items():
        if field not in EDIT_TAG_MAP:
            raise ValueError(f'unknown field: {field}')
        if value is None or value == '':
            continue
        tag = EDIT_TAG_MAP[field]
        args.append(f'-{tag}={value}')
    return args
