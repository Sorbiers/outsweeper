"""Job-queue worker tests against a stub ComfyUI — no GPU, no real services.

Verifies the invariants the queue exists to guarantee: jobs run strictly one at a
time, each waits for ComfyUI's queue to drain, LM Studio is unloaded before every
submit, statuses walk queued->running->processed->done, and reorder/cancel work.
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server import create_app                      # noqa: E402
from server import resources as job_resources      # noqa: E402


class StubComfy:
    """Minimal ComfyUI: accepts prompts, reports a queue depth, then history.

    `render_seconds` keeps each submitted prompt "in the queue" for a while so the
    test can prove the worker actually waits instead of racing ahead.
    """

    def __init__(self, render_seconds: float = 0.4):
        self.render_seconds = render_seconds
        self.events: list[tuple[str, float]] = []   # (label, timestamp)
        self.lock = threading.Lock()
        self._submitted: dict[str, float] = {}      # prompt_id -> finish time
        self._n = 0
        self.free_calls = 0
        self.uploads = 0
        self.submitted_workflows: list = []
        self.timeline: list | None = None   # shared ordering log, when a test wants one

        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, obj, code=200):
                body = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                if self.path.startswith('/view'):
                    png = (b'\x89PNG\r\n\x1a\n' + b'\x00' * 32)
                    self.send_response(200)
                    self.send_header('Content-Type', 'image/png')
                    self.send_header('Content-Length', str(len(png)))
                    self.end_headers()
                    self.wfile.write(png)
                    return
                if self.path.startswith('/system_stats'):
                    return self._json({'system': {}})
                if self.path.startswith('/queue'):
                    return self._json({'queue_running': [], 'queue_pending': stub._pending()})
                if self.path.startswith('/history/'):
                    pid = self.path.rsplit('/', 1)[-1]
                    return self._json(stub._history(pid))
                return self._json({})

            def do_POST(self):
                length = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(length)
                if self.path.startswith('/upload/image'):
                    with stub.lock:
                        stub.uploads += 1
                    return self._json({'name': 'uploaded_source.png'})
                if self.path.startswith('/prompt'):
                    try:
                        stub.submitted_workflows.append(json.loads(raw).get('prompt'))
                    except Exception:
                        stub.submitted_workflows.append(None)
                    return self._json({'prompt_id': stub._submit()})
                if self.path.startswith('/free'):
                    with stub.lock:
                        stub.free_calls += 1
                        stub.events.append(('comfy_free', time.time()))
                    return self._json({'ok': True})
                return self._json({'ok': True})

        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.server.server_address[1]
        self.url = f'http://127.0.0.1:{self.port}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def _submit(self) -> str:
        with self.lock:
            self._n += 1
            pid = f'p{self._n}'
            self._submitted[pid] = time.time() + self.render_seconds
            self.events.append((f'submit:{pid}', time.time()))
            if self.timeline is not None:
                self.timeline.append('submit')
            return pid

    def _pending(self) -> list:
        now = time.time()
        with self.lock:
            return [[0, pid] for pid, done in self._submitted.items() if done > now]

    def _history(self, pid: str) -> dict:
        with self.lock:
            done = self._submitted.get(pid)
        if done is None or done > time.time():
            return {}
        return {pid: {'status': {'status_str': 'success'},
                      'outputs': {'9': {'images': [{'filename': f'{pid}.png',
                                                    'subfolder': '', 'type': 'output'}]}}}}

    def stop(self):
        self.server.shutdown()


class StubLmStudio:
    """Minimal LM Studio speaking the native streaming /api/v1/chat protocol.

    Replies are chosen from the instruction text, so one stub serves all three
    roles the guided loop needs: improve, judge, refine.
    """

    def __init__(self, verdicts: list[bool] | None = None):
        self.verdicts = list(verdicts or [])
        self.calls: list[str] = []          # 'improve' | 'eval' | 'refine'
        self.lock = threading.Lock()
        self.timeline: list | None = None   # shared ordering log, when a test wants one
        self._refines = 0
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                body = json.dumps({'models': [{'key': 'm', 'loaded_instances': []}]}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                length = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(length)
                if not self.path.startswith('/api/v1/chat'):
                    return self._plain({'ok': True})
                text = json.dumps(json.loads(raw or b'{}').get('input', ''))
                reply, kind = stub._reply_for(text)
                events = (
                    'event: chat.start\n'
                    'data: {"type":"chat.start","model_instance_id":"m"}\n\n'
                    'event: chat.end\n'
                    'data: ' + json.dumps({'type': 'chat.end',
                                           'result': {'output': [{'type': 'message',
                                                                  'content': reply}]}}) + '\n\n'
                ).encode()
                with stub.lock:
                    stub.calls.append(kind)
                    if stub.timeline is not None:
                        stub.timeline.append('llm')
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(events)))
                self.end_headers()
                self.wfile.write(events)

            def _plain(self, obj):
                body = json.dumps(obj).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.server.server_address[1]
        self.url = f'http://127.0.0.1:{self.port}/v1'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def _reply_for(self, instruction: str) -> tuple[str, str]:
        if 'SYNOPSIS:' in instruction:
            return ('Once upon a time the knight rode out.', 'story')
        if 'text-to-image prompt writer' in instruction:
            return ('a knight riding out at dawn\n---\na dragon over the keep\n---\nthe duel', 'illustrate')
        if 'Reply ONLY with a JSON object' in instruction:
            with self.lock:
                match = self.verdicts.pop(0) if self.verdicts else True
            return (json.dumps({'match': match, 'feedback': 'missing the hat',
                                'corrected_prompt': ''}), 'eval')
        if 'REVISED prompt' in instruction:
            with self.lock:
                self._refines += 1
                n = self._refines
            return (f'refined prompt v{n}', 'refine')
        return ('improved prompt', 'improve')

    def stop(self):
        self.server.shutdown()


def make_app(comfy_url: str):
    tmp = tempfile.mkdtemp()
    app = create_app(tmp, {}, '__selected', '__dust',
                     comfy_url=comfy_url, jobs_widget_enabled=True, thumb_cache_days=0)
    return app, app.test_client()


def enqueue(client, title, n_prompts=1):
    prompts = [{'workflow': {'1': {'class_type': 'X', 'inputs': {}}}} for _ in range(n_prompts)]
    r = client.post('/api/jobs', json={'kind': 'comfy', 'title': title,
                                       'payload': {'prompts': prompts}})
    return r.get_json()['id']


def wait_until(pred, timeout=25.0, interval=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return True
        time.sleep(interval)
    return False


def jobs_by_id(client):
    return {j['id']: j for j in client.get('/api/jobs').get_json()['jobs']}


def test_serial_execution_and_status_walk():
    stub = StubComfy(render_seconds=0.4)
    unload_calls: list[float] = []
    orig_unload = job_resources.unload_all_lm_models
    job_resources.unload_all_lm_models = lambda url: unload_calls.append(time.time())
    try:
        app, client = make_app(stub.url)
        ids = [enqueue(client, f'job{i}') for i in range(3)]

        assert wait_until(lambda: all(jobs_by_id(client)[i]['status'] == 'done' for i in ids)), \
            f'jobs did not finish: {jobs_by_id(client)}'

        # Strictly one at a time: each job's start is after the previous job's finish.
        js = [jobs_by_id(client)[i] for i in ids]
        for prev, nxt in zip(js, js[1:]):
            assert nxt['started_at'] >= prev['finished_at'] - 0.05, \
                f'jobs overlapped: {prev} then {nxt}'

        # LM Studio unloaded once per job, before that job's submit.
        assert len(unload_calls) == 3, f'expected 3 unloads, got {len(unload_calls)}'
        submits = [t for label, t in stub.events if label.startswith('submit:')]
        assert len(submits) == 3
        for unload_t, submit_t in zip(unload_calls, submits):
            assert unload_t <= submit_t, 'LM Studio was not unloaded before submitting'
    finally:
        job_resources.unload_all_lm_models = orig_unload
        stub.stop()
    print('OK  serial execution, unload-before-submit, status walk')


def test_waits_for_comfy_queue_to_drain():
    """A prompt queued in ComfyUI by someone else must delay the job's submit."""
    stub = StubComfy(render_seconds=0.1)
    orig_unload = job_resources.unload_all_lm_models
    job_resources.unload_all_lm_models = lambda url: None
    try:
        app, client = make_app(stub.url)
        foreign = stub._submit()           # pretend ComfyUI already has work
        foreign_done = stub._submitted[foreign]

        enqueue(client, 'after-foreign')
        assert wait_until(lambda: all(j['status'] == 'done' for j in
                                      client.get('/api/jobs').get_json()['jobs']))
        ours = [t for label, t in stub.events if label.startswith('submit:') and label != f'submit:{foreign}']
        assert ours and ours[0] >= foreign_done - 0.05, \
            'job submitted while ComfyUI still had queued work'
    finally:
        job_resources.unload_all_lm_models = orig_unload
        stub.stop()
    print('OK  waits for ComfyUI queue to drain')


def test_reorder_changes_execution_order():
    stub = StubComfy(render_seconds=0.35)
    orig_unload = job_resources.unload_all_lm_models
    job_resources.unload_all_lm_models = lambda url: None
    try:
        app, client = make_app(stub.url)
        client.post('/api/jobs/pause', json={'paused': True})
        a, b, c_ = [enqueue(client, n) for n in ('a', 'b', 'c')]
        client.post('/api/jobs/reorder', json={'ids': [c_, b, a]})
        client.post('/api/jobs/pause', json={'paused': False})

        assert wait_until(lambda: all(j['status'] == 'done' for j in
                                      client.get('/api/jobs').get_json()['jobs']))
        finished = sorted(client.get('/api/jobs').get_json()['jobs'], key=lambda j: j['started_at'])
        assert [j['id'] for j in finished] == [c_, b, a], \
            f'reorder ignored: {[j["title"] for j in finished]}'
    finally:
        job_resources.unload_all_lm_models = orig_unload
        stub.stop()
    print('OK  reorder changes execution order')


def test_cancel_queued_and_running():
    stub = StubComfy(render_seconds=1.5)
    orig_unload = job_resources.unload_all_lm_models
    job_resources.unload_all_lm_models = lambda url: None
    try:
        app, client = make_app(stub.url)
        running = enqueue(client, 'running')
        queued = enqueue(client, 'queued')

        assert wait_until(lambda: jobs_by_id(client)[running]['status'] in ('running', 'processed'))
        client.post(f'/api/jobs/{queued}/cancel')
        assert jobs_by_id(client)[queued]['status'] == 'cancelled', 'queued job was not cancelled'

        client.post(f'/api/jobs/{running}/cancel')
        assert wait_until(lambda: jobs_by_id(client)[running]['status'] == 'cancelled'), \
            f"running job did not cancel: {jobs_by_id(client)[running]}"
    finally:
        job_resources.unload_all_lm_models = orig_unload
        stub.stop()
    print('OK  cancel works for queued and running jobs')


def test_processed_status_between_submit_and_images():
    """`processed` = graphs accepted by ComfyUI but images not rendered yet."""
    stub = StubComfy(render_seconds=1.2)
    orig_unload = job_resources.unload_all_lm_models
    job_resources.unload_all_lm_models = lambda url: None
    try:
        app, client = make_app(stub.url)
        jid = enqueue(client, 'slow', n_prompts=2)
        assert wait_until(lambda: jobs_by_id(client)[jid]['status'] == 'processed'), \
            'never observed the processed status'
        assert wait_until(lambda: jobs_by_id(client)[jid]['status'] == 'done')
    finally:
        job_resources.unload_all_lm_models = orig_unload
        stub.stop()
    print('OK  processed -> done observed for a slow render')


def test_source_image_uploaded_and_patched_per_prompt():
    """img2img/outpaint/upscale: the worker uploads the source at run time and swaps
    the placeholder for the real name in *each* graph (node ids differ per graph)."""
    stub = StubComfy(render_seconds=0.1)
    orig_unload = job_resources.unload_all_lm_models
    job_resources.unload_all_lm_models = lambda url: None
    try:
        tmp = tempfile.mkdtemp()
        (Path(tmp) / 'src.png').write_bytes(b'\x89PNG\r\n\x1a\n')   # any bytes will do
        app = create_app(tmp, {}, '__selected', '__dust',
                         comfy_url=stub.url, jobs_widget_enabled=True, thumb_cache_days=0)
        client = app.test_client()

        placeholder = '__pp_pending_upload__'
        client.post('/api/jobs', json={
            'kind': 'comfy', 'title': 'outpaint',
            'payload': {
                'upload': {'path': 'src.png'},
                'prompts': [
                    {'workflow': {'7': {'class_type': 'LoadImage', 'inputs': {'image': placeholder}}},
                     'uploadNodeId': '7'},
                    # a different graph shape -> a different node id for the same role
                    {'workflow': {'12': {'class_type': 'LoadImage', 'inputs': {'image': placeholder}}},
                     'uploadNodeId': '12'},
                ],
            }})

        assert wait_until(lambda: all(j['status'] == 'done' for j in
                                      client.get('/api/jobs').get_json()['jobs']))
        assert stub.uploads == 1, f'expected a single upload, got {stub.uploads}'
        assert len(stub.submitted_workflows) == 2
        names = [list(wf.values())[0]['inputs']['image'] for wf in stub.submitted_workflows]
        assert names == ['uploaded_source.png', 'uploaded_source.png'], \
            f'placeholder not patched in every graph: {names}'
    finally:
        job_resources.unload_all_lm_models = orig_unload
        stub.stop()
    print('OK  source image uploaded once and patched into each graph')


def _timeline_app(stub, lms, tmp=None):
    """App wired to both stubs, with the memory guards recording a shared timeline
    so the ordering of unload/free vs submit/LLM calls can be asserted."""
    timeline: list[str] = []
    orig_unload = job_resources.unload_all_lm_models
    orig_free = job_resources.free_comfy_memory

    def unload(url):
        timeline.append('unload_lm')

    def free(url):
        timeline.append('free_comfy')

    job_resources.unload_all_lm_models = unload
    job_resources.free_comfy_memory = free
    stub.timeline = timeline
    lms.timeline = timeline
    app = create_app(tmp or tempfile.mkdtemp(), {}, '__selected', '__dust',
                     comfy_url=stub.url, lmstudio_url=lms.url,
                     jobs_widget_enabled=True, thumb_cache_days=0)
    return app, app.test_client(), timeline, (orig_unload, orig_free)


def test_improve_then_send_job():
    """The LLM enriches each prompt, then the batch renders — one job, right order."""
    stub = StubComfy(render_seconds=0.1)
    lms = StubLmStudio()
    app, client, timeline, (orig_unload, orig_free) = _timeline_app(stub, lms)
    try:
        client.post('/api/jobs', json={
            'kind': 'improve_send', 'title': 'improve',
            'payload': {
                'lmModel': 'm',
                'prompts': [
                    {'workflow': {'5': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'a cat'}}},
                     'promptNodeId': '5', 'promptText': 'a cat'},
                    {'workflow': {'5': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'a dog'}}},
                     'promptNodeId': '5', 'promptText': 'a dog'},
                ],
            }})
        assert wait_until(lambda: all(j['status'] == 'done' for j in
                                      client.get('/api/jobs').get_json()['jobs'])), \
            client.get('/api/jobs').get_json()

        assert lms.calls == ['improve', 'improve'], f'unexpected LLM calls: {lms.calls}'
        texts = [list(wf.values())[0]['inputs']['text'] for wf in stub.submitted_workflows]
        assert texts == ['improved prompt', 'improved prompt'], \
            f'improved text was not patched into the graphs: {texts}'
        # ComfyUI memory freed for the LLM stage, LM Studio unloaded before rendering.
        assert timeline.index('free_comfy') < timeline.index('unload_lm')
    finally:
        job_resources.unload_all_lm_models = orig_unload
        job_resources.free_comfy_memory = orig_free
        stub.stop(); lms.stop()
    print('OK  improve_send enriches prompts then renders them')


def test_guided_loop_alternates_engines():
    """Guided: render -> judge -> refine, never with both engines loaded at once."""
    stub = StubComfy(render_seconds=0.1)
    lms = StubLmStudio(verdicts=[False, True])       # miss, then match
    app, client, timeline, (orig_unload, orig_free) = _timeline_app(stub, lms)
    try:
        client.post('/api/jobs', json={
            'kind': 'guided', 'title': 'guided',
            'payload': {
                'lmModel': 'm', 'basePrompt': 'a cat in a hat', 'improve': True,
                'maxIterations': 5, 'randomizeEvery': 0,
                'prompt': {
                    'workflow': {
                        '5': {'class_type': 'CLIPTextEncode', 'inputs': {'text': 'a cat in a hat'}},
                        '3': {'class_type': 'KSampler', 'inputs': {'steps': 20, 'cfg': 1, 'seed': 1}},
                    },
                    'promptNodeId': '5', 'seedNodeId': '3',
                },
            }})

        assert wait_until(lambda: all(j['status'] == 'done' for j in
                                      client.get('/api/jobs').get_json()['jobs']), timeout=40), \
            client.get('/api/jobs').get_json()

        jid = client.get('/api/jobs').get_json()['jobs'][0]['id']
        detail = client.get(f'/api/jobs/{jid}').get_json()
        iters = detail['result']['iterations']
        assert len(iters) == 2, f'expected 2 iterations, got {len(iters)}'
        assert iters[0]['match'] is False and iters[1]['match'] is True
        assert detail['result']['matched'] is True
        assert all(it.get('image') for it in iters), 'iterations missing rendered images'
        # Iteration 2 must use the refined prompt, not a repeat of iteration 1.
        assert iters[1]['prompt'] != iters[0]['prompt'], 'prompt was not refined between iterations'
        assert lms.calls == ['improve', 'eval', 'refine', 'eval'], f'unexpected LLM calls: {lms.calls}'

        # Mutual exclusion: whenever the engine in use *changes*, the other one's
        # memory must have been released in between. (Consecutive calls to the same
        # engine — e.g. judge then refine — legitimately need no release.)
        def released_between(i: int, j: int, marker: str) -> bool:
            return marker in timeline[i + 1:j]

        last_submit = last_llm = None
        for i, ev in enumerate(timeline):
            if ev == 'submit':
                if last_llm is not None:
                    assert released_between(last_llm, i, 'unload_lm'), \
                        f'rendered without unloading LM Studio first: {timeline}'
                last_submit = i
            elif ev == 'llm':
                if last_submit is not None:
                    assert released_between(last_submit, i, 'free_comfy'), \
                        f'called the LLM without freeing ComfyUI first: {timeline}'
                last_llm = i
    finally:
        job_resources.unload_all_lm_models = orig_unload
        job_resources.free_comfy_memory = orig_free
        stub.stop(); lms.stop()
    print('OK  guided loop alternates engines and refines between iterations')


def test_synopsis_job():
    """Synopsis -> story -> illustration prompts, queued rather than run in the dialog."""
    stub = StubComfy(render_seconds=0.1)
    lms = StubLmStudio()
    app, client, timeline, (orig_unload, orig_free) = _timeline_app(stub, lms)
    try:
        client.post('/api/jobs', json={
            'kind': 'synopsis', 'title': 'illustrations',
            'payload': {'synopsis': 'a knight fights a dragon', 'story': '',
                        'storytellerModel': 'a', 'illustratorModel': 'b',
                        'style': 'watercolour', 'minImages': 0, 'maxImages': 0}})
        assert wait_until(lambda: all(j['status'] == 'done' for j in
                                      client.get('/api/jobs').get_json()['jobs'])), \
            client.get('/api/jobs').get_json()

        jid = client.get('/api/jobs').get_json()['jobs'][0]['id']
        res = client.get(f'/api/jobs/{jid}').get_json()['result']
        assert res['story'].startswith('Once upon a time'), res
        assert res['prompts'] == ['a knight riding out at dawn', 'a dragon over the keep', 'the duel'], res
        assert lms.calls == ['story', 'illustrate'], lms.calls
        # ComfyUI released before the LLM work, storyteller unloaded before the illustrator.
        assert timeline.index('free_comfy') < timeline.index('llm')
        assert timeline.count('unload_lm') >= 2, f'storyteller not unloaded between stages: {timeline}'
    finally:
        job_resources.unload_all_lm_models = orig_unload
        job_resources.free_comfy_memory = orig_free
        stub.stop(); lms.stop()
    print('OK  synopsis job produces story + illustration prompts')


def test_synopsis_job_skips_story_when_supplied():
    """A pasted story skips the storyteller stage entirely."""
    stub = StubComfy(render_seconds=0.1)
    lms = StubLmStudio()
    app, client, timeline, (orig_unload, orig_free) = _timeline_app(stub, lms)
    try:
        client.post('/api/jobs', json={
            'kind': 'synopsis', 'title': 'illustrations',
            'payload': {'synopsis': '', 'story': 'My own pre-written story.',
                        'storytellerModel': 'a', 'illustratorModel': 'b',
                        'style': '', 'minImages': 0, 'maxImages': 2}})
        assert wait_until(lambda: all(j['status'] == 'done' for j in
                                      client.get('/api/jobs').get_json()['jobs']))
        jid = client.get('/api/jobs').get_json()['jobs'][0]['id']
        res = client.get(f'/api/jobs/{jid}').get_json()['result']
        assert lms.calls == ['illustrate'], f'storyteller should not run: {lms.calls}'
        assert res['story'] == 'My own pre-written story.'
        assert len(res['prompts']) == 2, f'maxImages not applied: {res["prompts"]}'
    finally:
        job_resources.unload_all_lm_models = orig_unload
        job_resources.free_comfy_memory = orig_free
        stub.stop(); lms.stop()
    print('OK  synopsis job honours a supplied story and the max bound')


def test_failure_surfaces_message():
    """No ComfyUI and no start command -> the job fails with a readable reason."""
    orig_unload = job_resources.unload_all_lm_models
    job_resources.unload_all_lm_models = lambda url: None
    try:
        app, client = make_app('http://127.0.0.1:9')   # nothing listening
        jid = enqueue(client, 'doomed')
        assert wait_until(lambda: jobs_by_id(client)[jid]['status'] == 'failed', timeout=30)
        err = jobs_by_id(client)[jid]['error'] or ''
        assert 'not running' in err and 'config.toml' in err, f'unhelpful error: {err!r}'
    finally:
        job_resources.unload_all_lm_models = orig_unload
    print('OK  unreachable ComfyUI fails with a clear message')


if __name__ == '__main__':
    test_serial_execution_and_status_walk()
    test_waits_for_comfy_queue_to_drain()
    test_reorder_changes_execution_order()
    test_cancel_queued_and_running()
    test_processed_status_between_submit_and_images()
    test_source_image_uploaded_and_patched_per_prompt()
    test_improve_then_send_job()
    test_guided_loop_alternates_engines()
    test_synopsis_job()
    test_synopsis_job_skips_story_when_supplied()
    test_failure_surfaces_message()
    print('\nall job-queue tests passed')


# ---------------------------------------------------------------------------
# Local upscaling as a queued job
# ---------------------------------------------------------------------------

def _upscale_app():
    """An app over a temp folder holding one image, plus a fake models dir."""
    tmp = Path(tempfile.mkdtemp())
    Image.new('RGB', (32, 24), (90, 120, 160)).save(tmp / 'src.png')
    models = Path(tempfile.mkdtemp())
    (models / 'fake.pth').write_bytes(b'not a real model')
    app = create_app(tmp, {}, '__selected', '__dust',
                     jobs_widget_enabled=True, thumb_cache_days=0,
                     upscale_models_dir=str(models))
    return app, app.test_client(), tmp, models


def test_interpolation_upscale_runs_as_a_job():
    """Pillow resampling: no engines involved, but still queued."""
    app, client, tmp, _ = _upscale_app()
    r = client.post('/api/jobs', json={
        'kind': 'upscale', 'title': 'up',
        'payload': {'method': 'interpolation', 'path': 'src.png',
                    'interpMethod': 'lanczos', 'scale': 2},
    })
    jid = r.get_json()['id']
    assert wait_until(lambda: jobs_by_id(client)[jid]['status'] in ('done', 'failed'))

    job = jobs_by_id(client)[jid]
    assert job['status'] == 'done', job.get('error')
    written = [p for p in tmp.iterdir() if p.name != 'src.png' and p.suffix == '.png']
    assert len(written) == 1
    with Image.open(written[0]) as im:
        assert im.size == (64, 48)          # 32x24 doubled


def test_upscale_job_frees_engines_before_using_the_gpu():
    """spandrel loads a model onto the GPU, so the other tenants go first."""
    app, client, tmp, models = _upscale_app()
    timeline = []
    orig_unload = job_resources.unload_all_lm_models
    orig_free = job_resources.free_comfy_memory
    job_resources.unload_all_lm_models = lambda url: timeline.append('unload_lm')
    job_resources.free_comfy_memory = lambda url: timeline.append('free_comfy')
    try:
        r = client.post('/api/jobs', json={
            'kind': 'upscale', 'title': 'up',
            'payload': {'method': 'spandrel', 'path': 'src.png',
                        'model': 'fake.pth', 'tile': 0},
        })
        jid = r.get_json()['id']
        # The fake model can't load, so the job fails — but only *after* the
        # engines were released, which is the invariant under test.
        assert wait_until(lambda: jobs_by_id(client)[jid]['status'] in ('done', 'failed'))
        assert timeline == ['unload_lm', 'free_comfy']
    finally:
        job_resources.unload_all_lm_models = orig_unload
        job_resources.free_comfy_memory = orig_free


def test_upscale_job_rejects_a_bad_method_and_a_missing_file():
    app, client, tmp, _ = _upscale_app()
    for payload, why in [
        ({'method': 'magic', 'path': 'src.png'}, 'unknown method'),
        ({'method': 'interpolation', 'path': 'ghost.png', 'scale': 2}, 'missing file'),
        ({'method': 'interpolation', 'path': 'src.png', 'scale': 99}, 'scale out of range'),
    ]:
        jid = client.post('/api/jobs', json={
            'kind': 'upscale', 'title': why, 'payload': payload}).get_json()['id']
        assert wait_until(lambda: jobs_by_id(client)[jid]['status'] in ('done', 'failed'))
        job = jobs_by_id(client)[jid]
        assert job['status'] == 'failed', f'{why} should fail, got {job["status"]}'
        assert job['error']


def test_upscale_model_dir_traversal_is_refused():
    app, client, tmp, _ = _upscale_app()
    jid = client.post('/api/jobs', json={
        'kind': 'upscale', 'title': 'escape',
        'payload': {'method': 'spandrel', 'path': 'src.png', 'model': '../outside.pth'},
    }).get_json()['id']
    assert wait_until(lambda: jobs_by_id(client)[jid]['status'] in ('done', 'failed'))
    assert jobs_by_id(client)[jid]['status'] == 'failed'
