# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Photo Parser is a minimal, portable Python 3 tool for manual image triage. It provides a keyboard-driven browser UI for quickly sorting photos into `__selected` or `__dust` folders. Windows-first, local-only.

## Commands

```bash
# Run the app (opens browser automatically)
python app.py <source_folder>

# Install Python dependencies
pip install -r requirements.txt

# Build Angular frontend (output goes to static/)
cd frontend && npx ng build

# Angular dev server (proxies /api to Flask on :1976)
cd frontend && npx ng serve
```

## Architecture

**Backend:** `app.py` — Flask server on port 1976. Serves REST API + built Angular files from `static/`.

**Frontend:** `frontend/` — Angular v20 + Angular Material SPA. Built output goes to `static/` (configured in `angular.json` outputPath).

**API endpoints:**
- `GET /api/photos` — list images in source folder
- `GET /api/photos/<fn>/info` — metadata + ComfyUI + EXIF
- `GET /api/photos/<fn>/image` — serve raw image
- `GET /api/photos/<fn>/thumbnail` — serve thumbnail
- `POST /api/photos/<fn>/move` — move to `__selected` or `__dust`
- `POST /api/undo` — undo last move (in-memory stack)

**UI layout:**
- Top strip (25vh): horizontal scrollable image strip with keyboard navigation
- Bottom left (65vw): info panel — filename, date, size, metadata, ComfyUI data
- Bottom right (35vw): full-scale image preview with scroll

**Keyboard actions:** `+` selects, `Delete` dusts, `←`/`→` navigates, `Ctrl+Z` undoes.

**Angular component structure:**
- `App` — layout shell, keyboard action orchestrator
- `ImageStrip` — thumbnail strip with auto-center scroll
- `InfoPanel` — metadata display with ComfyUI workflow details
- `PreviewPanel` — full-resolution image viewer

**ComfyUI metadata extraction** (`app.py`): Reads PNG `prompt` metadata field, walks ComfyUI workflow nodes to extract model (`ckpt_name`), LoRAs (`lora_name`), KSampler params (`steps`/`cfg`/`seed`/`sampler_name`), and CLIP text prompts.

## Dependencies

- Python: Flask, Pillow (see `requirements.txt`)
- Frontend: Angular 20, Angular Material (see `frontend/package.json`)

## Dev Workflow

Run Flask backend (`python app.py <folder>`) in one terminal, Angular dev server (`cd frontend && npx ng serve`) in another. Dev server on `:4200` proxies `/api` to `:1976` via `frontend/proxy.conf.json`.

After frontend changes, rebuild with `cd frontend && npx ng build` — output lands in `static/` for production use.
