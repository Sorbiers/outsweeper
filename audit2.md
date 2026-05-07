**Findings**

- High: `batch` and `zip` trust raw `filenames` from the client and join them directly onto a trusted folder without re-validating each child path. In [app.py](/F:/photoParser/app.py:1396) and [app.py](/F:/photoParser/app.py:1444), a value like `../outside.jpg` can escape the selected folder for read/copy/move, and the zip endpoint can also emit unsafe archive names. `resolve_path()` is solid, but these two routes bypass it.

- Medium: mutable app state is global and unsynchronized. `undo_stack` is process-wide in [app.py](/F:/photoParser/app.py:38), appended in [app.py](/F:/photoParser/app.py:994), and popped in [app.py](/F:/photoParser/app.py:1001). Folder caches are also mutated from background threads and request threads in [app.py](/F:/photoParser/app.py:562), [app.py](/F:/photoParser/app.py:681), [app.py](/F:/photoParser/app.py:793), [app.py](/F:/photoParser/app.py:1188), and [app.py](/F:/photoParser/app.py:1414). With `threaded=True`, this can produce cross-client undo behavior, stale cache state, and intermittent dict-mutation failures.

- Medium: metadata edits rewrite originals in place through Pillow instead of performing metadata-only updates. In [app.py](/F:/photoParser/app.py:1164), PNG writes preserve only string chunks, and JPEG/WebP writes recompress the image at `quality=98` in [app.py](/F:/photoParser/app.py:1182). That is an integrity risk: image bytes change, some metadata can be lost, and there is no temp-file plus atomic replace path if the write fails mid-operation.

- Medium: privileged command execution is exposed over HTTP and still uses shell parsing. `/api/tools/run` builds a shell string and runs it with `shell=True` in [app.py](/F:/photoParser/app.py:1354), and `/api/run-command` launches configured commands through `cmd /c` in [app.py](/F:/photoParser/app.py:1489). Even for a localhost desktop app, these should be treated as privileged surfaces, not normal UI actions.

- Medium: external integration endpoints accept arbitrary user-supplied URLs for ComfyUI/LM Studio calls, for example in [app.py](/F:/photoParser/app.py:1078) and [app.py](/F:/photoParser/app.py:1122). That makes the app an SSRF-capable HTTP client from the local machine. If this UI ever processes untrusted input or browser-origin abuse, that becomes a real security boundary.

- Low: backend and frontend API contracts have drifted. The frontend types in [photo.model.ts](/F:/photoParser/frontend/src/app/models/photo.model.ts:47) and service methods in [photo.service.ts](/F:/photoParser/frontend/src/app/services/photo.service.ts:67) expect richer move/undo payloads than the backend actually returns in [app.py](/F:/photoParser/app.py:995) and [app.py](/F:/photoParser/app.py:997). That is a unification problem more than a bug today, but it weakens type safety and future changes.

- Low: test coverage is thin for the risky parts. The repo has a UI-oriented Playwright demo in [tests/demo.spec.js](/F:/photoParser/tests/demo.spec.js:1), but I did not find backend tests around path traversal, metadata round-trips, undo semantics, or concurrent cache mutation.

**Improvements**

- Centralize path policy. Add one helper like `resolve_child(base_dir, rel_name)` that resolves, normalizes, rejects `..`, and returns both filesystem path and safe archive name. Use it in `batch`, `zip`, and any future multi-file endpoint.

- Replace process-global mutable state with an app-state object plus locks, or move indexing/undo into a small storage layer. At minimum, protect `undo_stack`, `folder_caches`, `tag_index`, and `_comfy_progress` with a `threading.RLock`.

- Stop using Pillow for metadata mutation where the goal is “edit metadata only.” Prefer `exiftool` for JPG/WEBP/PNG metadata writes, write to a temp file, then atomically replace the original. Add an explicit collision policy for move/copy: `fail`, `rename`, or `overwrite`.

- Treat command execution and host actions as privileged. Disable them by default, require an explicit config flag, replace shell strings with argv arrays, and add request-origin/session checks for all side-effect routes.

- Constrain outbound URLs. Accept only `http://127.0.0.1`, `http://localhost`, or a small allowlist unless the user explicitly enables remote hosts in config.

- Split `app.py` into coherent modules. A reasonable cut is `routes/files.py`, `routes/metadata.py`, `routes/integrations.py`, `services/indexing.py`, and `security.py`. Right now too much policy is embedded in one file, which is the main unification issue.

- Add backend tests first for traversal rejection, undo isolation, metadata no-loss behavior, and batch/zip limits. Then add one contract test that compares Flask response shapes to the TS interfaces.

`python -m py_compile app.py` passed. I could not verify the Angular build in the sandbox because `npm run build` hit an `EPERM` while resolving `C:\Users\avr`, so frontend build status is still unconfirmed here.
