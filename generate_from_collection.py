#!/usr/bin/env python3
"""Generate images from a saved collection flow (.json) via ComfyUI.

A collection flow document has the shape:
    { "flow": { <ComfyUI workflow> }, "dictionaries": { "<name>": [ {value, weight, lora?}, ... ] } }

Usage:
    python generate_from_collection.py <path_to_json> <jobs_number> <out_path>

Example:
    python generate_from_collection.py ./collection/name/set/test.json 14 f:\\temp

For every job the {{tokens}} in the prompts and the seed are re-randomized, and
jobs run one at a time (each is submitted and waited for before the next).
{{tokens}} may nest (a dictionary value may itself reference other dictionaries);
circular references are detected and dropped instead of looping. A value may
also carry a 'lora', which is injected into that job's workflow once if the
value is picked (deduped by name across the whole job).

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

# Hard cap on nesting depth, in case a chain of *distinct* dictionaries runs long.
MAX_DEPTH = 8


def pick_weighted_value(values: list[dict]) -> dict | None:
    """Weighted-random value dict. Values with weight <= 0 are temporarily disabled
    and never chosen; if every value is disabled, returns None (no substitution)."""
    pool = [v for v in values if (v.get("weight") or 0) > 0]
    if not pool:
        return None
    total = sum(v["weight"] for v in pool)
    r = random.uniform(0, total)
    for v in pool:
        r -= v["weight"]
        if r < 0:
            return v
    return pool[-1]


def substitute(text: str, dictionaries: dict[str, list[dict]], lora_sink: list[dict] | None = None) -> str:
    """Resolve every {{...}} placeholder:
      - {{a|b|c}} — pick one of the pipe-separated options at random (equal odds).
      - {{name}}  — pick a weighted-random value from the matching dictionary.
    A picked value is itself resolved, so dictionary values may reference other
    dictionaries (nested substitution). Unknown/empty dictionaries, empty option
    lists, and dictionary self-references (direct or via a cycle) are removed.

    When a picked value carries a 'lora', it's appended to lora_sink (if given) —
    callers can pass the same list across multiple substitute() calls (e.g.
    positive + negative prompt) to collect every LoRA triggered by one job.
    """
    if not text:
        return text
    if lora_sink is None:
        lora_sink = []
    by_name = {k.strip().lower(): v for k, v in dictionaries.items()}
    replaced = _resolve(text, by_name, set(), lora_sink)
    out = re.sub(r"[ \t]{2,}", " ", replaced)
    out = re.sub(r" +([,.])", r"\1", out)
    return out.strip()


def _resolve(text: str, by_name: dict[str, list[dict]], visited: set[str],
             lora_sink: list[dict], depth: int = 0) -> str:
    """Recursive resolver. `visited` holds dictionary names already expanded in the
    current chain, so a cycle (A -> B -> A) collapses to '' instead of looping."""
    if not text or depth >= MAX_DEPTH:
        return text

    def repl(m: re.Match) -> str:
        raw = m.group(1)
        if "|" in raw:
            opts = [o.strip() for o in raw.split("|") if o.strip()]
            if not opts:
                return ""
            return _resolve(random.choice(opts), by_name, visited, lora_sink, depth + 1)
        key = raw.strip().lower()
        if key in visited:
            print(f"[dictionaries] circular reference detected at {{{{{raw.strip()}}}}} -- skipped", file=sys.stderr)
            return ""
        vals = by_name.get(key)
        if not vals:
            return ""
        picked = pick_weighted_value(vals)
        if not picked:
            return ""
        lora = picked.get("lora")
        if lora and lora.get("name"):
            lora_sink.append(lora)
        return _resolve(picked.get("value", ""), by_name, visited | {key}, lora_sink, depth + 1)

    return TOKEN.sub(repl, text)


def dedupe_loras(lora_sink: list[dict]) -> list[dict]:
    """A LoRA is injected at most once per job, even if triggered by multiple picks."""
    seen: set[str] = set()
    out: list[dict] = []
    for lora in lora_sink:
        name = lora.get("name")
        if name and name not in seen:
            seen.add(name)
            out.append(lora)
    return out


def remove_empty_lora_nodes(wf: dict) -> dict:
    """Drop any LoraLoader node left with an empty lora_name, rewiring its
    consumers to the node's own model/clip source."""
    empty_ids = [
        nid for nid, n in wf.items()
        if n.get("class_type") == "LoraLoader" and not n.get("inputs", {}).get("lora_name")
    ]
    for node_id in empty_ids:
        model_input = wf[node_id]["inputs"].get("model")
        clip_input = wf[node_id]["inputs"].get("clip")
        for node in wf.values():
            inputs = node.get("inputs") or {}
            for key, val in list(inputs.items()):
                if isinstance(val, list) and val and val[0] == node_id:
                    inputs[key] = model_input if val[1] == 0 else clip_input
        del wf[node_id]
    return wf


def inject_loras(wf: dict, loras: list[dict]) -> dict:
    """Append a LoraLoader chain (model+clip) after the existing LoRA tail — or,
    with no existing LoRA, after the sampler's model and a CLIPTextEncode's clip —
    then rewire whatever consumed that source to read from the new chain's tail."""
    if not loras:
        return wf

    lora_ids = [nid for nid, n in wf.items() if n.get("class_type") == "LoraLoader"]

    if lora_ids:
        lora_id_set = set(lora_ids)
        tail_id = next(
            (nid for nid in lora_ids if not any(
                other != nid and (
                    (wf[other].get("inputs", {}).get("model") or [None])[0] == nid or
                    (wf[other].get("inputs", {}).get("clip") or [None])[0] == nid
                )
                for other in lora_id_set
            )),
            lora_ids[-1],
        )
        insert_after_model = [tail_id, 0]
        insert_after_clip = [tail_id, 1]
    else:
        # No existing LoRA: anchor to the live MODEL and CLIP sources so the LoRA
        # sits between them and their consumers.
        sampler = next(
            (n for n in wf.values()
             if isinstance(n.get("inputs", {}).get("model"), list)
             and "steps" in n.get("inputs", {}) and "cfg" in n.get("inputs", {})),
            None,
        )
        clip_enc = next(
            (n for n in wf.values()
             if n.get("class_type") == "CLIPTextEncode" and isinstance(n.get("inputs", {}).get("clip"), list)),
            None,
        )
        model_ref = sampler.get("inputs", {}).get("model") if sampler else None
        clip_ref = clip_enc.get("inputs", {}).get("clip") if clip_enc else None
        if not isinstance(model_ref, list) or not isinstance(clip_ref, list):
            return wf
        insert_after_model = list(model_ref)
        insert_after_clip = list(clip_ref)

    original_ids = set(wf.keys())
    numeric_ids = []
    for k in wf.keys():
        try:
            numeric_ids.append(int(k))
        except ValueError:
            pass
    max_id = max(numeric_ids + [100])

    prev_model = list(insert_after_model)
    prev_clip = list(insert_after_clip)

    for lora in loras:
        max_id += 1
        new_id = str(max_id)
        wf[new_id] = {
            "class_type": "LoraLoader",
            "inputs": {
                "lora_name": lora.get("name"),
                "strength_model": lora.get("strengthModel", 1),
                "strength_clip": lora.get("strengthClip", 1),
                "model": list(prev_model),
                "clip": list(prev_clip),
            },
        }
        prev_model = [new_id, 0]
        prev_clip = [new_id, 1]

    for node_id in original_ids:
        inputs = wf[node_id].get("inputs") or {}
        for key, val in list(inputs.items()):
            if isinstance(val, list) and len(val) == 2:
                if val[0] == insert_after_model[0] and val[1] == insert_after_model[1]:
                    inputs[key] = list(prev_model)
                elif val[0] == insert_after_clip[0] and val[1] == insert_after_clip[1]:
                    inputs[key] = list(prev_clip)

    return wf


def normalize_lora_clip(wf: dict) -> dict:
    """Repair the CLIP wiring of a Model-and-CLIP LoRA chain so the LoRA's clip
    comes from the real CLIP loader (DualCLIPLoader for Flux, else the checkpoint)
    and the prompt encoders read the LoRA chain's clip output. Idempotent."""
    entries = list(wf.items())
    loras = [
        (nid, n) for nid, n in entries
        if n.get("class_type") == "LoraLoader"
        and isinstance(n.get("inputs", {}).get("clip"), list)
        and isinstance(n.get("inputs", {}).get("model"), list)
    ]
    if not loras:
        return wf
    lora_ids = {nid for nid, _ in loras}

    clip_loader = next(
        ((nid, n) for nid, n in entries if n.get("class_type") in ("DualCLIPLoader", "CLIPLoader")), None,
    )
    checkpoint = next(
        ((nid, n) for nid, n in entries if n.get("class_type") == "CheckpointLoaderSimple"), None,
    )
    clip_source = [clip_loader[0], 0] if clip_loader else ([checkpoint[0], 1] if checkpoint else None)
    if not clip_source:
        return wf

    head = next((item for item in loras if item[1]["inputs"]["clip"][0] not in lora_ids), None)
    tail = next(
        (item for item in loras
         if not any(oid != item[0] and on["inputs"]["clip"][0] == item[0] for oid, on in loras)),
        None,
    )
    if not head or not tail:
        return wf

    head[1]["inputs"]["clip"] = list(clip_source)
    tail_ref = [tail[0], 1]
    for _, n in entries:
        inputs = n.get("inputs") or {}
        clip = inputs.get("clip")
        if n.get("class_type") == "CLIPTextEncode" and isinstance(clip, list) and clip[0] not in lora_ids:
            inputs["clip"] = list(tail_ref)

    return wf


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
    """A fresh workflow copy with prompts substituted, seeds randomized, and any
    LoRAs triggered by the picked dictionary values injected once each — plus a
    dict describing the choices made (for console logging)."""
    wf = json.loads(json.dumps(flow))
    info: dict = {"seed": None}
    lora_sink: list[dict] = []
    for node in wf.values():
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if node.get("class_type") == "CLIPTextEncode" and isinstance(inputs.get("text"), str):
            inputs["text"] = substitute(inputs["text"], dictionaries, lora_sink)
        for key in ("seed", "noise_seed"):
            if key in inputs:
                inputs[key] = random.randint(0, 2 ** 32 - 1)
                if "steps" in inputs and "cfg" in inputs:
                    info["seed"] = inputs[key]

    dict_loras = dedupe_loras(lora_sink)
    wf = remove_empty_lora_nodes(wf)
    wf = inject_loras(wf, dict_loras)
    wf = normalize_lora_clip(wf)

    info["prompt_text"] = find_positive_prompt(wf)
    info["loras"] = [lora["name"] for lora in dict_loras]
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
        if info["loras"]:
            print(f"    loras: {', '.join(info['loras'])}")

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
