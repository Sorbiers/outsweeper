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

import json
import os
import random
import re
import sys
import time
from pathlib import Path

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


def prepare_job(flow: dict, dictionaries: dict[str, list[dict]]) -> dict:
    """A fresh workflow copy with prompts substituted and seeds randomized."""
    wf = json.loads(json.dumps(flow))
    for node in wf.values():
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if node.get("class_type") == "CLIPTextEncode" and isinstance(inputs.get("text"), str):
            inputs["text"] = substitute(inputs["text"], dictionaries)
        for key in ("seed", "noise_seed"):
            if key in inputs:
                inputs[key] = random.randint(0, 2 ** 32 - 1)
    return wf


def submit(wf: dict, client_id: str) -> str:
    resp = requests.post(f"{COMFY}/prompt", json={"prompt": wf, "client_id": client_id}, timeout=30)
    if resp.status_code != 200:
        try:
            detail = resp.json()
        except Exception:
            detail = resp.text
        raise RuntimeError(f"ComfyUI rejected the prompt: {detail}")
    return resp.json()["prompt_id"]


def wait_for(prompt_id: str, timeout: float = 1800) -> dict:
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
    out_dir.mkdir(parents=True, exist_ok=True)

    doc = json.loads(json_path.read_text(encoding="utf-8"))
    flow = doc["flow"] if isinstance(doc, dict) and "flow" in doc else doc
    dictionaries = doc.get("dictionaries", {}) if isinstance(doc, dict) else {}
    if not isinstance(flow, dict) or not flow:
        print("No workflow found in the .json (expected a 'flow' object).")
        sys.exit(1)

    client_id = f"gfc-{random.randint(0, 1 << 31)}"
    print(f"ComfyUI: {COMFY}  |  jobs: {jobs}  |  out: {out_dir}")

    for i in range(1, jobs + 1):
        wf = prepare_job(flow, dictionaries)
        try:
            prompt_id = submit(wf, client_id)
        except Exception as e:
            print(f"[{i}/{jobs}] submit failed: {e}")
            continue
        print(f"[{i}/{jobs}] queued {prompt_id} — waiting...")
        try:
            entry = wait_for(prompt_id)
        except TimeoutError as e:
            print(f"[{i}/{jobs}] {e}")
            continue
        saved = save_outputs(entry, out_dir, i)
        status = entry.get("status", {}).get("status_str", "")
        note = f" [{status}]" if status and status != "success" else ""
        print(f"[{i}/{jobs}] done{note} -> {', '.join(saved) if saved else '(no images)'}")

    print("all done")


if __name__ == "__main__":
    main()
