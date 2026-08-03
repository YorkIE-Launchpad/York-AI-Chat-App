---
name: html-artifact
description: >-
  Create polished, self-contained HTML deliverables for in-app preview.
  Use when the user asks to create a presentation, deck, one-pager, report page,
  dashboard mock, landing page, interactive handout, or similar visual artifact —
  unless they explicitly request pptx, docx, xlsx, or pdf.
---

# HTML artifacts (default for creations)

## When to use

**Default** for create/make/build asks that produce a visual deliverable:

- Presentations / decks / slide updates
- One-pagers, briefs, handouts
- Landing pages, microsites, interactive explainers
- Dashboard or report page mocks

**Do not use** when the user explicitly asks for Office/PDF formats
(`pptx`, `docx`, `xlsx`, `pdf`, PowerPoint, Word, Excel). Then use those skills.

Still obey CHAT FIRST: only write files when the user asked to create/save something.

## Output contract

1. Write a **single self-contained** `.html` file under `outputs/`  
   Example: `outputs/client-update.html`
2. Inline CSS (and JS if needed). Prefer Google Fonts via `<link>` if useful.
3. No build step, no bundler, no separate asset pipeline required for v1.
4. After writing, emit an artifact fence so the app opens the right-side preview:

````text
```artifact
{"path":"outputs/your-file.html","name":"Short title","type":"html"}
```
````

Use a workspace-relative `path` (prefer `outputs/...`).

## Presentation pattern

For decks / slide-style asks:

- Full-viewport sections (one “slide” per section), e.g. `100vh` panels
- Clear keyboard (arrow / space) and/or click / button navigation
- Progress indicator optional; keep chrome minimal
- Expressive typography; strong brand/title hierarchy on the first slide
- Atmosphere via gradients, imagery, or subtle patterns — not a flat white page
- Avoid generic AI-default looks (purple-on-white, Inter/Roboto stacks, pill clusters, card grids in the hero)

## Quality bar

- One clear job per section/slide
- Readable on desktop and mobile widths
- Prefer real product/place/context imagery over abstract decoration when relevant
- Keep motion intentional (2–3 small transitions), not noisy

## Iteration

When the user asks to revise, edit the same HTML file in place so the in-app preview refreshes.
