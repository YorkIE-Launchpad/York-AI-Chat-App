# Client status — multi-connector account brief

Use for: “status on client Acme”, “how is client Y”, “update on client Z”,
“what’s going on with Acme”.

Default to **breadth**: Hub account data plus every connected comms/delivery
system that can hold signal. Do not stop at Hub alone.

Load `hub-mcp` for Hub semantics; `rnd-launchpad-mcp-sdlc` when digging into
Launchpad delivery on linked projects.

## Tool-call plan

```text
Phase 1: Hub list_clients → match name → get_client → clientId, name, linkage
Phase 2: Hub projects for client (list_project_summaries / list_projects filter)
         + list_quotations → get_quotation / get_quotation_linked_projects
         → projectIds
Phase 3: For each key projectId:
         - list_project_allocations → staff emails
         - list_project_release_notes (if useful)
         - Launchpad list_projects / get_project match by name → list_releases
           (lock/QA signals as needed)
Phase 4 (parallel — client name + project titles):
         - Slack search_messages
         - Gmail search_emails (newer_than window)
         - meeting_search
         - Drive search_files
         - Calendar search_events / upcoming list if meetings with client matter
         - Jira searchJiraIssuesUsingJql (client/project cues)
         - Confluence searchConfluenceUsingCql
         - Pulse: mcp_search_tools after identity known if metrics/health asked
           or status is broad
Phase 5: Deepen — get_thread, get_email, meeting_read, get_document_content,
         getJiraIssue / getConfluencePage; Hub get_leave_wfh_calendar for key staff
Phase 6: Synthesize client brief + Sources; list connectors checked/skipped
```

## Worked example

User: “What’s the status on client Acme?”

```text
→ Hub list_clients("Acme") → get_client
→ Hub projects + quotations linked → projectIds
→ allocations → emails; Launchpad match "Acme …"
→ parallel Slack/Gmail/meetings/Drive/Jira on "Acme"
→ deepen best hits
→ structured brief (template) — no invented health
```

## Output template

```markdown
## Client: <name>

### Account

- Hub identity / linkage (from get_client)

### Commercials

- Quotations / linked projects (or “none found”)

### Delivery

- Projects + status from Hub summaries
- Launchpad release / delivery signals (or skipped)

### Staffing

- Allocations; leave/WFH notes for key people

### Recent comms & meetings

- Slack / Gmail / meeting bullets with dates

### Tickets / docs

- Jira / Confluence / Drive highlights (or none)

### Risks / open loops

- Only from sources — never invent

### Connectors

- Checked: …
- Skipped: …

Sources:

- …
```

## Rules

- Chain **clientId** → projects → **projectIds** → allocations emails → comms.
- Never ask the user for client/project ids Hub already returned.
- If a connector returns nothing, say so under that section.
- Never invent account health, revenue, or delivery status.
- Always end with `Sources:`.
