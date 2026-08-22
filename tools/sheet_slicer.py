#!/usr/bin/env python3
"""Cut a uniform contact sheet into its cells.

The reference sheets are generated as grids of equal cells separated by a white
gutter (see `docs/camera_example_prompts.md`). This finds the gutters and cuts on
them rather than dividing the sheet evenly, so a generator that lands the grid a
few pixels off-centre still slices cleanly.

Used as a library by `slice_camera_examples.py`, and directly for the numbered
charts:

    python tools/sheet_slicer.py SHEET COLS ROWS OUT_DIR [WIDTHxHEIGHT | no-trim]

which writes `OUT_DIR/01.jpg` .. in reading order, left to right, top to bottom.

Give a WIDTHxHEIGHT (e.g. `500x340`) to take a fixed rectangle out of the middle
of every cell instead of trimming its border by brightness — blunter, but it
guarantees the margins are gone and every tile comes out the same size. Give
`no-trim` for a gutterless sheet, where there is no border to remove and trimming
would bite into any cell that is genuinely white at its edge.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

#: Longest edge of a saved tile. The sheets are ~2800px wide; the dialogs show
#: these at ~160px, so anything larger is pure download weight.
TILE_PX = 512
JPEG_QUALITY = 88

#: A pixel this bright on every channel counts as gutter.
WHITE = 244
#: Fraction of a line that must be white for it to be part of a gutter.
WHITE_RATIO = 0.97

#: Trimming the border off a cut cell is deliberately more forgiving than finding
#: the gutters: the cells often carry a thin pale frame whose pixels sit a little
#: under WHITE, and demanding every pixel clear the bar aborts the trim on the
#: first stray one. A real photo edge — even a bright wall — never gets 98% of a
#: line this bright, so the looser test still can't eat content.
TRIM_WHITE = 236
TRIM_RATIO = 0.98


def _gutter_runs(img: Image.Image, axis: int) -> list[tuple[int, int]]:
    """Find [start, end) runs of near-white lines along `axis` (0 = columns)."""
    px = img.convert('L').load()
    w, h = img.size
    n, span = (w, h) if axis == 0 else (h, w)
    probes = range(0, span, 4)

    white = []
    for i in range(n):
        hits = sum(1 for j in probes if (px[i, j] if axis == 0 else px[j, i]) >= WHITE)
        white.append(hits >= WHITE_RATIO * len(probes))

    runs, start = [], None
    for i, is_white in enumerate(white):
        if is_white and start is None:
            start = i
        elif not is_white and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, n))
    return runs


def cuts(img: Image.Image, axis: int, count: int) -> list[tuple[int, int]]:
    """Return `count` [start, end) cell bands along `axis`.

    Uses the detected gutters when they line up with the expected grid, and falls
    back to an even split when a sheet's cells happen to be white at the edges.
    """
    n = img.size[0] if axis == 0 else img.size[1]
    if count == 1:
        return [(0, n)]

    # Interior gutters only: drop runs touching either end (white sky, borders).
    interior = [r for r in _gutter_runs(img, axis) if r[0] > 0 and r[1] < n]
    # Keep the widest `count - 1`, then put them back in positional order.
    interior.sort(key=lambda r: r[1] - r[0], reverse=True)
    gutters = sorted(interior[:count - 1])

    if len(gutters) != count - 1:
        step = n / count
        return [(round(i * step), round((i + 1) * step)) for i in range(count)]

    bands, prev = [], 0
    for g0, g1 in gutters:
        bands.append((prev, g0))
        prev = g1
    bands.append((prev, n))
    return bands


def trim_white(img: Image.Image) -> Image.Image:
    """Shave near-white border lines off all four sides.

    `cuts` only removes gutters *between* cells, so a sheet with an outer margin
    leaves white edges on the outermost tiles — and cells that carry their own
    pale frame leave one on every tile. This eats inward from each edge for as
    long as the line is near-white.
    """
    px = img.convert('L').load()
    w, h = img.size
    xs, ys = range(0, w, 3), range(0, h, 3)

    def row_white(y: int) -> bool:
        return sum(px[x, y] >= TRIM_WHITE for x in xs) >= TRIM_RATIO * len(xs)

    def col_white(x: int) -> bool:
        return sum(px[x, y] >= TRIM_WHITE for y in ys) >= TRIM_RATIO * len(ys)

    top, bottom, left, right = 0, h, 0, w
    while top < bottom and row_white(top):
        top += 1
    while bottom > top and row_white(bottom - 1):
        bottom -= 1
    while left < right and col_white(left):
        left += 1
    while right > left and col_white(right - 1):
        right -= 1

    # An all-white cell would trim to nothing — keep it rather than crash.
    if right - left < 2 or bottom - top < 2:
        return img
    return img.crop((left, top, right, bottom))


def center_crop(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Take a `size` rectangle out of the middle of `img`, clamped to what's there."""
    w, h = img.size
    cw, ch = min(size[0], w), min(size[1], h)
    left, top = (w - cw) // 2, (h - ch) // 2
    return img.crop((left, top, left + cw, top + ch))


def slice_sheet(sheet: Path, cols: int, rows: int,
                crop: tuple[int, int] | None = None, trim: bool = True) -> list[Image.Image]:
    """Cut a sheet into `cols * rows` tiles in reading order.

    By default each cell is shaved of any white border and scaled down to fit
    `TILE_PX`. Pass `crop` to instead take a fixed-size rectangle out of the middle
    of every cell — a blunter fix for borders that a threshold can't catch
    reliably, and it makes every tile exactly the same size.

    Pass `trim=False` for a sheet whose cells butt right up against each other:
    there is no border to remove, and a cell that is legitimately white at its edge
    (a portrait on a white ground, say) would be eaten alive by the trim.
    """
    img = Image.open(sheet).convert('RGB')
    xs = cuts(img, 0, cols)
    ys = cuts(img, 1, rows)

    tiles = []
    for i in range(cols * rows):
        x0, x1 = xs[i % cols]
        y0, y1 = ys[i // cols]
        cell = img.crop((x0, y0, x1, y1))
        if crop:
            cell = center_crop(cell, crop)
        else:
            if trim:
                cell = trim_white(cell)
            cell.thumbnail((TILE_PX, TILE_PX), Image.LANCZOS)
        tiles.append(cell)
    return tiles


def write_numbered(sheet: Path, cols: int, rows: int, out_dir: Path,
                   crop: tuple[int, int] | None = None, trim: bool = True) -> int:
    """Slice `sheet` and write the tiles as `01.jpg`.. into `out_dir` (emptied first)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob('*'):
        old.unlink()

    tiles = slice_sheet(sheet, cols, rows, crop, trim)
    for i, tile in enumerate(tiles, start=1):
        tile.save(out_dir / f'{i:02d}.jpg', quality=JPEG_QUALITY, optimize=True)
    return len(tiles)


def main() -> int:
    if len(sys.argv) not in (5, 6):
        print(__doc__)
        return 1
    sheet, cols, rows, out_dir = Path(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), Path(sys.argv[4])
    if not sheet.is_file():
        print(f'No such file: {sheet}')
        return 1

    crop, trim = None, True
    if len(sys.argv) == 6:
        arg = sys.argv[5].lower()
        if arg == 'no-trim':
            trim = False
        else:
            try:
                cw, ch = (int(v) for v in arg.split('x'))
                crop = (cw, ch)
            except ValueError:
                print(f'Bad mode {sys.argv[5]!r} - expected WIDTHxHEIGHT (e.g. 500x340) or "no-trim"')
                return 1

    n = write_numbered(sheet, cols, rows, out_dir, crop, trim)
    got = Image.open(next(iter(sorted(out_dir.glob('*'))))).size
    size_mb = sum(p.stat().st_size for p in out_dir.glob('*')) / 1e6
    print(f'{cols}x{rows} -> {n} tiles at {got[0]}x{got[1]}, {size_mb:.1f} MB in {out_dir}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
