"""Internal job queue — the app's single gateway to ComfyUI and LM Studio.

Everything non-interactive (Send, Send to front, Outpaint, Upscale, and later the
LLM-composite flows) is enqueued here instead of being driven from the browser.
One worker thread runs jobs strictly one at a time, and before each engine is used
it enforces the invariants in `resources.py`: the service is running, ComfyUI's own
queue is drained, and the other engine's VRAM has been released.

Two consequences worth stating: work survives closing the dialog or the tab, and
several operations can be lined up even though ComfyUI and LM Studio can never be
resident at the same time.

The frontend builds the ComfyUI graphs (that logic lives in TypeScript) and submits
them here as finished graphs plus *patch points* — the node ids holding the positive
prompt and the seed — which is all a multi-step runner needs to re-prompt or re-seed
between iterations.
"""
from __future__ import annotations

import base64
import mimetypes
import random
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import lmstudio
from . import prompts as prompts_text
from . import previews
from . import resources
from .resources import ResourceError
from .utils import STEPS_DIR
from .utils import LMS_COMPLETION_TIMEOUT, VISION_COMPLETION_TIMEOUT

# Lifecycle: queued -> running -> processed -> done, or failed / cancelled.
# "processed" means ComfyUI accepted the graphs; "done" means the images exist.
STATUS_QUEUED = 'queued'
STATUS_RUNNING = 'running'
STATUS_PROCESSED = 'processed'
STATUS_DONE = 'done'
STATUS_FAILED = 'failed'
STATUS_CANCELLED = 'cancelled'

ACTIVE_STATUSES = (STATUS_QUEUED, STATUS_RUNNING, STATUS_PROCESSED)
"""Statuses that still occupy the queue (a job can be cancelled from any of them)."""

MAX_FINISHED = 50
"""Finished jobs kept for the history view before the oldest are dropped."""


@dataclass
class Job:
    id: str
    kind: str
    title: str
    payload: dict = field(repr=False, default_factory=dict)
    status: str = STATUS_QUEUED
    progress: dict = field(default_factory=dict)     # {'step': str, 'pct': float|None}
    result: dict = field(default_factory=dict)       # {'filenames': [...], 'iterations': [...]}
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    cancel_requested: bool = False

    @property
    def active(self) -> bool:
        return self.status in ACTIVE_STATUSES

    def summary(self) -> dict:
        """Light view for the queue widget/manager — deliberately excludes `payload`,
        which holds full ComfyUI graphs and would bloat every SSE frame."""
        return {
            'id': self.id,
            'kind': self.kind,
            'title': self.title,
            'status': self.status,
            'progress': self.progress,
            'error': self.error,
            'created_at': self.created_at,
            'started_at': self.started_at,
            'finished_at': self.finished_at,
            'count': len(self.payload.get('prompts') or []),
            'filenames': (self.result.get('filenames') or [])[:12],
            'cancel_requested': self.cancel_requested,
        }

    def detail(self) -> dict:
        """Full view for the job dialog (adds guided-generation iterations)."""
        return {**self.summary(), 'result': self.result}


@dataclass
class JobContext:
    """Wiring supplied by `create_app` — the pieces that need Flask-side state.

    `copy_history_outputs` and `resolve_path` are closures over the app's workspace
    (folder caches, SSE broadcast), so they're injected rather than imported.
    """
    state: Any
    resolve_path: Callable[[str], Path]
    copy_history_outputs: Callable[[str, dict], list[str]]
    broadcast: Callable[[list[dict]], None]


class JobQueue:
    def __init__(self, ctx: JobContext) -> None:
        self._ctx = ctx
        self._jobs: list[Job] = []
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._paused = False
        self._thread: threading.Thread | None = None
        self._runners: dict[str, Callable[[Job], None]] = {
            'comfy': self._run_comfy,
            'improve_send': self._run_improve_send,
            'guided': self._run_guided,
            'synopsis': self._run_synopsis,
        }

    # --- public API -------------------------------------------------------

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._worker, daemon=True, name='job-worker')
            self._thread.start()

    def enqueue(self, kind: str, title: str, payload: dict) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], kind=kind, title=title or kind, payload=payload or {})
        with self._lock:
            self._jobs.append(job)
            self._trim()
        self._wake.set()
        self._broadcast()
        return job

    @property
    def paused(self) -> bool:
        return self._paused

    def snapshot(self) -> list[dict]:
        with self._lock:
            return [j.summary() for j in self._jobs]

    def state(self) -> dict:
        return {'jobs': self.snapshot(), 'paused': self._paused}

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return next((j for j in self._jobs if j.id == job_id), None)

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = next((j for j in self._jobs if j.id == job_id), None)
            if job is None or not job.active:
                return False
            job.cancel_requested = True
            was_queued = job.status == STATUS_QUEUED
            if was_queued:
                job.status = STATUS_CANCELLED
                job.finished_at = time.time()
        # A running job is stopped by interrupting the engine; the runner then
        # unwinds at its next cancellation checkpoint.
        if not was_queued:
            resources.interrupt_comfy(self._ctx.state.comfy_url)
        self._broadcast()
        return True

    def cancel_all(self) -> int:
        with self._lock:
            targets = [j for j in self._jobs if j.active]
            running = False
            for j in targets:
                j.cancel_requested = True
                if j.status == STATUS_QUEUED:
                    j.status = STATUS_CANCELLED
                    j.finished_at = time.time()
                else:
                    running = True
        if running:
            resources.interrupt_comfy(self._ctx.state.comfy_url)
        self._broadcast()
        return len(targets)

    def reorder(self, ids: list[str]) -> bool:
        """Reorder the *queued* jobs to match `ids`; running/finished ones stay put."""
        with self._lock:
            queued = [j for j in self._jobs if j.status == STATUS_QUEUED]
            by_id = {j.id: j for j in queued}
            ordered = [by_id[i] for i in ids if i in by_id]
            ordered += [j for j in queued if j.id not in set(ids)]
            it = iter(ordered)
            self._jobs = [next(it) if j.status == STATUS_QUEUED else j for j in self._jobs]
        self._broadcast()
        return True

    def set_paused(self, paused: bool) -> None:
        self._paused = bool(paused)
        if not self._paused:
            self._wake.set()
        self._broadcast()

    def clear_finished(self) -> None:
        with self._lock:
            self._jobs = [j for j in self._jobs if j.active]
        self._broadcast()

    # --- worker -----------------------------------------------------------

    def _worker(self) -> None:
        while True:
            job = None
            with self._lock:
                if not self._paused:
                    job = next((j for j in self._jobs if j.status == STATUS_QUEUED), None)
                    if job is not None:
                        job.status = STATUS_RUNNING
                        job.started_at = time.time()
            if job is None:
                self._wake.wait(timeout=2.0)
                self._wake.clear()
                continue
            self._broadcast()
            self._execute(job)

    def _execute(self, job: Job) -> None:
        runner = self._runners.get(job.kind)
        try:
            if runner is None:
                raise ResourceError(f'Unknown job kind: {job.kind}')
            runner(job)
            if job.cancel_requested:
                self._finish(job, STATUS_CANCELLED)
            else:
                self._finish(job, STATUS_DONE)
        except Exception as e:                       # noqa: BLE001 - surfaced to the UI
            if job.cancel_requested:
                self._finish(job, STATUS_CANCELLED)
            else:
                print(f'[job {job.id}] failed: {e}', flush=True)
                job.error = str(e)
                self._finish(job, STATUS_FAILED)

    def _finish(self, job: Job, status: str) -> None:
        job.status = status
        job.finished_at = time.time()
        job.progress = {}
        self._broadcast()

    # --- runners ----------------------------------------------------------

    def _run_comfy(self, job: Job) -> None:
        """Plain ComfyUI batch: Send / Send to front / Outpaint / Upscale."""
        prompts: list[dict] = job.payload.get('prompts') or []
        if not prompts:
            raise ResourceError('Job has no prompts')
        self._comfy_phase(job, prompts, [dict(p.get('workflow') or {}) for p in prompts])

    def _comfy_phase(self, job: Job, prompts: list[dict], workflows: list[dict]) -> None:
        """Render `workflows` in ComfyUI, honouring every resource invariant.

        The whole batch is submitted at once (ComfyUI pipelines it far better than
        one-at-a-time), then we wait for every prompt before the job counts as done —
        which is what keeps the *next* job from starting while the GPU is still busy.
        """
        st = self._ctx.state
        cu = st.comfy_url.rstrip('/')
        payload = job.payload
        cancelled = lambda: job.cancel_requested       # noqa: E731

        self._step(job, 'Checking ComfyUI…')
        resources.ensure_comfy(cu, st.run_comfy_command,
                               auto_start=st.jobs_auto_start, should_cancel=cancelled)
        if cancelled():
            return

        self._step(job, 'Waiting for ComfyUI to be idle…')
        resources.wait_comfy_idle(cu, force_clear=st.jobs_force_clear_comfy, should_cancel=cancelled)
        if cancelled():
            return

        self._step(job, 'Freeing LM Studio memory…')
        resources.unload_all_lm_models(st.lmstudio_url)

        upload = payload.get('upload') or {}
        if upload.get('path'):
            # Uploaded here rather than in the browser, so the operation doesn't
            # require ComfyUI to have been running when the dialog was used.
            self._step(job, 'Uploading source image…')
            uploaded = resources.upload_image(cu, self._ctx.resolve_path(upload['path']))
            # The node id is per-prompt: graphs differ when dictionary-triggered
            # LoRAs are injected, which shifts the generated node ids.
            for wf, prompt in zip(workflows, prompts):
                node_id = prompt.get('uploadNodeId') or upload.get('nodeId')
                if node_id and node_id in wf:
                    wf[node_id] = {**wf[node_id],
                                   'inputs': {**wf[node_id].get('inputs', {}), 'image': uploaded}}
        if cancelled():
            return

        front = bool(payload.get('front'))
        record_steps = bool(payload.get('recordSteps'))
        prompt_ids: list[str] = []
        for i, wf in enumerate(workflows, 1):
            if cancelled():
                return
            self._step(job, f'Submitting {i}/{len(workflows)}…', i / len(workflows))
            pid = resources.submit_prompt(cu, wf, front=front)
            prompt_ids.append(pid)
            if record_steps:
                # Arm before the render starts: frames stream in as it samples.
                self._previews().start_recording(pid)

        # Graphs accepted by ComfyUI — locally we're done, the GPU is not.
        job.status = STATUS_PROCESSED
        self._broadcast()

        copy_result = bool(payload.get('copyResult'))
        filenames: list[str] = []
        for i, pid in enumerate(prompt_ids, 1):
            if cancelled():
                return
            self._step(job, f'Generating {i}/{len(prompt_ids)}…', (i - 1) / len(prompt_ids))
            entry = resources.wait_for_prompt(cu, pid, should_cancel=cancelled)
            if entry is None:
                if cancelled():
                    return
                raise ResourceError('ComfyUI did not report a result for one of the prompts.')
            if copy_result:
                filenames.extend(self._ctx.copy_history_outputs(cu, entry))
            if record_steps:
                job.result.setdefault('steps', []).extend(self._write_step_review(pid, entry))
        job.result['filenames'] = filenames

    @staticmethod
    def _previews():
        # Imported here rather than at module scope: background.py already imports
        # from this package, and a top-level import would close the cycle.
        from .background import PREVIEWS
        return PREVIEWS

    def _write_step_review(self, prompt_id: str, entry: dict) -> list[str]:
        """Turn a prompt's captured step frames into a sheet and an animation.

        Named after the rendered image so the two land beside it, and returns the
        relative names for the job result. Never raises: a failed review must not
        fail a render that already succeeded.
        """
        frames = self._previews().take_recording(prompt_id)
        if not frames:
            return []
        try:
            stem = None
            for node_output in (entry.get('outputs') or {}).values():
                for img in node_output.get('images', []):
                    if img.get('type') == 'output':
                        stem = Path(img['filename']).stem
                        break
                if stem:
                    break
            stem = stem or f'prompt_{prompt_id[:8]}'

            out_dir = self._ctx.state.root_resolved / STEPS_DIR
            written = []
            sheet = previews.write_step_sheet(frames, out_dir / f'{stem}_steps.jpg')
            if sheet:
                written.append(f'{STEPS_DIR}/{sheet.name}')
            anim = previews.write_step_animation(frames, out_dir / f'{stem}_steps.webp')
            if anim:
                written.append(f'{STEPS_DIR}/{anim.name}')
            return written
        except Exception as e:
            print(f'[warn] step review failed for {prompt_id}: {e}', flush=True)
            return []

    def _run_improve_send(self, job: Job) -> None:
        """"Improve then send": have the LLM enrich each prompt, then render them all.

        The graphs arrive already built with the original prompt text; we only swap
        `promptNodeId`'s text for the improved version, so none of the graph-building
        logic has to be duplicated here.
        """
        st = self._ctx.state
        prompts: list[dict] = job.payload.get('prompts') or []
        if not prompts:
            raise ResourceError('Job has no prompts')
        workflows = [dict(p.get('workflow') or {}) for p in prompts]
        model = job.payload.get('lmModel') or ''
        cancelled = lambda: job.cancel_requested       # noqa: E731

        self._step(job, 'Checking LM Studio…')
        resources.ensure_lmstudio(st.lmstudio_url, st.run_lmstudio_command,
                                  auto_start=st.jobs_auto_start, should_cancel=cancelled)
        self._step(job, 'Freeing ComfyUI memory…')
        resources.free_comfy_memory(st.comfy_url)

        total = len(prompts)
        for i, (prompt, wf) in enumerate(zip(prompts, workflows), 1):
            if cancelled():
                return
            text = (prompt.get('promptText') or '').strip()
            node_id = prompt.get('promptNodeId')
            if not text or not node_id or node_id not in wf:
                continue
            self._step(job, f'Improving prompt {i}/{total}…', (i - 1) / total)
            improved = lmstudio.complete(
                st.lmstudio_url, model,
                f'{prompts_text.IMPROVE_PROMPT_INSTRUCTION}\n\n{text}',
                timeout=LMS_COMPLETION_TIMEOUT).strip()
            if improved:
                self._patch_text(wf, node_id, improved)

        # _comfy_phase unloads LM Studio again before it submits.
        self._comfy_phase(job, prompts, workflows)

    def _run_synopsis(self, job: Job) -> None:
        """Synopsis to illustrations, queued instead of driven from the dialog.

        Two LLM stages with an unload between them, since the storyteller and the
        illustrator are usually different models and can't be resident together.
        Produces `result['story']` and `result['prompts']` for the dialog to show.
        """
        st = self._ctx.state
        p = job.payload
        model_story = p.get('storytellerModel') or ''
        model_illus = p.get('illustratorModel') or ''
        min_n = max(0, int(p.get('minImages') or 0))
        max_n = max(0, int(p.get('maxImages') or 0))
        if min_n and max_n and min_n > max_n:
            min_n, max_n = max_n, min_n
        story = (p.get('story') or '').strip()
        synopsis = (p.get('synopsis') or '').strip()
        cancelled = lambda: job.cancel_requested       # noqa: E731

        self._step(job, 'Checking LM Studio…')
        resources.ensure_lmstudio(st.lmstudio_url, st.run_lmstudio_command,
                                  auto_start=st.jobs_auto_start, should_cancel=cancelled)
        self._step(job, 'Freeing ComfyUI memory…')
        resources.free_comfy_memory(st.comfy_url)

        # The story is optional input: skip this stage when one was supplied.
        if not story:
            if not synopsis:
                raise ResourceError('Provide a synopsis or a story.')
            self._step(job, 'Writing the story…', 0.2)
            story = lmstudio.complete(
                st.lmstudio_url, model_story,
                prompts_text.STORY_INSTRUCTION + synopsis,
                timeout=LMS_COMPLETION_TIMEOUT).strip()
            job.result['story'] = story
            self._broadcast()
            if cancelled():
                return
            # Different model next — free the storyteller's VRAM first.
            self._step(job, 'Unloading the storyteller…', 0.5)
            resources.unload_all_lm_models(st.lmstudio_url)
        job.result['story'] = story

        self._step(job, 'Writing illustration prompts…', 0.7)
        raw = lmstudio.complete(
            st.lmstudio_url, model_illus,
            prompts_text.illustrator_instruction(story, p.get('style') or '', min_n, max_n),
            timeout=LMS_COMPLETION_TIMEOUT)
        parts = prompts_text.split_illustrations(raw)
        if max_n > 0:
            parts = parts[:max_n]
        job.result['prompts'] = parts
        if not parts:
            raise ResourceError('The illustrator model returned no prompts.')

        self._step(job, 'Unloading LLM models…', 1.0)
        resources.unload_all_lm_models(st.lmstudio_url)

    def _run_guided(self, job: Job) -> None:
        """Guided generation: improve -> render -> have a vision model judge the image
        -> refine -> repeat, until it matches or the iteration budget runs out.

        Lifted from the Angular dialog so the loop keeps running with the dialog (or
        the whole tab) closed; the dialog now just watches `result['iterations']`.
        """
        st = self._ctx.state
        cu = st.comfy_url.rstrip('/')
        p = job.payload
        prompt_spec = p.get('prompt') or {}
        base_workflow = prompt_spec.get('workflow') or {}
        prompt_node = prompt_spec.get('promptNodeId')
        seed_node = prompt_spec.get('seedNodeId')
        model = p.get('lmModel') or ''
        base_prompt = p.get('basePrompt') or ''
        max_iterations = max(1, min(50, int(p.get('maxIterations') or 5)))
        randomize_every = max(0, int(p.get('randomizeEvery') or 0))
        cancelled = lambda: job.cancel_requested       # noqa: E731

        job.result['iterations'] = []
        prompt = base_prompt
        seed_override: int | None = None

        self._step(job, 'Checking LM Studio…')
        resources.ensure_lmstudio(st.lmstudio_url, st.run_lmstudio_command,
                                  auto_start=st.jobs_auto_start, should_cancel=cancelled)
        resources.free_comfy_memory(cu)

        if p.get('improve') and prompt.strip():
            self._step(job, 'Improving prompt…')
            improved = lmstudio.complete(
                st.lmstudio_url, model,
                f'{prompts_text.GUIDED_IMPROVE_INSTRUCTION}\n\n{prompt}',
                timeout=LMS_COMPLETION_TIMEOUT).strip()
            prompt = improved or prompt
        if cancelled():
            return

        for i in range(1, max_iterations + 1):
            if cancelled():
                return
            if randomize_every > 0 and (i - 1) % randomize_every == 0:
                seed_override = random.randrange(2 ** 32)

            iteration = {'n': i, 'prompt': prompt, 'status': 'generating'}
            job.result['iterations'].append(iteration)

            # --- render -------------------------------------------------
            self._step(job, f'Iteration {i}/{max_iterations} — freeing LM Studio…', (i - 1) / max_iterations)
            resources.unload_all_lm_models(st.lmstudio_url)
            resources.ensure_comfy(cu, st.run_comfy_command,
                                   auto_start=st.jobs_auto_start, should_cancel=cancelled)
            resources.wait_comfy_idle(cu, force_clear=st.jobs_force_clear_comfy, should_cancel=cancelled)
            if cancelled():
                return

            wf = dict(base_workflow)
            if prompt_node:
                self._patch_text(wf, prompt_node, prompt)
            if seed_node and seed_override is not None:
                self._patch_seed(wf, seed_node, seed_override)

            self._step(job, f'Iteration {i}/{max_iterations} — generating…', (i - 1) / max_iterations)
            job.status = STATUS_PROCESSED
            prompt_id = resources.submit_prompt(cu, wf)
            entry = resources.wait_for_prompt(cu, prompt_id, should_cancel=cancelled)
            job.status = STATUS_RUNNING
            if entry is None:
                if cancelled():
                    return
                raise ResourceError('ComfyUI did not report a result for the guided render.')
            # Always copied: the evaluator needs the file on disk to look at.
            files = self._ctx.copy_history_outputs(cu, entry)
            if not files:
                raise ResourceError('ComfyUI produced no image — check the ComfyUI console.')
            image = files[0]
            iteration.update(image=image, status='evaluating')
            job.result.setdefault('filenames', []).append(image)
            self._broadcast()

            # --- judge --------------------------------------------------
            self._step(job, f'Iteration {i}/{max_iterations} — evaluating…', (i - 0.5) / max_iterations)
            resources.free_comfy_memory(cu)
            resources.ensure_lmstudio(st.lmstudio_url, st.run_lmstudio_command,
                                      auto_start=st.jobs_auto_start, should_cancel=cancelled)
            if cancelled():
                return
            # Judged against the *original* prompt, not the refined one, so drift
            # across iterations can't quietly redefine success.
            verdict = prompts_text.parse_verdict(lmstudio.complete(
                st.lmstudio_url, model, prompts_text.eval_instruction(base_prompt),
                image_data_url=self._image_data_url(image),
                timeout=VISION_COMPLETION_TIMEOUT))
            iteration.update(match=verdict['match'], feedback=verdict['feedback'], status='done')
            self._broadcast()

            if verdict['match']:
                job.result['matched'] = True
                return

            # --- refine -------------------------------------------------
            self._step(job, f'Iteration {i}/{max_iterations} — refining prompt…', i / max_iterations)
            refined = self._refine(st.lmstudio_url, model, prompt, verdict)
            if cancelled():
                return
            if prompts_text.is_unchanged(refined, prompt):
                # The model wouldn't reword it — vary the image instead, so the next
                # attempt at least differs.
                seed_override = random.randrange(2 ** 32)
                iteration['feedback'] = (
                    f'{verdict["feedback"]} — prompt unchanged; randomized seed for the next try.')
            else:
                prompt = refined
            self._broadcast()

        job.result['matched'] = False

    def _refine(self, lms_url: str, model: str, prompt: str, verdict: dict) -> str:
        """Ask for a rewritten prompt, pushing once more if the model echoes it back."""
        def ask(insist: bool) -> str:
            try:
                return lmstudio.complete(
                    lms_url, model,
                    prompts_text.refine_instruction(prompt, verdict['feedback'],
                                                    verdict['corrected'], insist=insist),
                    timeout=LMS_COMPLETION_TIMEOUT).strip()
            except Exception:
                return ''

        refined = ask(False)
        if prompts_text.is_unchanged(refined, prompt):
            refined = ask(True)
        return refined or (verdict['corrected'] or '').strip() or prompt

    def _image_data_url(self, filename: str) -> str:
        path = self._ctx.state.root_resolved / Path(filename).name
        mime = mimetypes.guess_type(str(path))[0] or 'image/png'
        b64 = base64.b64encode(path.read_bytes()).decode('ascii')
        return f'data:{mime};base64,{b64}'

    @staticmethod
    def _patch_text(wf: dict, node_id: str, text: str) -> None:
        if node_id in wf:
            wf[node_id] = {**wf[node_id], 'inputs': {**wf[node_id].get('inputs', {}), 'text': text}}

    @staticmethod
    def _patch_seed(wf: dict, node_id: str, seed: int) -> None:
        if node_id in wf:
            wf[node_id] = {**wf[node_id], 'inputs': {**wf[node_id].get('inputs', {}), 'seed': seed}}

    # --- helpers ----------------------------------------------------------

    def _step(self, job: Job, step: str, pct: float | None = None) -> None:
        job.progress = {'step': step, 'pct': pct}
        self._broadcast()

    def _trim(self) -> None:
        """Keep the finished tail bounded (called with the lock held)."""
        finished = [j for j in self._jobs if not j.active]
        if len(finished) > MAX_FINISHED:
            drop = {id(j) for j in finished[:len(finished) - MAX_FINISHED]}
            self._jobs = [j for j in self._jobs if id(j) not in drop]

    def _broadcast(self) -> None:
        try:
            self._ctx.broadcast(self.snapshot())
        except Exception:
            pass
