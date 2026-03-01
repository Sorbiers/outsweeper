import sys
import json
import random
from pathlib import Path
from PIL import Image
import requests

COMFY = "http://127.0.0.1:8188"

folder = Path(sys.argv[1])

#!/usr/bin/env python3
import random

# -----------------------------
# HARD CODED LISTS
# -----------------------------

AMBIENCE_PLACES = [
    "foggy harbor at dawn",
    "abandoned railway station at night",
    "candlelit tavern interior",
    "rain-soaked city street",
    "lonely countryside road at dusk",
    "old apartment corridor under dim light",
    "snow-covered village square",
    "deserted coastal lighthouse",
    "industrial warehouse interior",
    "forest clearing in early morning mist"
]

CHARACTERS = [
    "a lone watchman",
    "two exhausted detectives",
    "an elderly woman",
    "a railway worker",
    "a mysterious stranger",
    "a tired doctor",
    "a young woman in a dark coat",
    "a fisherman",
    "a soldier returning home",
    "a silent child"
]

ACTIONS = [
    "standing motionless",
    "walking slowly through shadows",
    "examining an old letter",
    "waiting anxiously",
    "looking over their shoulder",
    "speaking quietly",
    "holding a lantern",
    "watching the distance",
    "opening a creaking door",
    "resting after a long journey"
]

STYLES = [
    "Baroque dramatic lighting",
    "Dutch Golden Age realism",
    "Academic realism",
    "Romanticism oil painting",
    "19th century Realism",
    "Tonalism atmosphere",
    "Naturalism",
    "Classical Renaissance realism",
    "American Realism",
    "Contemporary figurative realism"
]

# -----------------------------
# PROMPT GENERATOR
# -----------------------------

def generate_prompt():
    ambience = random.choice(AMBIENCE_PLACES)
    character = random.choice(CHARACTERS)
    action = random.choice(ACTIONS)
    style = random.choice(STYLES)

    prompt = (
        f"{ambience}, {character} {action}, "
        f"realistic oil painting, {style}, "
        "cinematic composition, dramatic natural lighting, "
        "detailed brushwork, realistic textures, masterpiece, high detail"
    )
    print(prompt)
    return prompt


# -----------------------------
# RUN
# -----------------------------











for png in folder.glob("*.png"):
    print("Processing:", png)

    meta = Image.open(png).info
    if "prompt" not in meta:
        print("  no prompt")
        continue

    prompt = json.loads(meta["prompt"])

    # set random seed + batch=8
    for node in prompt.values():
        if node["class_type"] == "CLIPTextEncode":
            node["inputs"]["text"] = generate_prompt()
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
