"""
Tests for dataset sidecars (/api/sidecar) and desktop editors (/api/open-with).

Run:
    pytest tests/test_sidecar.py -v

The editor tests drive the *configured* branch only, so nothing opens a GUI.
"""

import json
from pathlib import Path

import pytest
from PIL import Image

from server import create_app
from server.utils import SIDECAR_MAX_BYTES


@pytest.fixture()
def photo_dir(tmp_path: Path) -> Path:
    Image.new('RGB', (16, 16)).save(tmp_path / 'shot.png')
    Image.new('RGB', (16, 16)).save(tmp_path / 'bare.png')
    (tmp_path / 'shot.txt').write_text('a quiet library, warm lamp light', encoding='utf-8')
    (tmp_path / 'shot.json').write_text(json.dumps({'tags': ['library']}), encoding='utf-8')
    return tmp_path


def _client(photo_dir: Path, config: dict | None = None):
    app = create_app(
        root_dir=photo_dir, config=config or {}, selected_name='__selected',
        dust_name='__dust', monitor_enabled=False, comfy_queue_enabled=False,
        validation_interval=0,
    )
    app.config['TESTING'] = True
    return app.test_client()


@pytest.fixture()
def client(photo_dir: Path):
    with _client(photo_dir) as c:
        yield c


class TestSidecar:

    def test_returns_both_sidecars(self, client):
        r = client.get('/api/sidecar?path=shot.png')
        assert r.status_code == 200
        d = r.get_json()
        assert d['txt']['name'] == 'shot.txt'
        assert d['txt']['content'] == 'a quiet library, warm lamp light'
        assert d['json']['name'] == 'shot.json'
        assert json.loads(d['json']['content']) == {'tags': ['library']}

    def test_null_when_absent(self, client):
        assert client.get('/api/sidecar?path=bare.png').get_json() == {'txt': None, 'json': None}

    def test_json_is_returned_verbatim(self, client, photo_dir):
        """Raw text, not re-serialised — a malformed file must still display."""
        (photo_dir / 'shot.json').write_text('{ not valid json ,,', encoding='utf-8')
        d = client.get('/api/sidecar?path=shot.png').get_json()
        assert d['json']['content'] == '{ not valid json ,,'

    def test_large_file_is_truncated(self, client, photo_dir):
        (photo_dir / 'shot.txt').write_text('x' * (SIDECAR_MAX_BYTES + 500), encoding='utf-8')
        d = client.get('/api/sidecar?path=shot.png').get_json()
        assert d['txt']['truncated'] is True
        assert len(d['txt']['content']) == SIDECAR_MAX_BYTES
        assert d['txt']['size'] == SIDECAR_MAX_BYTES + 500

    def test_undecodable_bytes_do_not_error(self, client, photo_dir):
        (photo_dir / 'shot.txt').write_bytes(b'caption \xff\xfe raw')
        d = client.get('/api/sidecar?path=shot.png').get_json()
        assert d['txt'] is not None and 'caption' in d['txt']['content']

    def test_missing_image_still_answers(self, client):
        """The sidecar lookup is by stem, so a missing image is simply "none"."""
        assert client.get('/api/sidecar?path=ghost.png').get_json() == {'txt': None, 'json': None}

    def test_path_traversal(self, client):
        assert client.get('/api/sidecar?path=../escape.png').status_code == 400


class TestOpenWith:

    def test_rejects_unknown_editor(self, client):
        r = client.post('/api/open-with?path=shot.png', json={'editor': 'notepad'})
        assert r.status_code == 400

    def test_missing_file(self, client):
        r = client.post('/api/open-with?path=ghost.png', json={'editor': 'paint'})
        assert r.status_code == 404

    def test_path_traversal(self, client):
        r = client.post('/api/open-with?path=../escape.png', json={'editor': 'paint'})
        assert r.status_code == 400

    def test_configured_command_runs_with_filename(self, photo_dir: Path):
        """The configured branch substitutes %filename% and launches without waiting."""
        marker = photo_dir / 'launched.txt'
        cfg = {'editors': {'paint': f'cmd /c echo %filename% > "{marker}"'}}
        with _client(photo_dir, cfg) as c:
            r = c.post('/api/open-with?path=shot.png', json={'editor': 'paint'})
        assert r.status_code == 200 and r.get_json() == {'ok': True}

        # Popen doesn't wait, so give the shell a moment to write the marker.
        import time
        for _ in range(40):
            if marker.is_file() and marker.read_text(errors='replace').strip():
                break
            time.sleep(0.05)
        assert 'shot.png' in marker.read_text(errors='replace')
