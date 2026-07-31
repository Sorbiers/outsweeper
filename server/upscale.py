"""Local image upscaling: spandrel (model-based) and Pillow (interpolation).

Both run in-process in the Flask backend — no ComfyUI needed. `spandrel`/`torch`
are optional heavy dependencies; everything here degrades gracefully when they are
absent (see `upscale_capabilities`), and the pure-Pillow interpolation path always
works. The ComfyUI model-upscaler path lives in the routes layer, not here.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image

# Model file extensions spandrel can load from the configured models directory.
MODEL_EXTS = {'.pth', '.safetensors', '.pt', '.ckpt', '.bin'}

# ComfyUI ImageScaleBy method names → Pillow resampling filters.
RESAMPLE = {
    'nearest':  Image.NEAREST,
    'bilinear': Image.BILINEAR,
    'area':     Image.BOX,
    'bicubic':  Image.BICUBIC,
    'lanczos':  Image.LANCZOS,
}


def list_spandrel_models(models_dir: Path | None) -> list[str]:
    """Model files under `models_dir` (recursive), as forward-slash relative names."""
    if not models_dir or not models_dir.is_dir():
        return []
    out: list[str] = []
    for p in sorted(models_dir.rglob('*')):
        if p.is_file() and p.suffix.lower() in MODEL_EXTS:
            out.append(str(p.relative_to(models_dir)).replace('\\', '/'))
    return out


def upscale_capabilities(state: Any) -> dict:
    """Report what the upscale features can do right now: spandrel/torch presence,
    CUDA availability, and the models discovered in the configured directory.
    Interpolation is always available (pure Pillow)."""
    models_dir = getattr(state, 'upscale_models_resolved', None)
    spandrel_ok = False
    cuda = False
    error = None
    try:
        import torch  # noqa: F401
        import spandrel  # noqa: F401
        spandrel_ok = True
        cuda = bool(torch.cuda.is_available())
    except Exception as e:  # torch/spandrel not installed
        error = str(e)
    return {
        'spandrel':       spandrel_ok,
        'cuda':           cuda,
        'interpolation':  True,
        'models_dir':     str(models_dir) if models_dir else None,
        'models':         list_spandrel_models(models_dir),
        'methods':        sorted(RESAMPLE.keys()),
        'error':          error,
    }


def unique_output_path(src: Path, suffix: str, ext: str = '.png') -> Path:
    """`<stem>_<suffix>.png` next to the source, avoiding overwrites."""
    folder, stem = src.parent, src.stem
    candidate = folder / f'{stem}_{suffix}{ext}'
    i = 2
    while candidate.exists():
        candidate = folder / f'{stem}_{suffix}_{i}{ext}'
        i += 1
    return candidate


def run_interpolation(src: Path, dst: Path, method: str, scale: float) -> None:
    """Algorithmic upscale (nearest/bilinear/area/bicubic/lanczos) via Pillow —
    equivalent to a ComfyUI LoadImage → ImageScaleBy → SaveImage graph, but local."""
    resample = RESAMPLE.get(method, Image.LANCZOS)
    img = Image.open(src).convert('RGB')
    w, h = img.size
    target = (max(1, round(w * scale)), max(1, round(h * scale)))
    img.resize(target, resample).save(dst)


def _tiled_forward(model, t, tile: int, overlap: int, scale: int):
    """Run the model over overlapping tiles and average the seams — keeps VRAM
    bounded so large images upscale on modest GPUs (e.g. an 8 GB laptop)."""
    import torch
    _, _, h, w = t.shape
    out = torch.zeros((t.shape[0], t.shape[1], h * scale, w * scale), dtype=t.dtype, device=t.device)
    weight = torch.zeros_like(out)
    step = max(1, tile - overlap)
    ys = list(range(0, h, step))
    xs = list(range(0, w, step))
    for y in ys:
        for x in xs:
            y2, x2 = min(y + tile, h), min(x + tile, w)
            y1, x1 = max(0, y2 - tile), max(0, x2 - tile)
            up = model(t[:, :, y1:y2, x1:x2]).clamp(0, 1)
            oy, ox = y1 * scale, x1 * scale
            out[:, :, oy:oy + up.shape[2], ox:ox + up.shape[3]] += up
            weight[:, :, oy:oy + up.shape[2], ox:ox + up.shape[3]] += 1
            if x2 >= w:
                break
        if y2 >= h:
            break
    return out / weight.clamp(min=1)


def run_spandrel(model_path: Path, src: Path, dst: Path, tile: int = 512,
                 device: str | None = None) -> int:
    """Upscale `src` with a spandrel-loaded model, tiling to bound VRAM. Returns
    the model's native scale factor. Raises if torch/spandrel aren't installed or
    the file isn't a single-image super-resolution model."""
    import numpy as np
    import torch
    from spandrel import ImageModelDescriptor, ModelLoader

    if device is None:
        device = 'cuda' if torch.cuda.is_available() else 'cpu'

    model = ModelLoader().load_from_file(str(model_path))
    if not isinstance(model, ImageModelDescriptor):
        raise ValueError('not a single-image upscaling model')
    model.to(device).eval()
    scale = int(model.scale)

    img = Image.open(src).convert('RGB')
    arr = np.asarray(img, dtype=np.float32) / 255.0
    t = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0).to(device)

    with torch.no_grad():
        out = _tiled_forward(model, t, tile, 32, scale) if tile and tile > 0 else model(t).clamp(0, 1)

    arr_out = out.squeeze(0).permute(1, 2, 0).mul(255).round().clamp(0, 255).byte().cpu().numpy()
    Image.fromarray(arr_out).save(dst)
    return scale
