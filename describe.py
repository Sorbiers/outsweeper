#!/usr/bin/env python3
import base64
import mimetypes
import os
import sys

from openai import OpenAI  # pip install openai

def to_data_url(path: str) -> str:
    mt, _ = mimetypes.guess_type(path)
    mt = mt or "image/png"
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mt};base64,{b64}"

def main():
    if len(sys.argv) < 2:
        print("Usage: python lmstudio_describe.py <image_path> [prompt] [model_id]")
        sys.exit(1)

    image_path = sys.argv[1]
    prompt = sys.argv[2] if len(sys.argv) >= 3 else "Describe this image in detail."
    model = sys.argv[3] if len(sys.argv) >= 4 else os.getenv("LMSTUDIO_MODEL", "model-identifier")

    client = OpenAI(
        base_url=os.getenv("LMSTUDIO_BASE_URL", "http://localhost:1234/v1"),
        api_key=os.getenv("LMSTUDIO_API_KEY", "lm-studio"),  # LM Studio ignores/accepts dummy by default
    )

    data_url = to_data_url(image_path)

    resp = client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
        temperature=0.2,
    )

    print(resp.choices[0].message.content)

if __name__ == "__main__":
    main()