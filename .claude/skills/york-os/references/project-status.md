# Project status — multi-connector delivery brief

Use for: “status on project X”, “update on Y”, “how is project Y”,
“what’s going on with the Launchpad work for Z”.

Default to **breadth**: Hub project + staffing, Launchpad delivery state when
applicable, plus Slack/Gmail/meetings/Drive/Jira/Confluence/Calendar. Do not
stop at a single silo.

Load `hub-mcp` for Hub; `rnd-launchpad-mcp-sdlc` for release/QA/build depth.

## Tool-call plan

```text
Phase 1: Hub list_projects / list_project_summaries → match → projectId, title,
         client, status (get_project if more detail needed)
Phase 2: Hub list_project_allocations → staff emails
         + list_project_release_notes
Phase 3: Launchpad list_projects / list_project_names → match by name
         → list_releases / get_release_lock_status / list_versions as needed
         (load launchpad skill for deep Build/Validate)
Phase 4 (parallel — project title + client name):
         - Slack search_messages
         - Gmail search_emails (newer_than window)
         - meeting_search
         - Drive search_files
         - Calendar search_events / upcoming related meetings
         - Jira searchJiraIssuesUsingJql
         - Confluence searchConfluenceUsingCql
         - Pulse tools via mcp_search_tools if metrics asked or status is broad
Phase 5: Deepen thin hits; Hub get_leave_wfh_calendar for key staff if
         availability matters
Phase 6: Synthesize project brief + Sources; list connectors checked/skipped
```

## Worked example

User: “Give me an update on project Orion.”

```text
→ Hub list_project_summaries / list_projects → projectId "Orion"
→ allocations + release notes
→ Launchpad list_projects → Orion → list_releases (active/draft)
→ parallel Slack/Gmail/meeting_search/Drive/Jira "Orion"
→ deepen; leave calendar for allocated emails if useful
→ structured brief (template)
```

## Output template

```markdown
## Project: <title>

### Identity

- Hub projectId, client, status/summary

### Staffing

- Allocations (roles/emails); leave/WFH if relevant

### Delivery (Launchpad)

- Active release / lock / revision signals — or “Launchpad not matched / skipped”

### Tickets / docs

- Jira / Confluence / Drive highlights

### Recent comms & meetings

- Slack / Gmail / meeting bullets with dates

### Upcoming

- Related Calendar events if any

### Open loops / risks

- Only from sources — never invent

### Connectors

- Checked: …
- Skipped: …

Sources:

- …
```

## Rules

- Chain Hub **projectId** → allocations **emails** → leave + Slack/Gmail.
- Cross-link Hub ↔ Launchpad by **name** when ids differ across systems.
- Never ask for project ids tools already returned.
- Empty branches → say so; never invent delivery health.
- Always end with `Sources:`.
