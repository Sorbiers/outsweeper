# Plan: "Synopsis to illustrations"

## Context
The Generate dialog can already enrich a single prompt (Improve then send) and iterate on one
image (Guided generation). What's missing is going the other way: from one **plot synopsis** to a
*set* of illustration prompts telling that story. This feature adds a two-stage LLM pipeline —
a **storyteller** model turns the synopsis into a short story, then an **illustrator** model turns
that story into detailed FLUX-ready t2i prompts separated by `---` — which the user reviews and
hands back to the Generate dialog to render.

Decisions (confirmed with the user):
- **Use** puts the *whole generated set* into the parent Generate dialog: replaces the positive
  prompt, ticks **Multiple prompts**, and sets the delimiter — so one **Send** queues every
  illustration. (Per-prompt Copy/Use stay, per the original spec.)
- The dialog **stops at prompts** — no direct ComfyUI queueing from here.
- The illustrator decides **how many** illustrations the story needs, constrained by the Min/Max
  range. **0 on either bound means "not set"** (no lower / no upper limit).
- **Generate story is optional** — the user may paste an existing story and go straight to
  illustrations.

Key finding: **no backend work is needed.** Everything required already exists —
`PhotoService.lmPrompt(url, prompt, model)` (`services/photo.service.ts`) and
`unloadLmStudio(url)`, plus the parent's own `multiplePrompts` / `promptDelimiter` splitting
(`positivePromptParts()` in `generate-dialog.ts`) which splits on a line whose trimmed text equals
the delimiter — exactly the `---` format the illustrator LLM is asked to emit.

## Approach

### New component `components/synopsis-dialog/{ts,html,scss}`
Modeled on `guided-generation-dialog` (fixed-height dialog, flex-column content, one scrollable
result region, draggable title with `cdkDragBoundary=".cdk-overlay-container"`).

**Data in** (`SynopsisDialogData`): `{ lmUrl: string; applyPrompts: (prompts: string[]) => void }`.
`applyPrompts` is a closure the parent supplies — the same pattern as `buildWorkflow` in
`openGuided` (`generate-dialog.ts:577`) — so the child writes into the *still-open* parent.

**Controls** (top, disabled while running):
- **Synopsis** textarea — only required for *Generate story*.
- **Storyteller model** `mat-select` — only used by *Generate story*.
- **Illustrator model** `mat-select`.
- **Min / Max images** numbers, `0 = not set` (hint text says so). Defaults 3 / 6. Clamp
  negatives to 0; if both set and `min > max`, swap.
- **Illustration style description** textarea (e.g. "watercolour children's book").

Model lists come from `LmStudioConnectionService.availableModels`; call `lms.init()` and, if the
list is empty, `lms.checkConnection()` (the `llm-model-dialog.ts` pattern). Note
`LmStudioConnectionService` holds a **single** `model`, so keep two independent local fields;
persist both (+ style, min, max) via new `STORAGE_KEYS` entries in `constants.ts`.

**Story field** — an editable textarea that is both an **input and an output**: *Generate story*
fills it, and the user can equally paste an existing story (or edit a generated one) before
illustrating. This is what makes the storyteller stage skippable.

**Actions**: `Generate story` (disabled unless a synopsis + storyteller model are set) ·
`Generate illustrations` (disabled unless the **story textarea is non-empty** — generated *or*
pasted — and an illustrator model is set) · `Cancel` (closes). Status line + spinner while running.

### Flow (VRAM-safe — the established rule for this machine)
Each stage: **unload all LLMs → run the one model needed**, via `unloadLmStudio(lmUrl)` (it
unloads *every* loaded instance) then `lmPrompt(...)`.
1. **Generate story** *(optional)* — unload → `lmPrompt(storyteller, STORY_INSTRUCTION + synopsis)`
   → fill the story textarea.
2. **Generate illustrations** — unload (drops the storyteller, if one was loaded) →
   `lmPrompt(illustrator, …)` with the story + style + count clause + "separate each prompt with a
   line containing only `---`, no numbering or commentary" → parse and render the list.
3. Always unload again when the flow ends (success or failure).

Live model-load / prompt-processing progress already surfaces globally in the **LM Studio widget**
(`server/lmstudio.py` streaming), so the long model loads are visible without extra work.

### Count constraint (Min/Max, 0 = unset)
Build the clause from the bounds instead of demanding a fixed N:
```ts
function countClause(min: number, max: number): string {
  if (min > 0 && max > 0) return `between ${min} and ${max} illustrations`;
  if (min > 0)            return `at least ${min} illustrations`;
  if (max > 0)            return `at most ${max} illustrations`;
  return 'as many illustrations as the story needs';
}
```
The instruction tells the model to choose the number that best suits the story's beats within that
constraint (one prompt per key scene, in narrative order).

### Parsing (`splitIllustrations`)
Split on `/^\s*---\s*$/m` lines, trim, drop empties, strip stray markdown fences and leading
`1.` / `Illustration 1:` numbering. Then **only if `max > 0`** trim the list to `max`; **only if
`min > 0`** and fewer came back, warn via snackbar (keep what was returned). Falls back to
blank-line splitting if the model ignored `---`.

### Result zone
Scrollable; one card per prompt: index, prompt text, **Copy** (`Clipboard` from
`@angular/cdk/clipboard`, as used in `info-panel`) and **Use**. The list header carries **Use all**.

### Hand-off to the parent (`generate-dialog.ts`)
- New `openSynopsis()` + menu item `<mat-icon>auto_stories</mat-icon> Synopsis to illustrations`
  in the actions menu of `generate-dialog.html` (beside Guided generation, ~line 258). Guard on
  `connState.lmstudio.url` with the same snackbar hint `openGuided()` uses.
- The closure it passes:
  ```ts
  const applyPrompts = (prompts: string[]) => {
    this.params.positivePrompt = prompts.join('\n---\n');
    this.multiplePrompts = true;
    this.promptDelimiter = '---';
  };
  ```
  Per-prompt **Use** calls the same closure with a single-element array (one part → one send, so
  the flags stay harmless).

## Critical files
- New: `frontend/src/app/components/synopsis-dialog/synopsis-dialog.{ts,html,scss}`
- Edit: `frontend/src/app/components/generate-dialog/generate-dialog.ts` (+`.html`) — `openSynopsis()`
  and the menu item; `frontend/src/app/constants.ts` — storage keys.
- Reuse: `lmPrompt` / `unloadLmStudio` (`services/photo.service.ts`), `LmStudioConnectionService`,
  the `guided-generation-dialog` layout + SCSS, `multiplePrompts`/`promptDelimiter` in the parent.
- **No backend changes.**

## Gotcha to avoid (hit earlier this session)
A standalone component using `<input matInput>` **must import `MatInputModule`** — omitting it
compiles fine but throws `controlType` errors on every change-detection cycle and renders the
field broken. Import `MatInputModule`, `MatSelectModule`, `MatFormFieldModule`, `FormsModule`,
`MatButtonModule`, `MatIconModule`, `MatProgressSpinnerModule`, `MatDialogModule`, `CdkDrag`.

## Verification
1. `cd frontend && npx ng build` — clean.
2. **Stubbed UI run** (Playwright, `/api/lmstudio/*` intercepted so no GPU load): open Generate →
   menu → Synopsis to illustrations; stub `/api/lmstudio/prompt` to return a story, then a
   `---`-separated payload. Assert: story fills the textarea; illustration cards appear; the call
   order is `unload → prompt(storyteller) → unload → prompt(illustrator) → unload`, and each call
   carries the right `model`.
3. **Skip-story path**: reopen, leave Synopsis empty, **paste** text into the story textarea →
   *Generate illustrations* is enabled and runs with only `unload → prompt(illustrator) → unload`
   (no storyteller call).
4. **Min/Max semantics**: `min=0,max=0` → the instruction says "as many as the story needs" and no
   trimming; `max=2` with 5 returned → list trimmed to 2; `min=4` with 2 returned → warning shown,
   both kept.
5. **Hand-off**: click *Use all*, close the child, and assert on the parent that the positive
   prompt contains the prompts joined by `---`, the **Multiple prompts** checkbox is checked, the
   delimiter field reads `---`, and the Send button count equals the number of prompts (proves
   `positivePromptParts()` split them). Then per-prompt **Use** → prompt box holds just that one.
6. **Real end-to-end** (small model, low VRAM):
   `qwen3-short-story-instruct-uncensored-262k-ctx-4b-i1` (2.6 GB) as storyteller and illustrator —
   confirms real output parses, and that the LM Studio widget shows load/prompt progress live.
7. Confirm nothing is queued to ComfyUI from this dialog.
