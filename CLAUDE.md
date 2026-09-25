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
- `GET  /api/comfy/preview` — the newest sampler step preview as raw image bytes
  (204 when previews are off or the last frame is stale). Served as bytes rather
  than pushed over SSE: frames are tens of kB and arrive several times a second
- `GET  /api/sidecar?path=<image>` — same-stem `.txt` / `.json` beside the image
  (dataset captions and tags), returned verbatim and capped at `SIDECAR_MAX_BYTES`
- `POST /api/open-with?path=<image>` — hand the file to Paint or the system photo
  editor and return immediately (unlike `/api/tools/run`, which waits); overridable
  via config's `[editors]`
- `POST /api/masks?path=<image>` — store an Inpaint mask: takes the painted coverage
  (white = repaint), merges it into the source's alpha with Pillow, writes it to a
  hidden `__masks/` folder beside the image and returns the path for a job's `upload`

**API endpoints — External integrations:**
- `POST /api/comfy/check` — verify ComfyUI connection
- `POST /api/comfy/loras` — list available LoRAs
- `POST /api/comfy/checkpoints` — list available checkpoints
- `POST /api/comfy/prompt` — submit workflow to ComfyUI (low-level; prefer the job queue)
- `POST /api/lmstudio/check` — verify LM Studio connection
- `POST /api/lmstudio/loaded` — the model LM Studio has loaded (`{key, instance}`, both null
  when none), read from its native API on demand rather than the widget's poll
- `POST /api/lmstudio/unload` — unload every loaded LM Studio instance (frees VRAM)

**API endpoints — Internal job queue:**
- `GET  /api/jobs` — queue snapshot (`{jobs, paused}`); also pushed over SSE as `jobs:`
- `POST /api/jobs` — enqueue `{kind, title, payload}`
- `GET  /api/jobs/<id>` — full detail (guided generation's per-iteration history)
- `POST /api/jobs/<id>/cancel` · `POST /api/jobs/cancel-all`
- `POST /api/jobs/reorder` — new order for the *queued* jobs
- `POST /api/jobs/pause` · `POST /api/jobs/settings` · `POST /api/jobs/clear-finished`

## Step previews

ComfyUI's sampler decodes `x0` — its running estimate of the finished image — once
per step and pushes it as a **binary** websocket frame. `server/previews.py` parses
those frames, keeps the newest for the COMFY widget's live thumbnail, and (when a
job sets `recordSteps`) buffers a prompt's frames and writes a numbered contact
sheet plus an animated WebP into `__steps/` beside the render.

- **Previews are off unless a job asks for them.** `submit_prompt` sends
  `extra_data.preview_method`, which ComfyUI applies per prompt and resets afterwards
  (`execution.py` -> `latent_preview.set_preview_method`) — `'none'` normally, `'taesd'`
  only when the job set `recordSteps`. So ordinary renders pay nothing for the per-step
  decode, and no ComfyUI command-line flag is needed: the per-prompt value overrides
  `--preview-method` in both directions. TAESD does need
  `taef1_decoder.safetensors` in `models/vae_approx/`, or ComfyUI warns and falls back
  to the much cruder `latent2rgb`.
- Legacy frames carry no ids, but each is preceded by a JSON `progress` message
  holding `prompt_id`, which is how frames are attributed to a job. Do **not**
  negotiate `supports_preview_metadata`: ComfyUI then stops sending the legacy
  frames, and the app would silently lose previews.
- Previews are TAESD approximations capped at `--preview-size` (default 512), not
  full VAE decodes — faithful in composition and colour, not in fine detail.

## Job queue (core architecture)

ComfyUI and LM Studio cannot hold VRAM simultaneously on the target machine, so **every
non-interactive operation is a backend job** rather than being driven from the browser.
A single worker thread (`server/jobs.py`) runs jobs one at a time and, before touching an
engine, enforces the invariants in `server/resources.py`: the service is running (launched
on demand), ComfyUI's own queue is drained (or force-cleared), and the *other* engine's
memory has been released. Work therefore survives closing a dialog or the whole tab.

- **Job kinds:** `comfy` (Send / Send to front / Outpaint / Inpaint / Kontext / ComfyUI
  upscale), `upscale` (local: spandrel on the GPU, or Pillow interpolation), `improve_send`
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
- **Interactive dialogs deliberately bypass the queue**: Describe, Synopsis to Illustrations,
  LM Prompt and Ask LM Studio call LM Studio directly and are *not* arbitrated, so they can collide with a
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
- `KontextDialog` — FLUX.1 Kontext: reference image + instruction. Two modes — **Edit**
  (plain instruction) and **Next frame**, which prepends a continuation clause naming
  what must stay fixed, since Kontext preserves identity but has no notion of time.
  The reference is encoded once and used twice (`ReferenceLatent` conditioning *and*
  the sampler's starting latent); `FluxKontextImageScale` handles odd aspect ratios.
  Variants queue N seeds off one reference. Lazy-loaded
- `InpaintDialog` — brush a mask over an image and queue a Flux Fill inpaint. Same graph
  as Outpaint minus `ImagePadForOutpaint`: the mask rides in the upload's alpha channel,
  since ComfyUI's `LoadImage` returns MASK as `1 - alpha`. Lazy-loaded. Mouse-wheel
  zooms about the cursor and middle-drag pans; LoRAs chain between the UNET/CLIP loaders
  and their consumers, so strength model/clip apply to the fill
- `DescribeDialog` — AI image description via LM Studio vision model; can save description to image metadata
- `PrompterDialog` — compose narrative prompts from randomized preset arrays (ambience, character, action, style)
- `LmChatDialog` — "Ask LM Studio" from the Generate dialog: model picker (defaults to the
  loaded model) with Eject, a chat request, and Paste of the reply into the prompt (turning
  on Multiple prompts when it has several paragraphs). Lazy-loaded
- Generate dialog **Resolve** (▶) — freezes a `{{…}}` template into Jobs number × prompt-part
  concrete prompts, one per paragraph, then turns on Multiple prompts and resets Jobs to 1.
  Dictionary-attached LoRAs are dropped, since the resolved text no longer triggers them
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
