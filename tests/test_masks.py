"""
Tests for /api/masks — the Inpaint dialog's mask store.

Run:
    pytest tests/test_masks.py -v

No external services required.
"""

import base64
import io
from pathlib import Path

import pytest
from PIL import Image

from server import create_app

SRC_SIZE = (64, 48)


def _make_png(path: Path) -> None:
    """A source image with varied colour, so a colour-preservation check has teeth."""
    img = Image.new('RGB', SRC_SIZE)
    px = img.load()
    for y in range(SRC_SIZE[1]):
        for x in range(SRC_SIZE[0]):
            px[x, y] = (x * 3 % 256, y * 5 % 256, (x + y) * 2 % 256)
    img.save(path, format='PNG')


def _coverage(size=SRC_SIZE, box=(10, 10, 30, 30), mode='L') -> str:
    """White-on-black coverage as a data URL: white is the area to repaint."""
    img = Image.new(mode, size, 0 if mode == 'L' else (0, 0, 0))
    Image.Image.paste(img, 255 if mode == 'L' else (255, 255, 255), box)
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


@pytest.fixture()
def photo_dir(tmp_path: Path) -> Path:
    _make_png(tmp_path / 'src.png')
    (tmp_path / 'sub').mkdir()
    _make_png(tmp_path / 'sub' / 'nested.png')
    return tmp_path


@pytest.fixture()
def client(photo_dir: Path):
    app = create_app(
        root_dir=photo_dir,
        config={},
        selected_name='__selected',
        dust_name='__dust',
        monitor_enabled=False,
        comfy_queue_enabled=False,
        validation_interval=0,
    )
    app.config['TESTING'] = True
    with app.test_client() as c:
        yield c


class TestSaveMask:

    def test_writes_rgba_beside_the_source(self, client, photo_dir):
        r = client.post('/api/masks?path=src.png', json={'coverage': _coverage()})
        assert r.status_code == 200
        rel = r.get_json()['path']
        assert rel.startswith('__masks/')

        out = photo_dir / rel
        assert out.is_file()
        with Image.open(out) as im:
            assert im.mode == 'RGBA'
            assert im.size == SRC_SIZE

    def test_alpha_is_the_inverse_of_coverage(self, client, photo_dir):
        r = client.post('/api/masks?path=src.png', json={'coverage': _coverage(box=(10, 10, 30, 30))})
        with Image.open(photo_dir / r.get_json()['path']) as im:
            alpha = im.getchannel('A')
        # ComfyUI reads MASK as 1 - alpha, so painted must come back transparent.
        assert alpha.getpixel((20, 20)) == 0
        assert alpha.getpixel((50, 40)) == 255

    def test_colour_survives_under_the_hole(self, client, photo_dir):
        """The graph reads the source through the mask, so RGB must not be clobbered."""
        r = client.post('/api/masks?path=src.png', json={'coverage': _coverage()})
        with Image.open(photo_dir / r.get_json()['path']) as im:
            merged = im.convert('RGBA')
        with Image.open(photo_dir / 'src.png') as src:
            original = src.convert('RGB')
        for xy in [(20, 20), (12, 12), (50, 40), (0, 0)]:
            assert merged.getpixel(xy)[:3] == original.getpixel(xy), f'RGB changed at {xy}'

    def test_accepts_rgb_coverage(self, client):
        r = client.post('/api/masks?path=src.png', json={'coverage': _coverage(mode='RGB')})
        assert r.status_code == 200

    def test_nested_source_keeps_its_folder(self, client, photo_dir):
        r = client.post('/api/masks?path=sub/nested.png', json={'coverage': _coverage()})
        rel = r.get_json()['path']
        assert rel.startswith('sub/__masks/')
        assert (photo_dir / rel).is_file()

    def test_masks_dir_is_hidden_from_the_photo_index(self, client):
        before = client.get('/api/photos').get_json()['total']
        client.post('/api/masks?path=src.png', json={'coverage': _coverage()})
        client.post('/api/refresh')
        assert client.get('/api/photos').get_json()['total'] == before

    def test_prunes_old_masks(self, client, photo_dir):
        from server.utils import MASK_KEEP
        for _ in range(MASK_KEEP + 5):
            client.post('/api/masks?path=src.png', json={'coverage': _coverage()})
        assert len(list((photo_dir / '__masks').glob('*.png'))) == MASK_KEEP


class TestSaveMaskRejects:

    def test_size_mismatch(self, client):
        r = client.post('/api/masks?path=src.png', json={'coverage': _coverage(size=(32, 24))})
        assert r.status_code == 400
        assert 'but the image is' in r.get_json()['error']

    def test_missing_source(self, client):
        r = client.post('/api/masks?path=nope.png', json={'coverage': _coverage()})
        assert r.status_code == 404

    def test_missing_path(self, client):
        r = client.post('/api/masks?path=', json={'coverage': _coverage()})
        assert r.status_code == 400

    def test_missing_coverage(self, client):
        r = client.post('/api/masks?path=src.png', json={})
        assert r.status_code == 400

    def test_bad_base64(self, client):
        r = client.post('/api/masks?path=src.png', json={'coverage': 'not base64!!'})
        assert r.status_code == 400

    def test_not_an_image(self, client):
        payload = 'data:image/png;base64,' + base64.b64encode(b'nonsense').decode()
        r = client.post('/api/masks?path=src.png', json={'coverage': payload})
        assert r.status_code == 400

    def test_path_traversal(self, client):
        r = client.post('/api/masks?path=../escape.png', json={'coverage': _coverage()})
        assert r.status_code == 400
