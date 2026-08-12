# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workflow Rules

- **NEVER commit without explicit user approval.** Always show what will be committed and wait for the user to say "commit" or otherwise explicitly approve before running `git commit`.
- **Flag naming issues before implementing.** If a prompt contains a word or name that is clearly wrong, a typo that changes meaning, or conflicts with a strong established convention (e.g. "Localize" when "Locate" is the standard term), say so in one line before implementing. Do not second-guess intent — only flag obvious slips.

## Project Overview

Photo Parser is a minimal, portable Python 3 tool for manual image triage. It provides a keyboard-driven browser UI for quickly sorting photos into `__selected` or `__dust` folders. Supported formats: `.png`, `.jpg`, `.jpeg`, `.webp`. Windows-first, local-only.

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

# Release build (builds frontend, bundles app.py + static/ + .bat launchers into release/)
npm run release
```

## Architecture

**Backend:** `app.py` — Flask server on port 1976. Serves REST API + built Angular files from `static/`.

**Frontend:** `frontend/` — Angular v20 + Angular Material SPA. Standalone components (no NgModule). Built output goes to `static/` (configured in `angular.json` outputPath).

**API endpoints — Photo management:**
- `GET /api/photos` — list images (`?folder=source|selected|dust`)
- `GET /api/photos/<fn>/info` — metadata + ComfyUI + EXIF + PNG text chunks
- `GET /api/photos/<fn>/image` — serve raw image
- `GET /api/photos/<fn>/thumbnail` — serve cached 300×300 JPEG (stored in `__thumbnails/`, mtime-invalidated)
- `POST /api/photos/<fn>/move` — move to `__selected` or `__dust`
- `POST /api/undo` — undo last move (in-memory stack)
- `POST /api/photos/<fn>/describe` — AI description via LM Studio vision API
- `POST /api/photos/<fn>/write-meta` — write description to PNG text chunk or JPEG/WebP EXIF

**API endpoints — External integrations:**
- `POST /api/comfy/check` — verify ComfyUI connection
- `POST /api/comfy/loras` — list available LoRAs
- `POST /api/comfy/checkpoints` — list available checkpoints
- `POST /api/comfy/prompt` — submit workflow to ComfyUI (low-level; prefer the job queue)
- `POST /api/lmstudio/check` — verify LM Studio connection

**API endpoints — Internal job queue:**
- `GET  /api/jobs` — queue snapshot (`{jobs, paused}`); also pushed over SSE as `jobs:`
- `POST /api/jobs` — enqueue `{kind, title, payload}`
- `GET  /api/jobs/<id>` — full detail (guided generation's per-iteration history)
- `POST /api/jobs/<id>/cancel` · `POST /api/jobs/cancel-all`
- `POST /api/jobs/reorder` — new order for the *queued* jobs
- `POST /api/jobs/pause` · `POST /api/jobs/settings` · `POST /api/jobs/clear-finished`

## Job queue (core architecture)

ComfyUI and LM Studio cannot hold VRAM simultaneously on the target machine, so **every
non-interactive operation is a backend job** rather than being driven from the browser.
A single worker thread (`server/jobs.py`) runs jobs one at a time and, before touching an
engine, enforces the invariants in `server/resources.py`: the service is running (launched
on demand), ComfyUI's own queue is drained (or force-cleared), and the *other* engine's
memory has been released. Work therefore survives closing a dialog or the whole tab.

- **Job kinds:** `comfy` (Send / Send to front / Outpaint / Upscale), `improve_send`
  (LLM enriches each prompt, then renders), `guided` (improve → render → vision-judge →
  refine, looping until it matches or the budget runs out).
- **Status lifecycle:** `queued → running → processed → done`, plus `failed` / `cancelled`.
  `processed` means ComfyUI accepted the graphs; `done` means the images exist.
- **Payload contract:** the **frontend builds the ComfyUI graphs** (that logic stays in
  TypeScript) and submits them as finished graphs plus *patch points* — `promptNodeId`,
  `seedNodeId`, `uploadNodeId` — which is all a multi-step runner needs to re-prompt,
  re-seed, or drop in an uploaded image between iterations.
- **Source images are uploaded by the worker**, not the browser, so img2img / Outpaint /
  Upscale no longer require ComfyUI to be running when the dialog is used.
- **LLM instruction texts** live in `server/prompts.py` — the single place to tune wording.
- **Interactive dialogs deliberately bypass the queue**: Describe, Synopsis to Illustrations
  and LM Prompt call LM Studio directly and are *not* arbitrated, so they can collide with a
  running job. That's an accepted trade-off (the user is present and driving them).
- Tests: `tests/test_job_queue.py` runs the worker against a stub ComfyUI + stub LM Studio
  (no GPU) and asserts serial execution, queue-drain waiting, engine mutual exclusion,
  reorder/cancel, and the guided loop's refine behaviour.

**Key API pattern:** All photo routes accept `?folder=source|selected|dust` to target source, `__selected`, or `__dust` directories.

**UI layout:**
- Top strip (25vh): horizontal scrollable image strip with keyboard navigation
- Bottom left (65vw): info panel — filename, date, size, metadata, ComfyUI data
- Bottom right (35vw): full-scale image preview with zoom/pan
- All panel dividers are drag-resizable (strip: 10–50%, preview: 20–80%)

**Keyboard actions:** `+`/`=` selects, `Delete` dusts, `←`/`→` navigates, `Home`/`End` jump to first/last, `Ctrl+Z` undoes. Keyboard is suppressed when dialogs or inputs are focused.

**Angular component structure:**
- `App` — layout shell, keyboard action orchestrator, resizable panel dividers
- `ImageStrip` — thumbnail strip with IntersectionObserver lazy loading and auto-center scroll
- `InfoPanel` — metadata display with ComfyUI workflow details
- `PreviewPanel` — full-resolution image viewer with mouse-wheel zoom and click-drag pan
- `GenerateDialog` — edit ComfyUI workflows and queue them as jobs; extracts variable nodes (LoRAs, checkpoints) for Cartesian product batch generation
- `DescribeDialog` — AI image description via LM Studio vision model; can save description to image metadata
- `PrompterDialog` — compose narrative prompts from randomized preset arrays (ambience, character, action, style)
- `GuidedGenerationDialog` — configures a `guided` job, then *monitors* it (the loop runs on the backend, so closing the dialog doesn't stop it)
- `JobQueueWidget` / `JobQueueDialog` — the internal queue: live status, drag-to-reorder, cancel, pause. Separate from the ComfyUI queue widget/dialog, which still show ComfyUI's own queue.

**ComfyUI metadata extraction** (`app.py`): Reads PNG `prompt` metadata field, walks ComfyUI workflow nodes to extract model (`ckpt_name`), LoRAs (`lora_name`), KSampler params (`steps`/`cfg`/`seed`/`sampler_name`), and CLIP text prompts.

**User preferences** (ComfyUI URL, LM Studio URL/model) are persisted in browser `localStorage`.

## Utility Scripts

- `describe.py` — CLI for LM Studio vision image description. Usage: `python describe.py <image> [prompt] [model]`
- `gen.py` — batch ComfyUI executor: reads PNG workflows, randomizes prompts/seeds, posts to ComfyUI. Usage: `python gen.py <folder>`
- `run.py` — batch ComfyUI executor: re-sends PNG workflows with random seeds. Usage: `python run.py <folder>`
- `generate_from_collection.py` — run a saved collection flow `.json` (`{ flow, dictionaries }`) N times, one job at a time, re-randomizing `{{tokens}}` and the seed per job and saving outputs to a folder. Usage: `python generate_from_collection.py <path_to_json> <jobs_number> <out_path>`
- `prompt.py` — prints a single random prompt from preset arrays. Usage: `python prompt.py`

## Dependencies

- Python: Flask, Pillow, requests (see `requirements.txt`)
- Frontend: Angular 20, Angular Material (see `frontend/package.json`)

## Dev Workflow

Run Flask backend (`python app.py <folder>`) in one terminal, Angular dev server (`cd frontend && npx ng serve`) in another. Dev server on `:4200` proxies `/api` to `:1976` via `frontend/proxy.conf.json`.

After frontend changes, rebuild with `cd frontend && npx ng build` — output lands in `static/` for production use.

No test suite is in active use — Angular schematics are configured with `skipTests: true`.
