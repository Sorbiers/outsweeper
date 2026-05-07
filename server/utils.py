from __future__ import annotations

import io
import json
import os
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image, ImageCms
from PIL.ExifTags import GPSTAGS, TAGS
from PIL.PngImagePlugin import PngInfo  # re-exported for factory use  # noqa: F401

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

EXTENSIONS        = {'.png', '.jpg', '.jpeg', '.webp'}
THUMBNAILS_DIR    = '__thumbnails'
THUMBNAIL_SIZE    = (300, 300)
THUMBNAIL_QUALITY = 80

EXIFTOOL_CHECK_TIMEOUT    = 5
EXIFTOOL_RUN_TIMEOUT      = 10
LMS_CHECK_TIMEOUT         = 5
LMS_COMPLETION_TIMEOUT    = 60
VISION_COMPLETION_TIMEOUT = 120
SSE_QUEUE_TIMEOUT         = 25

WATCHER_DEBOUNCE_SECS = 3
WATCHER_COOLDOWN_SECS = 200
WATCHER_POLL_SECS     = 1

LMS_TEXT_TEMPERATURE   = 0.7
LMS_VISION_TEMPERATURE = 0.2

_EXIF_TAG_DATE_ORIGINAL  = 0x9003
_EXIF_TAG_DATE_MODIFY    = 0x0132
_EXIF_TAG_DATE_DIGITIZED = 0x9004
_EXIF_TAG_USER_COMMENT   = 0x9286
_EXIF_TAG_IMAGE_DESC     = 0x010E
_EXIF_IFD_POINTER        = 0x8769
_EXIF_GPS_POINTER        = 0x8825
EXIF_DATETIME_FORMAT     = '%Y:%m:%d %H:%M:%S'

_TAG_RE = re.compile(r'#([A-Za-z0-9_\-]+)')

# ---------------------------------------------------------------------------
# Basic helpers
# ---------------------------------------------------------------------------

def human_size(nbytes: int | float) -> str:
    for unit in ('B', 'KB', 'MB', 'GB'):
        if nbytes < 1024:
            return f'{nbytes:.1f} {unit}'
        nbytes /= 1024
    return f'{nbytes:.1f} TB'


def stat_entry(stat: os.stat_result) -> dict[str, Any]:
    return {'mtime': stat.st_mtime, 'ctime': stat.st_ctime, 'size': stat.st_size}


def mtime_token(mtime: float) -> str:
    return f'{int(mtime):08x}'


# ---------------------------------------------------------------------------
# Cache / index helpers
# ---------------------------------------------------------------------------

def build_index(folder: Path) -> dict:
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
    print(f'[index] {folder} — {len(cache)} files in {elapsed:.1f} ms', flush=True)
    return cache


def ensure_dimensions(folder: Path, name: str, entry: dict) -> None:
    if 'width' in entry:
        return
    try:
        with Image.open(folder / name) as im:
            entry['width'], entry['height'] = im.size
    except Exception:
        entry['width'] = entry['height'] = None


def ensure_exif_date(folder: Path, name: str, entry: dict) -> None:
    if 'exif_date' in entry:
        return
    entry['exif_date'] = get_exif_date(folder / name)


def cleanup_old_thumbnails(roots: list[Path], days: int) -> None:
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
    print(f'[thumbs] cleanup: removed {removed} stale thumbnail(s) older than {days} day(s)', flush=True)


# ---------------------------------------------------------------------------
# EXIF date
# ---------------------------------------------------------------------------

def get_exif_date(filepath: Path) -> str | None:
    try:
        img = Image.open(filepath)
        exif_data = img.getexif()
        for tag_id in (_EXIF_TAG_DATE_ORIGINAL, _EXIF_TAG_DATE_MODIFY, _EXIF_TAG_DATE_DIGITIZED):
            val = exif_data.get(tag_id)
            if val and isinstance(val, str):
                try:
                    return datetime.strptime(val, EXIF_DATETIME_FORMAT).isoformat()
                except ValueError:
                    pass
    except Exception:
        pass
    return None


# ---------------------------------------------------------------------------
# ComfyUI workflow extraction
# ---------------------------------------------------------------------------

def extract_comfyui_data(prompt: str) -> dict[str, Any]:
    result: dict[str, Any] = {'found': False}
    try:
        prompt = json.loads(prompt)
        result['found'] = True
        model = None
        loras = []
        positive_prompt = None
        negative_prompt = None
        steps = cfg = seed = sampler = scheduler = batch_size = None

        for node in prompt.values():
            inputs     = node.get('inputs', {})
            class_type = node.get('class_type', '')
            if 'ckpt_name' in inputs:
                model = inputs['ckpt_name']
            if 'lora_name' in inputs:
                loras.append({
                    'name':           inputs['lora_name'],
                    'strength_model': inputs.get('strength_model', 1.0),
                    'strength_clip':  inputs.get('strength_clip',  1.0),
                })
            if 'steps' in inputs and 'cfg' in inputs:
                steps     = inputs.get('steps')
                cfg       = inputs.get('cfg')
                seed      = inputs.get('seed')
                sampler   = inputs.get('sampler_name')
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
            'model': model, 'loras': loras,
            'prompt': positive_prompt, 'negative_prompt': negative_prompt,
            'steps': steps, 'cfg': cfg, 'seed': seed,
            'sampler': sampler, 'scheduler': scheduler, 'batch_size': batch_size,
        })
    except Exception as e:
        result['error'] = str(e)
    return result


# ---------------------------------------------------------------------------
# EXIF extraction
# ---------------------------------------------------------------------------

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


def extract_exif(filepath: Path) -> dict[str, str]:
    result: dict[str, str] = {}

    def _add(ifd) -> None:
        for tag_id, value in ifd.items():
            s = str(value)
            tag_name = TAGS.get(tag_id, str(tag_id))
            if s.startswith(("b'ASCII", "b'UNICODE", "b'JIS")):
                result[str(tag_name)] = extract_exif_text(value)
                continue
            if s.startswith(("b'", 'b"')):
                continue
            result[str(tag_name)] = s

    try:
        img       = Image.open(filepath)
        exif_data = img.getexif()
        _add(exif_data)
        _add(exif_data.get_ifd(_EXIF_IFD_POINTER))
    except Exception:
        pass
    return result


def _rationals_to_decimal(dms: tuple, ref: str) -> float | None:
    try:
        deg, mn, sec = (float(x) for x in dms)
        val = deg + mn / 60 + sec / 3600
        if ref in ('S', 'W'):
            val = -val
        return round(val, 6)
    except Exception:
        return None


def extract_gps(filepath: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    try:
        img = Image.open(filepath)
        gps = img.getexif().get_ifd(_EXIF_GPS_POINTER)
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


def _user_comment_text(filepath: Path) -> str:
    try:
        ifd = Image.open(filepath).getexif().get_ifd(_EXIF_IFD_POINTER)
        v   = ifd.get(_EXIF_TAG_USER_COMMENT)
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


def extract_tags_from_comment(text: str) -> set[str]:
    if not text:
        return set()
    return {m.lower() for m in _TAG_RE.findall(text)}


def extract_icc(filepath: Path) -> dict[str, Any]:
    result: dict[str, Any] = {}
    try:
        img = Image.open(filepath)
        icc = img.info.get('icc_profile')
        if not icc:
            return result
        profile = ImageCms.getOpenProfile(io.BytesIO(icc))
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
        result = {k: v for k, v in result.items() if v}
    except Exception:
        pass
    return result


def extract_png_metadata(filepath: Path) -> dict[str, str]:
    result: dict[str, str] = {}
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
