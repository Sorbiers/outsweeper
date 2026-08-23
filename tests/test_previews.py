"""
Tests for step-preview capture (server/previews.py).

Run:
    pytest tests/test_previews.py -v

Pure byte parsing and image assembly — no ComfyUI, no GPU.
"""

import json
import struct
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from server.previews import (
    EVENT_PREVIEW_IMAGE,
    EVENT_PREVIEW_IMAGE_WITH_METADATA,
    MAX_FRAMES,
    PreviewStore,
    parse_preview_frame,
    write_step_animation,
    write_step_sheet,
)


def _jpeg(size=(64, 48), color=(200, 60, 60)) -> bytes:
    buf = BytesIO()
    Image.new('RGB', size, color).save(buf, format='JPEG')
    return buf.getvalue()


def _legacy_frame(payload: bytes, type_num: int = 1) -> bytes:
    """The frame ComfyUI sends when no feature flag was negotiated."""
    return struct.pack('>I', EVENT_PREVIEW_IMAGE) + struct.pack('>I', type_num) + payload


def _metadata_frame(payload: bytes, meta: dict) -> bytes:
    raw = json.dumps(meta).encode('utf-8')
    return (struct.pack('>I', EVENT_PREVIEW_IMAGE_WITH_METADATA)
            + struct.pack('>I', len(raw)) + raw + payload)


class TestParseFrame:

    def test_legacy_jpeg(self):
        blob = _jpeg()
        assert parse_preview_frame(_legacy_frame(blob)) == ('image/jpeg', blob)

    def test_legacy_png(self):
        blob = b'\x89PNG fake'
        assert parse_preview_frame(_legacy_frame(blob, type_num=2)) == ('image/png', blob)

    def test_metadata_frame(self):
        """Not negotiated, but decoding it keeps previews working if that changes."""
        blob = _jpeg()
        frame = _metadata_frame(blob, {'image_type': 'image/jpeg', 'prompt_id': 'abc'})
        assert parse_preview_frame(frame) == ('image/jpeg', blob)

    @pytest.mark.parametrize('data', [
        b'',
        b'\x00\x00',
        struct.pack('>I', EVENT_PREVIEW_IMAGE),                       # header only
        struct.pack('>I', 3) + struct.pack('>I', 1) + b'text event',  # not a preview
        _legacy_frame(b'', type_num=1),                               # no payload
        _legacy_frame(b'x', type_num=99),                             # unknown image type
    ])
    def test_rejects_junk(self, data):
        assert parse_preview_frame(data) is None

    def test_truncated_metadata_length(self):
        bad = (struct.pack('>I', EVENT_PREVIEW_IMAGE_WITH_METADATA)
               + struct.pack('>I', 999) + b'{}')
        assert parse_preview_frame(bad) is None


class TestPreviewStore:

    def test_latest_tracks_newest_frame(self):
        s = PreviewStore()
        assert s.latest() is None
        s.add_frame('image/jpeg', b'one')
        s.add_frame('image/jpeg', b'two')
        assert s.latest() == ('image/jpeg', b'two')

    def test_latest_goes_stale(self):
        s = PreviewStore()
        s.add_frame('image/jpeg', b'one')
        assert s.latest(max_age=1000) is not None
        assert s.latest(max_age=-1) is None

    def test_records_only_the_armed_prompt(self):
        s = PreviewStore()
        s.start_recording('p1')

        s.note_progress('p1', 1)
        s.add_frame('image/jpeg', b'a')
        s.note_progress('p2', 1)          # a different prompt, not armed
        s.add_frame('image/jpeg', b'b')
        s.note_progress('p1', 2)
        s.add_frame('image/jpeg', b'c')

        assert s.take_recording('p1') == [b'a', b'c']
        assert s.take_recording('p2') == []

    def test_take_is_destructive(self):
        s = PreviewStore()
        s.start_recording('p1')
        s.note_progress('p1', 1)
        s.add_frame('image/jpeg', b'a')
        assert s.take_recording('p1') == [b'a']
        assert s.take_recording('p1') == []

    def test_unarmed_prompt_records_nothing(self):
        s = PreviewStore()
        s.note_progress('p1', 1)
        s.add_frame('image/jpeg', b'a')
        assert s.take_recording('p1') == []

    def test_frame_cap_is_enforced(self):
        s = PreviewStore()
        s.start_recording('p1')
        s.note_progress('p1', 1)
        for _ in range(MAX_FRAMES + 25):
            s.add_frame('image/jpeg', b'x')
        assert len(s.take_recording('p1')) == MAX_FRAMES

    def test_discard_drops_a_recording(self):
        s = PreviewStore()
        s.start_recording('p1')
        s.note_progress('p1', 1)
        s.add_frame('image/jpeg', b'a')
        s.discard_recording('p1')
        assert s.take_recording('p1') == []


class TestWriters:

    def test_sheet_has_a_cell_per_frame(self, tmp_path: Path):
        frames = [_jpeg(color=(i * 20, 60, 60)) for i in range(7)]
        out = write_step_sheet(frames, tmp_path / 'a_steps.jpg')
        assert out and out.is_file()
        with Image.open(out) as im:
            # 7 frames at 5 columns -> 2 rows; cells are 64x48 plus a label strip.
            assert im.width == 5 * 64
            assert im.height == 2 * (48 + 16)

    def test_animation_is_multi_frame(self, tmp_path: Path):
        frames = [_jpeg(color=(i * 30, 60, 60)) for i in range(5)]
        out = write_step_animation(frames, tmp_path / 'a_steps.webp')
        assert out and out.is_file()
        with Image.open(out) as im:
            assert im.format == 'WEBP'
            assert getattr(im, 'n_frames', 1) == 5

    def test_animation_normalises_mixed_sizes(self, tmp_path: Path):
        """Two samplers in one graph can preview at different sizes."""
        frames = [_jpeg(size=(64, 48), color=(10, 10, 200)),
                  _jpeg(size=(32, 24), color=(10, 200, 10)),
                  _jpeg(size=(64, 48), color=(200, 10, 10))]
        out = write_step_animation(frames, tmp_path / 'mixed_steps.webp')
        assert out and out.is_file()
        with Image.open(out) as im:
            assert im.size == (64, 48)
            assert getattr(im, 'n_frames', 1) == 3

    def test_identical_frames_collapse(self, tmp_path: Path):
        """WebP drops frames that encode the same as their predecessor.

        Harmless for real renders, where every step differs — but worth pinning so
        a future "the animation lost frames" is recognised as the encoder, not us.
        """
        frames = [_jpeg(color=(120, 120, 120)) for _ in range(4)]
        out = write_step_animation(frames, tmp_path / 'flat_steps.webp')
        assert out and out.is_file()
        with Image.open(out) as im:
            assert getattr(im, 'n_frames', 1) == 1

    def test_no_frames_writes_nothing(self, tmp_path: Path):
        assert write_step_sheet([], tmp_path / 'x.jpg') is None
        assert write_step_animation([], tmp_path / 'x.webp') is None
        assert not list(tmp_path.iterdir())

    def test_undecodable_frames_are_skipped(self, tmp_path: Path):
        frames = [b'not an image', _jpeg(), b'\x00\x01']
        out = write_step_sheet(frames, tmp_path / 'b_steps.jpg')
        assert out and out.is_file()
        with Image.open(out) as im:
            assert im.width == 64      # exactly one usable frame -> one column


class TestPreviewRoute:
    """/api/comfy/preview serves raw bytes, not base64 over SSE."""

    @pytest.fixture()
    def client(self, tmp_path: Path):
        from server import create_app
        Image.new('RGB', (8, 8)).save(tmp_path / 'a.png')
        app = create_app(
            root_dir=tmp_path, config={}, selected_name='__selected', dust_name='__dust',
            monitor_enabled=False, comfy_queue_enabled=False, validation_interval=0,
        )
        app.config['TESTING'] = True
        with app.test_client() as c:
            yield c

    def test_204_when_no_frame_yet(self, client):
        from server.background import PREVIEWS
        PREVIEWS._latest = None            # nothing has streamed
        assert client.get('/api/comfy/preview').status_code == 204

    def test_serves_the_latest_frame(self, client):
        from server.background import PREVIEWS
        blob = _jpeg()
        PREVIEWS.add_frame('image/jpeg', blob)
        r = client.get('/api/comfy/preview')
        assert r.status_code == 200
        assert r.mimetype == 'image/jpeg'
        assert r.data == blob
        assert r.headers['Cache-Control'] == 'no-store'

    def test_stale_frame_is_not_served(self, client):
        from server.background import PREVIEWS
        PREVIEWS.add_frame('image/jpeg', _jpeg())
        PREVIEWS._latest_at = 0            # long ago: a render that ended
        assert client.get('/api/comfy/preview').status_code == 204
