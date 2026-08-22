#!/usr/bin/env python3
"""Import pre-sliced reference-chart tiles into the app's public assets.

The tiles are cut from the contact sheets outside this repo (any tool will do) and
land here named `<anything>_r<ROW>_c<COL>.<ext>`, 1-based. This shaves any white
border off each one and writes it into the layout the chart dialogs expect:

    frontend/public/charts/camera/01.png .. 24.png   (6 columns)

    python tools/import_chart_tiles.py [SOURCE_DIR]

Sheets are told apart by their column count rather than by filename, so renaming
the exports doesn't break the import. Re-run it any time you recut the tiles.

Only the camera chart is imported this way. The lighting sets and the camera
cheat-chart examples come from whole sheets cut by `tools/sheet_slicer.py`.
"""
from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path

from PIL import Image

from sheet_slicer import trim_white

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'frontend' / 'public' / 'charts'
DEFAULT_SRC = Path('F:/down/tiles')

# Which chart a sheet is, identified by how many columns it has.
BY_COLUMNS = {6: 'camera'}

CELL_RE = re.compile(r'^(?P<prefix>.*)_r(?P<row>\d+)_c(?P<col>\d+)$', re.IGNORECASE)


def collect(src: Path) -> dict[str, list[tuple[int, int, Path]]]:
    """Group tile files by sheet prefix -> [(row, col, path)]."""
    sheets: dict[str, list[tuple[int, int, Path]]] = defaultdict(list)
    for p in sorted(src.iterdir()):
        if not p.is_file() or p.suffix.lower() not in {'.png', '.jpg', '.jpeg', '.webp'}:
            continue
        m = CELL_RE.match(p.stem)
        if m:
            sheets[m.group('prefix')].append((int(m.group('row')), int(m.group('col')), p))
    return sheets


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    if not src.is_dir():
        print(f'No such directory: {src}')
        return 1

    sheets = collect(src)
    if not sheets:
        print(f'No tiles named *_r<row>_c<col>.* found in {src}')
        return 1

    total = 0
    for prefix, cells in sheets.items():
        cols = max(c for _, c, _ in cells)
        rows = max(r for r, _, _ in cells)
        name = BY_COLUMNS.get(cols)
        if not name:
            print(f'  ? {prefix}: {cols} columns - not a known chart, skipped')
            continue

        out_dir = OUT / name
        out_dir.mkdir(parents=True, exist_ok=True)
        for old in out_dir.glob('*'):
            old.unlink()

        written = 0
        for row, col, path in sorted(cells):
            n = (row - 1) * cols + col
            trim_white(Image.open(path).convert('RGB')).save(out_dir / f'{n:02d}.png')
            written += 1
        expected = rows * cols
        note = '' if written == expected else f'  (expected {expected}!)'
        print(f'  {name}: {rows}x{cols} -> {written} tiles in {out_dir}{note}')
        total += written

    print(f'Done - {total} tiles.')
    return 0 if total else 1


if __name__ == '__main__':
    sys.exit(main())
