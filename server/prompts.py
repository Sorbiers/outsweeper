"""LLM instruction texts used by the job runners.

These moved here from the Angular dialogs when the flows became backend jobs, so
there is one place to tune the wording. They are plain strings / small builders on
purpose — edit them freely, nothing else depends on their exact shape.
"""
from __future__ import annotations

import json
import re

# "Improve then send" — enrich one prompt before it is rendered.
IMPROVE_PROMPT_INSTRUCTION = (
    'Improve and enrich the following text-to-image prompt. Keep its core subject '
    'and intent, but make it more vivid and detailed by adding arbitrary details, '
    'elements, or plot variations. Return ONLY the improved prompt text, ready to '
    'use, with no explanations, preamble, or quotation marks.'
)

# Guided generation — the one-off enrichment before the first render.
GUIDED_IMPROVE_INSTRUCTION = (
    'Improve and enrich the following text-to-image prompt. Keep its core subject and '
    'intent, but make it more vivid and detailed by adding arbitrary details, elements, '
    'or camera view and lighting variations. Return ONLY the improved prompt text, ready '
    'to use, with no explanations, preamble, or quotation marks.'
)


def eval_instruction(prompt: str) -> str:
    """Ask the vision model whether the rendered image satisfies the prompt."""
    return (
        'You are checking whether the image matches the main subject and intended meaning of '
        'this text-to-image prompt closely enough.\n'
        'Evaluate the main idea of the plot and ignore secondary details. Also check the image '
        'quality: whether it is well exposed and whether the characters have correct anatomy and '
        'facial expression.\n'
        f'PROMPT: "{prompt}"\n'
        'Reply ONLY with a JSON object and nothing else:\n'
        '{ "match": true or false, "feedback": "what is missing or wrong (empty if it matches)", '
        '"corrected_prompt": "a refined single prompt that would make the model render the scene '
        'more exactly as described; keep the same intent" }\n'
        'Set "match" to true only if the following criteria are met:\n'
        '- The image conveys the main idea of the prompt.\n'
        '- The character types, poses, clothing, and facial expressions match what is described '
        'in the prompt.\n'
        '- The characters have correct anatomy and faces.\n'
        '- The image quality is good: well exposed and not blurry.'
    )


def refine_instruction(prompt: str, feedback: str, suggested: str, *, insist: bool = False) -> str:
    """Rewrite a prompt from the evaluation feedback. `insist` is the second attempt,
    used when the model simply echoed the prompt back unchanged."""
    text = (
        'A text-to-image model generated an image from the PROMPT below, but the image did NOT '
        'match it.\n'
        f'PROMPT: "{prompt}"\n'
        f'WHAT THE IMAGE GOT WRONG OR MISSED: {feedback or "the image did not match the prompt"}\n'
        + (f'SUGGESTED DIRECTION: {suggested}\n' if suggested else '') +
        'Write a REVISED prompt that fixes these problems and forces the model to render every '
        'described element. Make the missing elements explicit and prominent, use positive phrasing '
        '(describe what SHOULD appear, never what should not), and keep the same creative intent. '
        'The revised prompt MUST differ from the original. Return ONLY the revised prompt text — '
        'no explanations, labels, or quotes.'
    )
    if insist:
        text += (
            '\n\nYour previous answer repeated the prompt unchanged. You MUST return a clearly '
            'DIFFERENT prompt: reword it, put the missing elements first, and state them more '
            'explicitly.'
        )
    return text


# --- Synopsis to illustrations -------------------------------------------

STORY_INSTRUCTION = (
    'Write a short story from the synopsis below. Introduce the characters and setting, follow '
    'the plot and action described, and give it a clear beginning, middle, and end. Return ONLY '
    'the story text — no title, preamble, or commentary.\n\nSYNOPSIS:\n'
)


def count_clause(min_n: int, max_n: int) -> str:
    """Illustration count as a constraint, not a fixed number — 0 means "unset"."""
    if min_n > 0 and max_n > 0:
        return f'between {min_n} and {max_n} illustrations'
    if min_n > 0:
        return f'at least {min_n} illustrations'
    if max_n > 0:
        return f'at most {max_n} illustrations'
    return 'as many illustrations as the story needs'


def illustrator_instruction(story: str, style: str, min_n: int, max_n: int) -> str:
    style_line = f'Illustration style: {style.strip()}.\n' if style.strip() else ''
    return (
        'You are a text-to-image prompt writer for the FLUX model. Read the story below and write '
        f'{count_clause(min_n, max_n)} — one per key scene, in narrative order. Choose whatever '
        "number within that constraint best covers the story's beats. Each prompt must be a single, "
        'richly detailed image-generation prompt describing the subjects, action, setting, lighting, '
        'and composition of that scene.\n' + style_line +
        'Separate each prompt with a line containing only ---. Do not number them, and do not add '
        'any titles, explanations, or commentary — output only the prompts and the --- separators.\n\n'
        f'STORY:\n{story}'
    )


def split_illustrations(text: str) -> list[str]:
    """Split the illustrator's output on `---` lines, falling back to blank lines if
    the model ignored the separator, and strip stray numbering / code fences."""
    def clean(s: str) -> str:
        # Trim first so the fence/numbering patterns anchor on the segment's own
        # edges rather than the whole raw string.
        t = s.strip()
        t = re.sub(r'^```[\w-]*\n?', '', t)
        t = re.sub(r'\n?```$', '', t).strip()
        t = re.sub(r'^\s*(illustration\s*)?#?\d+[.):]\s*', '', t, flags=re.IGNORECASE)
        return t.strip()

    parts = [p for p in (clean(s) for s in re.split(r'^[ \t]*-{3,}[ \t]*$', text or '', flags=re.M)) if p]
    if len(parts) <= 1:
        parts = [p for p in (clean(s) for s in re.split(r'\n\s*\n', text or '')) if p]
    return parts


def parse_verdict(text: str) -> dict:
    """Read the vision model's JSON verdict, tolerating prose around it."""
    match = re.search(r'\{[\s\S]*\}', text or '')
    if match:
        try:
            obj = json.loads(match.group(0))
            return {
                'match': bool(obj.get('match')),
                'feedback': str(obj.get('feedback') or ''),
                'corrected': str(obj.get('corrected_prompt') or obj.get('correctedPrompt') or ''),
            }
        except Exception:
            pass
    head = (text or '').strip()[:24].lower()
    matched = bool(re.search(r'\b(yes|match(es)?|correct)\b', head)) and not head.startswith('no')
    return {'match': matched, 'feedback': (text or '')[:300], 'corrected': ''}


def is_unchanged(refined: str, prompt: str) -> bool:
    """True when the 'refined' prompt is empty or effectively the same as before."""
    norm = lambda s: re.sub(r'\s+', ' ', (s or '')).strip().lower()   # noqa: E731
    return not (refined or '').strip() or norm(refined) == norm(prompt)
