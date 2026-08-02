# Work brief — catch-me-up, person status, open loops

Use for: “catch me up on X”, “brief me on Jay”, “any open loops with Y”,
“what did I promise / tell / agree”, “status with person Z”, follow-ups.

For **client** or **project** named accounts/delivery, prefer
[client-status.md](client-status.md) or [project-status.md](project-status.md).

## Tool-call plan

```text
Phase 1: Resolve identity
  - Hub list_employees / search_organization → email, team
  - Slack get_user if helpful
Phase 2 (parallel fan-out):
  - Slack search_messages (name + topic / commitment cues)
  - Gmail search_emails (name, from:me / to:, newer_than:…)
  - meeting_search(name/topic)
  - Calendar search_events / list_events if upcoming touchpoints matter
  - Drive search_files if docs implied
Phase 3: Deepen — get_thread, get_email, meeting_read(+transcript if needed),
         get_document_content
Phase 4: Optional Hub leave if “are they around” matters
Phase 5: Synthesize + Sources; list connectors checked/skipped
```

## Commitment cues (Slack / Gmail queries)

Include terms like: `promise`, `will`, `I'll`, `action`, `follow up`, `send`,
`deliver`, `owe`, `by Friday`, `agreed`, `next steps`.

## Output template

```markdown
## Brief: <person or topic>

### Open loops / commitments

- … (source + date) — or “none found after checking …”

### Recent context

- Slack / Gmail / meetings bullets with dates

### Upcoming

- Calendar touchpoints if any

### Connectors

- Checked: …
- Skipped: …

Sources:

- …
```

## Rules

- Do not answer from memory alone.
- Never invent promises. Empty result → say which sources were checked.
- Reuse Hub email for Gmail/Calendar/Slack queries when available.
- Always end with `Sources:`.
