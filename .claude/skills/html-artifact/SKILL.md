---
name: html-artifact
description: >-
  Create polished, self-contained HTML deliverables for in-app preview.
  Use when the user asks to create a presentation, deck, one-pager, report,
  assessment, review, dashboard mock, landing page, interactive handout, or
  similar visual artifact — unless they explicitly request pptx, docx, xlsx, or pdf.
  Every GrowthOS report must copy york-report-template.html in this folder and
  keep its shell. Do not invent a different report layout.
---

# HTML artifacts (default for creations)

## When to use

**Default** for create/make/build asks that produce a visual deliverable:

- Presentations / decks / slide updates
- One-pagers, briefs, handouts
- Landing pages, microsites, interactive explainers
- Dashboard mocks
- Reports: research, review, strategy, assessment, status, analysis

**Do not use** when the user explicitly asks for Office/PDF formats
(`pptx`, `docx`, `xlsx`, `pdf`, PowerPoint, Word, Excel). Then use those skills.

**Do not use** when the user names **Confluence**, **wiki**, or **Atlassian**.
Route those asks to Confluence MCP (`createConfluencePage` / `updateConfluencePage`)
via the york-os skill instead of writing local HTML.

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

## Reports (required shell)

Any GrowthOS report uses `york-report-template.html` in this skill folder. That file is the style guide. The sample inside it (Brightline Health onboarding) is fiction. Replace the sample. Keep the shell.

Before writing, Read `york-report-template.html` (same directory as this skill). Copy that file to `outputs/<name>.html`. Then edit the copy.

**Fixed. Do not restyle or remove:**

- Classification strip
- Cover layout, York IE logo, and the cover mark
- Document control, including the revision table
- AI disclosure
- Footer and legal line
- Brand tokens in `:root` (colour, type, spacing)
- Print rules (`@page` A4, page footer)

**Fill per report:**

- `data-field="..."` — one value each (title, client, date, report ID, bottom line, and the rest)
- `data-repeat="..."` — zero or more rows (findings, sources, recommendations, risks, steps, revisions)
- `data-optional` sections — delete a section when it does not apply
- Contents — rebuild the list from the sections you kept

**Component kit. Use these inside sections. Do not invent new chrome:**

- `.kpis` / `.kpi` — up to four headline numbers, with `.delta.up` or `.delta.down`
- `figure.chart` — inline SVG, caption, and source
- `table` inside `.table-wrap` — `td.num` for numbers; `tr.chosen` for the recommended row
- `.callout.insight` — takeaway; `.callout.caution` — gap, caveat, or risk
- `blockquote.evidence` — a real quote or source, with `cite`
- `.pill.high` / `.med` / `.low` — priority, impact, likelihood
- `.status.draft` / `.in-review` / `.final`
- `ol.steps` — real sequences only (a plan or timeline)

**Defaults when the user did not say otherwise:**

- Status is Draft. Human review is Pending. Do not mark Final, and do not invent a reviewer.
- Prepared by is "York IE, via GrowthOS".
- Report ID shape is `YIE-GOS-YYYY-NNNN` when none was given.
- Classification is Confidential.
- Update both `@page` footer strings with the real client name and report ID.
- Say what is unknown. Do not copy Brightline figures, names, or quotes into a real report.

If the user asked for PDF, print this same HTML (the template is already A4). Do not draw a second layout.

Decks, one-pagers, and landing pages are not this shell. Use the presentation pattern below for those.

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

## Notify the user

When this skill's work is finished, or when something important needs the user and they may not be looking at the chat, call `NotifyUser` once before you stop:

- `title`: short outcome (a few words)
- `body`: one sentence on what happened or what they should do
- `level`: `complete` when the work is done, `attention` when they need to act (decision, failure, blocker, question)

Skip it for greetings, trivial chatter, and intermediate steps (including goal ticks that are still `in_progress` and status polls). If the tool says notifications are off, do not retry.
