import sys
import json
import random
from pathlib import Path
from PIL import Image
import requests

COMFY = "http://127.0.0.1:8188"

folder = Path(sys.argv[1])

for png in folder.glob("*.png"):
    print("Processing:", png)

    meta = Image.open(png).info
    if "prompt" not in meta:
        print("  no prompt")
        continue

    prompt = json.loads(meta["prompt"])

    # set random seed + batch=8
    for node in prompt.values():
        if "inputs" in node:
            node["inputs"]["seed"] = random.randint(1, 2**32)
            if "batch_size" in node["inputs"]:
                node["inputs"]["batch_size"] = 8

    # send to comfy
    requests.post(
        f"{COMFY}/prompt",
        json={"prompt": prompt}
    )

print("done")
