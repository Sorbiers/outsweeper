# Code Audit Report

## Backend (`app.py`)

### Critical / High

| # | Issue | Location | Fix |
|---|-------|----------|-----|
| B1 | **Tool command injection** — `shell=True` with `%filename%` substitution; a crafted filename or tool config could inject shell commands | `run_tool()` | Parse with `shlex.split()`, use `shell=False`, pass args as list |
| B2 | **Cache race condition** — `_validation_loop()` reads/writes `st['folder_caches']` with no lock while routes read it concurrently | Lines 555–577 | Add a `threading.Lock()` for cache mutations |
| B3 | **`_comfy_progress` global not protected** — written in `_comfy_ws_loop()` and read in `_comfy_queue_loop()` without a lock | Lines 88, 104, 138 | Protect with a lock |
| B4 | **`int()` on URL params unguarded** — `?offset=abc` causes unhandled 500 | `list_photos()` lines 729–751 | `try/except ValueError → 400` |

### Medium

| # | Issue | Location | Fix |
|---|-------|----------|-----|
| B5 | **`abort()` vs `jsonify()` mixed** — `abort()` returns HTML, `jsonify()` returns JSON; API inconsistency | `resolve_path()`, routes | Use `jsonify({'error':...}), 4xx` everywhere |
| B6 | **`sys.exit(1)` commented out** on port conflict — app continues and crashes at `app.run()` | Line 1521 | Uncomment or remove the dead check |
| B7 | **Bare `except Exception: pass`** in background loops — errors are invisible | `_metrics_loop`, `_comfy_ws_loop`, etc. | At minimum `print(f"[error] {e}")` |
| B8 | **`png_metadata['prompt']` KeyError risk** — `png_metadata` may not have `'prompt'` key | Line 888 | Use `.get('prompt')` |

### Low / Info

- Commented-out code blocks in `extract_comfyui_data()` (lines 246–253) — remove
- EXIF text extraction duplicated across two similar functions — consolidate
- Magic numbers `(300, 300)`, `quality=80`, `31536000` — make constants
- No `logging` module — using `print(flush=True)` throughout

---

## Frontend (Angular)

### Critical / High

| # | Issue | Location | Fix |
|---|-------|----------|-----|
| F1 | **No `EventSource.onerror` handler** — SSE connection failures silently ignored | `app.ts` line 136 | Add `this.eventSource.onerror = ...` |
| F2 | **`JSON.parse()` on raw SSE data unwrapped** — malformed SSE message throws uncaught exception | `app.ts` lines 139, 141 | Wrap in `try/catch` |
| F3 | **Dialog subscriptions never unsubscribed** — `getConfig()` subscription in `GenerateDialog` and `DescribeDialog` constructors leaks on close | `generate-dialog.ts:112`, `describe-dialog.ts:59` | Implement `OnDestroy` + `takeUntilDestroyed()` |

### Medium

| # | Issue | Location | Fix |
|---|-------|----------|-----|
| F4 | **Silent HTTP errors** — `getConfig()` and `getTools()` subscriptions have no error handler | Multiple dialogs | Add `error:` handler to all subscribes |
| F5 | **App component too large** — 609 lines, handles photos + favorites + layout + SSE + keyboard | `app.ts` | Extract `FavoritesService` (already partly exists), `LayoutResizeService` |
| F6 | **`as any` casts on config response** — `(cfg as any).has_run_comfy_command` | `generate-dialog.ts:113`, `describe-dialog.ts:60` | Extend the `getConfig()` return type in `PhotoService` |
| F7 | **ASCII-only EXIF field validation rejects Unicode** — valid characters like `é`, `ñ` rejected | `metadata-edit-dialog.ts` | Either allow UTF-8 or make the restriction explicit to the user |

### Low / Info

- Duplicate text in `lastDescribePrompt` in `ConnectionStateService` ("for t2i" appears twice)
- `Clipboard` injected in `describe-dialog.ts` but used by `copyDescription()` — not dead code, false positive
- Magic strings `'__selected'`, `'__dust'`, `pp_sortBy`, `pp_gen_steps` etc. scattered across components — consolidate to a constants file
- `tools` API called on every info-panel render — should be called once

---

## Priority Order for Pre-Release

**Must fix:** B1 (shell injection), B2+B3 (race conditions), F1+F2 (SSE crash), F3 (subscription leaks)

**Should fix:** B4 (500 on bad params), B5 (abort vs jsonify), F4 (silent errors), F6 (type safety)

**Can defer:** everything in Low/Info
