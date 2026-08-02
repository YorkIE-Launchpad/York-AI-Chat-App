# Tool planning — 500+ tools

Company asks often need many connectors. Do **not** pick one obvious tool and
stop. Plan first, then execute. Do **not** dump the plan as a long user-facing
preamble — start calling tools immediately after forming the plan.

## Steps

1. **Classify** (list-only vs prep vs person brief vs client status vs project
   status vs commitments vs Hub HR vs Launchpad delivery vs metrics).
2. **Draft a compact plan** (internal): phases, systems, join keys, parallel
   batches. Use playbooks:
   - Meeting prep → [meeting-prep.md](meeting-prep.md)
   - Person / open loops → [work-brief.md](work-brief.md)
   - Client → [client-status.md](client-status.md)
   - Project → [project-status.md](project-status.md)
3. **Phase 1 discover** — list/search to obtain ids (emails, clientId,
   projectId, eventId, titles).
4. **Extract join keys** — see [connectors.md](connectors.md).
5. **Phase 2+ resolve & enrich** — chain keys into Hub/Launchpad/comms/docs;
   run independent searches **in parallel**.
6. **Deepen** only promising hits (`get_thread`, `get_email`, `meeting_read`,
   `get_document_content`, `getJiraIssue`, …).
7. **Synthesize** with `Sources:`; list connectors checked vs skipped.

## Meta mode (`mcp_search_tools` / `mcp_call_tool`)

- Query **narrowly**: connector name + intent keyword (e.g. `Calendar list`,
  `Hub client`, `Slack search`).
- Small limit; prefer server filter when available.
- After matches, **immediately** call `mcp_call_tool` in the same turn — never
  end the turn with only a search or a plan.
- Prefer exact tool names from search results; do not invent names.

## Parallelism

Same phase, no dependency → call together:

```text
OK parallel: Slack search + Gmail search + meeting_search + Drive search
OK parallel: Hub leave calendar + Launchpad list_releases (after projectId known)
Sequential: list_events → get_event → (emails) → Hub list_employees
Sequential: meeting_search → meeting_read(id)
Sequential: search_emails → get_email(id) → Drive get(file_id from body)
```

## Caps & stop conditions

- Enrich real meetings / named clients / projects — skip focus blocks, spam.
- Deepen top hits only (roughly 2–5 per channel unless user wants exhaustive).
- Stop enriching a branch when results are empty or clearly irrelevant.
- If a connector errors or is disconnected: note it, continue others.
- Never invent facts to fill empty branches.

## Plan shape (template)

```text
Intent: <prep | client-status | project-status | work-brief | …>
Phase 1: <discover tools> → keys: …
Phase 2: <resolve identities / linked records>
Phase 3 (parallel): <Slack | Gmail | meetings | Drive | Calendar | Jira | …>
Phase 4: deepen <ids>
Phase 5: synthesize + Sources; checked: …; skipped: …
```

## Anti-patterns

- Calendar-only answer to “prepare agendas”.
- Hub-only answer to “client status” when Slack/Gmail/Launchpad are connected.
- Asking the user for an email/id already returned by a tool.
- Web search as a substitute for connected York systems.
- Long “I will now…” narration instead of tool calls.
