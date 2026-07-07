#!/usr/bin/env python3
"""Generate images from a saved collection flow (.json) via ComfyUI.

A collection flow document has the shape:
    { "flow": { <ComfyUI workflow> }, "dictionaries": { "<name>": [ {value, weight}, ... ] } }

Usage:
    python generate_from_collection.py <path_to_json> <jobs_number> <out_path>

Example:
    python generate_from_collection.py ./collection/name/set/test.json 14 f:\\temp

For every job the {{tokens}} in the prompts and the seed are re-randomized, and
jobs run one at a time (each is submitted and waited for before the next).

Set COMFY_URL to target a non-default ComfyUI (default http://127.0.0.1:8188).
"""
from __future__ import annotations

import base64
import json
import os
import random
import re
import socket
import struct
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import requests

COMFY = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
TOKEN = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")


def pick_weighted(values: list[dict]) -> str:
    """Weighted-random value; uniform when no positive weights are defined."""
    positive = [v for v in values if (v.get("weight") or 0) > 0]
    pool = positive or values
    if not pool:
        return ""
    if not positive:
        return random.choice(pool).get("value", "")
    total = sum(v["weight"] for v in pool)
    r = random.uniform(0, total)
    for v in pool:
        r -= v["weight"]
        if r < 0:
            return v.get("value", "")
    return pool[-1].get("value", "")


def substitute(text: str, dictionaries: dict[str, list[dict]]) -> str:
    """Resolve {{name}} (weighted dictionary) and {{a|b|c}} (equal-random) tokens."""
    if not text:
        return text
    by_name = {k.strip().lower(): v for k, v in dictionaries.items()}

    def repl(m: re.Match) -> str:
        raw = m.group(1)
        if "|" in raw:
            opts = [o.strip() for o in raw.split("|") if o.strip()]
            return random.choice(opts) if opts else ""
        vals = by_name.get(raw.strip().lower())
        return pick_weighted(vals) if vals else ""

    out = TOKEN.sub(repl, text)
    out = re.sub(r"[ \t]{2,}", " ", out)
    out = re.sub(r" +([,.])", r"\1", out)
    return out.strip()


def resolve_clip_text(ref, wf: dict) -> str:
    """Follow a node reference chain until a CLIPTextEncode is found; return its text."""
    visited: set[str] = set()
    node_id = ref[0] if isinstance(ref, list) and ref else None
    while node_id and node_id not in visited:
        visited.add(node_id)
        node = wf.get(node_id)
        if not node:
            break
        if node.get("class_type") == "CLIPTextEncode":
            return node.get("inputs", {}).get("text", "")
        next_ref = next((v for v in (node.get("inputs") or {}).values() if isinstance(v, list)), None)
        node_id = next_ref[0] if next_ref else None
    return ""


def find_positive_prompt(wf: dict) -> str:
    """The sampler's resolved positive prompt text, for console logging."""
    sampler = next(
        (n for n in wf.values() if isinstance(n.get("inputs"), dict)
         and "steps" in n["inputs"] and "cfg" in n["inputs"]),
        None,
    )
    if not sampler:
        return ""
    return resolve_clip_text(sampler["inputs"].get("positive"), wf)


def prepare_job(flow: dict, dictionaries: dict[str, list[dict]]) -> tuple[dict, dict]:
    """A fresh workflow copy with prompts substituted and seeds randomized,
    plus a dict describing the choices made (for console logging)."""
    wf = json.loads(json.dumps(flow))
    info: dict = {"seed": None}
    for node in wf.values():
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if node.get("class_type") == "CLIPTextEncode" and isinstance(inputs.get("text"), str):
            inputs["text"] = substitute(inputs["text"], dictionaries)
        for key in ("seed", "noise_seed"):
            if key in inputs:
                inputs[key] = random.randint(0, 2 ** 32 - 1)
                if "steps" in inputs and "cfg" in inputs:
                    info["seed"] = inputs[key]
    info["prompt_text"] = find_positive_prompt(wf)
    return wf, info


def submit(wf: dict, client_id: str) -> str:
    resp = requests.post(f"{COMFY}/prompt", json={"prompt": wf, "client_id": client_id}, timeout=30)
    if resp.status_code != 200:
        try:
            detail = resp.json()
        except Exception:
            detail = resp.text
        raise RuntimeError(f"ComfyUI rejected the prompt: {detail}")
    return resp.json()["prompt_id"]


def wait_for_history(prompt_id: str, timeout: float = 1800) -> dict:
    """Poll /history until the job appears (completed), then return its entry."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            history = requests.get(f"{COMFY}/history/{prompt_id}", timeout=30).json()
        except Exception:
            history = {}
        if prompt_id in history:
            return history[prompt_id]
        time.sleep(1)
    raise TimeoutError(f"job {prompt_id} did not finish within {timeout}s")


def save_outputs(entry: dict, out_dir: Path, index: int) -> list[str]:
    saved: list[str] = []
    for node_out in entry.get("outputs", {}).values():
        for i, img in enumerate(node_out.get("images", [])):
            params = {
                "filename": img["filename"],
                "subfolder": img.get("subfolder", ""),
                "type": img.get("type", "output"),
            }
            data = requests.get(f"{COMFY}/view", params=params, timeout=60).content
            dest = out_dir / f"job{index:03d}_{i}_{img['filename']}"
            dest.write_bytes(data)
            saved.append(str(dest))
    return saved


# --- minimal WebSocket client (for live progress, stdlib only) -------------
def ws_connect(host: str, client_id: str, timeout: float = 5):
    """Open a ComfyUI progress WebSocket. Returns a connected socket or None."""
    p = urlparse(host)
    hostname = p.hostname or "127.0.0.1"
    port = p.port or 8188
    try:
        sock = socket.create_connection((hostname, port), timeout=timeout)
    except OSError:
        return None
    key = base64.b64encode(os.urandom(16)).decode()
    handshake = (
        f"GET /ws?clientId={client_id} HTTP/1.1\r\n"
        f"Host: {hostname}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    sock.sendall(handshake.encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        chunk = sock.recv(1024)
        if not chunk:
            return None
        resp += chunk
    if b"101" not in resp.split(b"\r\n", 1)[0]:
        return None
    sock.settimeout(None)
    return sock


def ws_recv(sock):
    """Read one WebSocket frame. Returns (opcode, payload_bytes)."""
    def recvn(n):
        data = b""
        while len(data) < n:
            chunk = sock.recv(n - len(data))
            if not chunk:
                raise ConnectionError("WebSocket closed")
            data += chunk
        return data

    b1, b2 = recvn(2)
    opcode = b1 & 0x0F
    masked = b2 & 0x80
    length = b2 & 0x7F
    if length == 126:
        length = struct.unpack(">H", recvn(2))[0]
    elif length == 127:
        length = struct.unpack(">Q", recvn(8))[0]
    mask = recvn(4) if masked else b""
    payload = recvn(length)
    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload


def wait_with_progress(sock, prompt_id: str) -> bool:
    """Consume WebSocket messages, render a step progress bar, return when the
    given prompt_id finishes executing. Returns False if the socket dies."""
    last_max = 0
    try:
        while True:
            opcode, payload = ws_recv(sock)
            if opcode == 0x8:        # close
                return False
            if opcode == 0x9:        # ping
                continue
            if opcode != 0x1:        # binary preview frames, etc.
                continue
            msg = json.loads(payload)
            mtype = msg.get("type")
            data = msg.get("data", {}) or {}
            if data.get("prompt_id") not in (None, prompt_id):
                continue
            if mtype == "progress":
                val, mx = data.get("value", 0), data.get("max", 0)
                last_max = mx or last_max
                if mx:
                    filled = int(30 * val / mx)
                    bar = "#" * filled + "-" * (30 - filled)
                    sys.stdout.write(f"\r    [{bar}] {val}/{mx} steps")
                    sys.stdout.flush()
            elif mtype == "executing" and data.get("node") is None \
                    and data.get("prompt_id") == prompt_id:
                if last_max:
                    sys.stdout.write("\n")
                return True
    except (ConnectionError, OSError):
        return False


def main() -> None:
    if len(sys.argv) < 4:
        print("Usage: python generate_from_collection.py <path_to_json> <jobs_number> <out_path>")
        sys.exit(1)

    json_path = Path(sys.argv[1])
    try:
        jobs = int(sys.argv[2])
    except ValueError:
        print(f"jobs_number must be an integer, got '{sys.argv[2]}'")
        sys.exit(1)
    out_dir = Path(sys.argv[3])

    if not json_path.is_file():
        print(f"Not a file: {json_path}")
        sys.exit(1)
    if jobs <= 0:
        print("Nothing to do (jobs_number <= 0).")
        return
    out_dir.mkdir(parents=True, exist_ok=True)

    doc = json.loads(json_path.read_text(encoding="utf-8"))
    flow = doc["flow"] if isinstance(doc, dict) and "flow" in doc else doc
    dictionaries = doc.get("dictionaries", {}) if isinstance(doc, dict) else {}
    if not isinstance(flow, dict) or not flow:
        print("No workflow found in the .json (expected a 'flow' object).")
        sys.exit(1)

    client_id = str(uuid.uuid4())
    print(f"ComfyUI: {COMFY}  |  jobs: {jobs}  |  out: {out_dir}")

    ws = ws_connect(COMFY, client_id)
    if ws is None:
        print("(progress WebSocket unavailable; falling back to polling)")

    for i in range(1, jobs + 1):
        wf, info = prepare_job(flow, dictionaries)
        print(f"\n[{i}/{jobs}] seed={info['seed']}")
        print("    prompt:")
        for line in (info["prompt_text"] or "(empty)").splitlines():
            print(f"      {line}")

        try:
            prompt_id = submit(wf, client_id)
        except Exception as e:
            print(f"    ERROR: submit failed: {e}")
            continue
        print(f"    queued as {prompt_id}")

        if ws is not None and not wait_with_progress(ws, prompt_id):
            ws = None  # socket died; fall back to polling for the rest

        try:
            entry = wait_for_history(prompt_id)
        except TimeoutError as e:
            print(f"    WARNING: {e}")
            continue

        status = entry.get("status", {}).get("status_str", "")
        if status and status != "success":
            print(f"    WARNING: status={status}")

        saved = save_outputs(entry, out_dir, i)
        if not saved:
            print("    WARNING: no images returned.")
        for dest in saved:
            print(f"    saved {dest}")

    if ws is not None:
        try:
            ws.close()
        except OSError:
            pass
    print(f"\nDone. Images in {out_dir}")


if __name__ == "__main__":
    main()
