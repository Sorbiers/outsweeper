
# Photo Parser (Claude-Optimized)

Minimal portable Python 3 tool for manual image triage.

---

## Run

python app.py <source_folder>

---

## Startup

App must:
- validate source folder
- create if missing:
  - __selected
  - __dust
- start local HTTP server:
  http://localhost:1976
- open default browser automatically

Windows-first.
No install.
Local-only.

---

## Stack

Backend:
- Python 3
- single process
- filesystem only
- no database

Frontend:
- Angular v20
- Angular Material
- single page

---

## Layout

Vertical split:

TOP — 25vh  
Horizontal image strip:
- png/jpg/jpeg/webp
- centered selected image
- horizontal scroll
- keyboard navigation

Keys:
← previous  
→ next

---

BOTTOM — 75vh

Left — 65vw (Info):
- filename
- modified date
- size
- metadata (PNG/JPEG)

PNG:
Extract ComfyUI (see ./run.py as example):
- model
- loras
- prompt
- steps

Right — 35vw (Preview):
- 100% image scale
- scroll if needed

---

## Actions

Keyboard only:

+        → move to __selected  
Delete   → move to __dust  
← / →    → navigate  
Ctrl+Z   → undo last move

Rules:
- filesystem move
- no confirmation
- undo restores file
- keep in-memory history

---

## Constraints

- minimal dependencies
- portable
- simple code
- no auth
- no async required

Goal:
Fast manual image sorting.
