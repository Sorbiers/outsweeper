#!/usr/bin/env python3
"""Slice the camera-example contact sheets into one photo per cheat-chart preset.

The sheets are generated from the prompts in `docs/camera_example_prompts.md` —
seven photographic grids, one per topic, cells separated by a white gutter. This
cuts them on that gutter, shaves any leftover white border, and writes one image
per preset id:

    frontend/public/charts/camera-examples/<preset id>.jpg

Naming by id rather than by cell number means the camera dialog looks a photo up
directly, and a regenerated sheet drops straight in.

    python tools/slice_camera_examples.py [SOURCE_DIR]

Sheets are matched by the digit their filename starts with (1..7), which is how
they come out of the generator.
"""
from __future__ import annotations

import sys
from pathlib import Path

from sheet_slicer import JPEG_QUALITY, slice_sheet

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'frontend' / 'public' / 'charts' / 'camera-examples'
DEFAULT_SRC = Path('F:/down/camera')

#: Sheet number -> (columns, rows, preset ids in reading order).
#: The ids come from `camera-presets.ts`; the grouping is the one the sheets were
#: generated to, which folds 'dutch' onto the composition sheet to keep the grids
#: rectangular.
SHEETS: dict[int, tuple[int, int, list[str]]] = {
    1: (4, 2, ['ecu', 'cu', 'mcu', 'ms', 'cowboy', 'full', 'long', 'els']),
    2: (3, 2, ['eye', 'low', 'worm', 'high', 'bird', 'top']),
    3: (3, 2, ['front', 'threeq', 'profile', 'back', 'ots', 'pov']),
    4: (4, 2, ['fisheye', 'ultrawide', 'wide', 'normal', 'portrait', 'tele', 'macro', 'tiltshift']),
    5: (2, 2, ['shallow', 'mid', 'deep', 'rack']),
    6: (2, 2, ['freeze', 'blur', 'longexp', 'panning']),
    7: (3, 2, ['thirds', 'center', 'symmetry', 'leading', 'negative', 'dutch']),
}

def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    if not src.is_dir():
        print(f'No such directory: {src}')
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob('*'):
        old.unlink()

    total = 0
    for num, (cols, rows, ids) in sorted(SHEETS.items()):
        matches = [p for p in sorted(src.iterdir())
                   if p.is_file() and p.stem[:1] == str(num)
                   and p.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp'}]
        if not matches:
            print(f'  sheet {num}: no file starting with "{num}" in {src} - skipped')
            continue

        for preset_id, tile in zip(ids, slice_sheet(matches[0], cols, rows)):
            tile.save(OUT / f'{preset_id}.jpg', quality=JPEG_QUALITY, optimize=True)
            total += 1

        print(f'  sheet {num}: {cols}x{rows} -> {len(ids)} tiles '
              f'({matches[0].name[:28]}...)')

    size_mb = sum(p.stat().st_size for p in OUT.glob('*')) / 1e6
    print(f'Done - {total} tiles, {size_mb:.1f} MB in {OUT}')
    return 0 if total else 1


if __name__ == '__main__':
    sys.exit(main())
