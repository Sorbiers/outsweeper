"""
Basic API tests for OutSweeper (Flask backend).

Run:
    pytest tests/test_api.py -v

No external services (ComfyUI, LM Studio, ExifTool) are required.
"""

import io
import json
from pathlib import Path

import pytest
from PIL import Image

from server import create_app


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_png(path: Path, color: tuple = (100, 150, 200)) -> None:
    """Write a tiny valid RGB PNG to *path*."""
    img = Image.new('RGB', (16, 16), color=color)
    img.save(path, format='PNG')


@pytest.fixture()
def photo_dir(tmp_path: Path) -> Path:
    """Temp folder with 3 PNG images."""
    _make_png(tmp_path / 'alpha.png',   (255, 0,   0))
    _make_png(tmp_path / 'beta.png',    (0,   255, 0))
    _make_png(tmp_path / 'gamma.png',   (0,   0,   255))
    return tmp_path


@pytest.fixture()
def client(photo_dir: Path):
    """Flask test client pointed at *photo_dir*."""
    app = create_app(
        root_dir=photo_dir,
        config={},
        selected_name='__selected',
        dust_name='__dust',
        monitor_enabled=False,
        comfy_queue_enabled=False,
        validation_interval=0,   # disable background validation
    )
    app.config['TESTING'] = True
    with app.test_client() as c:
        yield c


# ---------------------------------------------------------------------------
# /api/config
# ---------------------------------------------------------------------------

class TestConfig:

    def test_returns_200(self, client):
        r = client.get('/api/config')
        assert r.status_code == 200

    def test_required_fields(self, client):
        data = r = client.get('/api/config').get_json()
        for key in ('comfy_url', 'lmstudio_url', 'selected_name', 'dust_name',
                    'thumbnails_name', 'root_name', 'widgets',
                    'has_run_comfy_command', 'has_run_lmstudio_command'):
            assert key in data, f'missing key: {key}'

    def test_defaults(self, client, photo_dir):
        data = client.get('/api/config').get_json()
        assert data['selected_name'] == '__selected'
        assert data['dust_name'] == '__dust'
        assert data['root_name'] == photo_dir.name
        assert data['has_run_comfy_command'] is False
        assert data['has_run_lmstudio_command'] is False


# ---------------------------------------------------------------------------
# /api/photos
# ---------------------------------------------------------------------------

class TestListPhotos:

    def test_returns_200(self, client):
        assert client.get('/api/photos').status_code == 200

    def test_lists_three_files(self, client):
        data = client.get('/api/photos').get_json()
        assert data['total'] == 3
        assert len(data['photos']) == 3

    def test_photo_shape(self, client):
        photos = client.get('/api/photos').get_json()['photos']
        p = photos[0]
        for key in ('filename', 'size', 'modified'):
            assert key in p, f'missing key: {key}'

    def test_sorted_by_name_ascending(self, client):
        names = [p['filename'] for p in
                 client.get('/api/photos?sort_by=name&sort_asc=true').get_json()['photos']]
        assert names == sorted(names)

    def test_sorted_by_name_descending(self, client):
        names = [p['filename'] for p in
                 client.get('/api/photos?sort_by=name&sort_asc=false').get_json()['photos']]
        assert names == sorted(names, reverse=True)

    def test_filter_by_name(self, client):
        data = client.get('/api/photos?filter=alpha').get_json()
        assert data['total'] == 1
        assert data['photos'][0]['filename'] == 'alpha.png'

    def test_pagination_limit(self, client):
        data = client.get('/api/photos?limit=2').get_json()
        assert len(data['photos']) == 2
        assert data['total'] == 3

    def test_pagination_offset(self, client):
        all_names = [p['filename'] for p in client.get('/api/photos?sort_by=name&sort_asc=true').get_json()['photos']]
        page2 = client.get('/api/photos?sort_by=name&sort_asc=true&offset=2&limit=2').get_json()
        assert len(page2['photos']) == 1
        assert page2['photos'][0]['filename'] == all_names[2]

    def test_empty_folder(self, tmp_path):
        app = create_app(tmp_path, {}, '__selected', '__dust',
                         monitor_enabled=False, comfy_queue_enabled=False, validation_interval=0)
        app.config['TESTING'] = True
        with app.test_client() as c:
            data = c.get('/api/photos').get_json()
        assert data['total'] == 0
        assert data['photos'] == []


# ---------------------------------------------------------------------------
# /api/file-types
# ---------------------------------------------------------------------------

class TestFileTypes:

    def test_returns_200(self, client):
        assert client.get('/api/file-types').status_code == 200

    def test_contains_png(self, client):
        types = client.get('/api/file-types').get_json()['types']
        assert '.png' in types

    def test_mixed_extensions(self, photo_dir):
        """JPEG alongside PNGs — both extensions appear."""
        img = Image.new('RGB', (16, 16))
        img.save(photo_dir / 'extra.jpg', format='JPEG')
        app = create_app(photo_dir, {}, '__selected', '__dust',
                         monitor_enabled=False, comfy_queue_enabled=False, validation_interval=0)
        app.config['TESTING'] = True
        with app.test_client() as c:
            types = c.get('/api/file-types').get_json()['types']
        assert '.png' in types
        assert '.jpg' in types


# ---------------------------------------------------------------------------
# /api/folders
# ---------------------------------------------------------------------------

class TestFolders:

    def test_returns_200(self, client):
        assert client.get('/api/folders').status_code == 200

    def test_required_fields(self, client):
        data = client.get('/api/folders').get_json()
        for key in ('folders', 'root_name', 'selected_name', 'dust_name'):
            assert key in data

    def test_subfolders_listed(self, photo_dir):
        (photo_dir / 'sub1').mkdir()
        (photo_dir / 'sub2').mkdir()
        app = create_app(photo_dir, {}, '__selected', '__dust',
                         monitor_enabled=False, comfy_queue_enabled=False, validation_interval=0)
        app.config['TESTING'] = True
        with app.test_client() as c:
            folders = c.get('/api/folders').get_json()['folders']
        assert 'sub1' in folders
        assert 'sub2' in folders

    def test_underscore_dirs_excluded(self, photo_dir):
        (photo_dir / '__selected').mkdir()
        app = create_app(photo_dir, {}, '__selected', '__dust',
                         monitor_enabled=False, comfy_queue_enabled=False, validation_interval=0)
        app.config['TESTING'] = True
        with app.test_client() as c:
            folders = c.get('/api/folders').get_json()['folders']
        assert '__selected' not in folders


# ---------------------------------------------------------------------------
# /api/tools
# ---------------------------------------------------------------------------

class TestTools:

    def test_no_tools_configured(self, client):
        data = client.get('/api/tools').get_json()
        assert data['tools'] == []

    def test_configured_tools_listed(self, photo_dir):
        tools = {'Resize': 'python resize.py %filename%'}
        app = create_app(photo_dir, {'tools': tools}, '__selected', '__dust',
                         monitor_enabled=False, comfy_queue_enabled=False, validation_interval=0)
        app.config['TESTING'] = True
        with app.test_client() as c:
            data = c.get('/api/tools').get_json()
        assert 'Resize' in data['tools']


# ---------------------------------------------------------------------------
# /api/exiftool/capabilities
# ---------------------------------------------------------------------------

class TestExiftoolCapabilities:

    def test_returns_200(self, client):
        assert client.get('/api/exiftool/capabilities').status_code == 200

    def test_available_field_present(self, client):
        data = client.get('/api/exiftool/capabilities').get_json()
        assert 'available' in data


# ---------------------------------------------------------------------------
# /api/move  +  /api/undo
# ---------------------------------------------------------------------------

class TestMoveAndUndo:

    def test_undo_empty_stack_returns_400(self, client):
        r = client.post('/api/undo')
        assert r.status_code == 400
        assert 'error' in r.get_json()

    def test_move_missing_file_returns_404(self, client):
        r = client.post(
            '/api/move?path=nonexistent.png',
            data=json.dumps({'destination': '__selected'}),
            content_type='application/json',
        )
        assert r.status_code == 404

    def test_move_creates_destination_dir(self, client, photo_dir):
        r = client.post(
            '/api/move?path=alpha.png',
            data=json.dumps({'destination': '__selected'}),
            content_type='application/json',
        )
        assert r.status_code == 200
        assert r.get_json()['ok'] is True
        assert (photo_dir / '__selected' / 'alpha.png').is_file()
        assert not (photo_dir / 'alpha.png').exists()

    def test_move_then_undo_restores_file(self, client, photo_dir):
        client.post(
            '/api/move?path=beta.png',
            data=json.dumps({'destination': '__selected'}),
            content_type='application/json',
        )
        assert (photo_dir / '__selected' / 'beta.png').is_file()

        r = client.post('/api/undo')
        assert r.status_code == 200
        assert r.get_json()['ok'] is True
        assert (photo_dir / 'beta.png').is_file()
        assert not (photo_dir / '__selected' / 'beta.png').exists()

    def test_move_to_dust(self, client, photo_dir):
        r = client.post(
            '/api/move?path=gamma.png',
            data=json.dumps({'destination': '__dust'}),
            content_type='application/json',
        )
        assert r.status_code == 200
        assert (photo_dir / '__dust' / 'gamma.png').is_file()


# ---------------------------------------------------------------------------
# /api/refresh
# ---------------------------------------------------------------------------

class TestRefresh:

    def test_returns_200(self, client):
        r = client.post('/api/refresh')
        assert r.status_code == 200

    def test_picks_up_new_file(self, client, photo_dir):
        before = client.get('/api/photos').get_json()['total']
        _make_png(photo_dir / 'delta.png')
        client.post('/api/refresh')
        after = client.get('/api/photos').get_json()['total']
        assert after == before + 1
