"""Local background removal: rembg (ONNX) and BiRefNet (transformers/torch, GPU).

Both run in-process in the Flask backend and write a transparent PNG next to the
source. All heavy deps (rembg / onnxruntime-gpu / transformers+torch) are optional —
`bgremove_capabilities` probes what's present so the UI can gate each engine, exactly
like `server.upscale` does for spandrel.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image

# HF BiRefNet-family models for the torch engine. All share the BiRefNet forward
# (list output; last element → sigmoid mask), so one code path handles them.
# RMBG-2.0 is non-commercial-licensed — fine for local personal use.
BIREFNET_MODELS = [
    'ZhengPeng7/BiRefNet_lite',
    'ZhengPeng7/BiRefNet',
    'briaai/RMBG-2.0',
]

# Used only if rembg's runtime registry can't be read.
REMBG_FALLBACK_MODELS = [
    'u2net', 'u2netp', 'u2net_human_seg', 'silueta',
    'isnet-general-use', 'isnet-anime',
    'birefnet-general', 'birefnet-general-lite', 'birefnet-portrait', 'birefnet-massive',
]

# Per-process caches so repeated calls don't reload models.
_REMBG_SESSIONS: dict[str, Any] = {}
_BIREFNET_MODELS_CACHE: dict[str, Any] = {}


def _rembg_model_names() -> list[str]:
    try:
        from rembg.sessions import sessions_names  # type: ignore
        return sorted(sessions_names)
    except Exception:
        return REMBG_FALLBACK_MODELS


def bgremove_capabilities(state: Any) -> dict:
    """What the background-removal engines can do right now: rembg presence + its
    ONNX GPU provider + model list; BiRefNet (torch) presence + CUDA."""
    rembg_ok = False
    rembg_gpu = False
    rembg_models: list[str] = []
    birefnet_ok = False
    cuda = False
    error = None
    try:
        import rembg  # noqa: F401
        rembg_ok = True
        rembg_models = _rembg_model_names()
    except Exception as e:
        error = str(e)
    try:
        import onnxruntime as ort
        rembg_gpu = 'CUDAExecutionProvider' in ort.get_available_providers()
    except Exception:
        pass
    try:
        import torch
        import transformers  # noqa: F401
        birefnet_ok = True
        cuda = bool(torch.cuda.is_available())
    except Exception as e:
        if error is None:
            error = str(e)
    return {
        'rembg':           rembg_ok,
        'rembg_gpu':       rembg_gpu,
        'rembg_models':    rembg_models,
        'birefnet':        birefnet_ok,
        'cuda':            cuda,
        'birefnet_models': BIREFNET_MODELS,
        'error':           error,
    }


def run_rembg(src: Path, dst: Path, model: str, alpha_matting: bool = False) -> None:
    """Remove the background with rembg, writing a transparent PNG. Sessions are
    cached per model; onnxruntime uses CUDA automatically when available."""
    from rembg import new_session, remove

    session = _REMBG_SESSIONS.get(model)
    if session is None:
        session = new_session(model)
        _REMBG_SESSIONS[model] = session

    data = src.read_bytes()
    out = remove(data, session=session, alpha_matting=alpha_matting)
    dst.write_bytes(out)


def _from_pretrained(model_name: str):
    """Load a BiRefNet model, tolerating a global HF_HUB_OFFLINE=1: cached models
    load offline (no network), but a not-yet-downloaded model the user explicitly
    asked for triggers a one-time online fetch (offline is lifted just for that
    call, then restored)."""
    from transformers import AutoModelForImageSegmentation

    def _load():
        return AutoModelForImageSegmentation.from_pretrained(model_name, trust_remote_code=True)

    try:
        # Cached models load even under a global HF_HUB_OFFLINE=1 (reads cache).
        return _load()
    except Exception as first:
        # Not cached (or offline). Try a one-time online fetch for this explicitly
        # requested model, lifting a global HF_HUB_OFFLINE just for this call.
        import os
        try:
            import huggingface_hub.constants as hfc
        except Exception:
            hfc = None
        prev_env = os.environ.get('HF_HUB_OFFLINE')
        prev_const = getattr(hfc, 'HF_HUB_OFFLINE', None) if hfc else None
        os.environ['HF_HUB_OFFLINE'] = '0'
        if hfc is not None:
            try: hfc.HF_HUB_OFFLINE = False
            except Exception: pass
        try:
            return _load()
        except Exception:
            raise RuntimeError(
                f"Could not load '{model_name}': not cached and HuggingFace is offline "
                f"(HF_HUB_OFFLINE={prev_env}). Pre-download it once with HF_HUB_OFFLINE=0, "
                f"or pick a cached model / use the rembg engine (its birefnet-* models "
                f"need no HuggingFace)."
            ) from first
        finally:
            if prev_env is None:
                os.environ.pop('HF_HUB_OFFLINE', None)
            else:
                os.environ['HF_HUB_OFFLINE'] = prev_env
            if hfc is not None:
                try: hfc.HF_HUB_OFFLINE = prev_const
                except Exception: pass


def _load_birefnet(model_name: str, device: str):
    cached = _BIREFNET_MODELS_CACHE.get(model_name)
    if cached is not None:
        return cached
    import torch
    model = _from_pretrained(model_name)
    model.to(device).eval()
    try:
        torch.set_float32_matmul_precision('high')
    except Exception:
        pass
    _BIREFNET_MODELS_CACHE[model_name] = model
    return model


def run_birefnet(src: Path, dst: Path, model_name: str, device: str | None = None) -> None:
    """Run a BiRefNet-family model (transformers/torch) to produce an alpha matte on
    the GPU, apply it to the source, and save a transparent PNG."""
    import torch
    from torchvision import transforms

    if device is None:
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
    model = _load_birefnet(model_name, device)

    image = Image.open(src).convert('RGB')
    tf = transforms.Compose([
        transforms.Resize((1024, 1024)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    inp = tf(image).unsqueeze(0).to(device)

    with torch.no_grad():
        preds = model(inp)[-1].sigmoid().cpu()
    mask = transforms.ToPILImage()(preds[0].squeeze()).resize(image.size)

    out = image.convert('RGBA')
    out.putalpha(mask)
    out.save(dst)
