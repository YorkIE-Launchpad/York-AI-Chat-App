# York OS connectors — tools & join keys

Use this when planning multi-source calls. Model-facing MCP names are typically
`mcp__{Server}__{tool}` (spaces → `_`). First-party meeting tools have no MCP
prefix. In meta mode, discover with narrow `mcp_search_tools` then
`mcp_call_tool`.

Zoom OAuth is **capture only** — no Zoom MCP. Notes live in `meeting_*`.

## Hub (York IE HUB)

Load `hub-mcp` for deep workflows. Identity key is usually **email**.

| Tools (primary)                                                                             | Join keys out                 | Typical next                              |
| ------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------- |
| `list_employees`, `search_organization`, `get_employee_profile`                             | email, name, squad/team       | Calendar attendees; Slack; Gmail; leave   |
| `get_leave_wfh_calendar`                                                                    | leave/WFH by people           | Meeting prep / staffing notes             |
| `list_clients`, `get_client`                                                                | **clientId**, client name     | projects, quotations, comms by name       |
| `list_quotations`, `get_quotation`, `list_quotation_items`, `get_quotation_linked_projects` | quotation id, **project ids** | Hub projects; Launchpad; Jira             |
| `list_projects`, `list_project_summaries`, `get_project`                                    | **projectId**, title, client  | allocations; Launchpad; Jira; Slack/Gmail |
| `list_project_allocations`, `get_project_allocation_timeline`                               | staff **emails**              | leave; Slack; Calendar                    |
| `list_project_release_notes`                                                                | release-note text             | status briefs                             |
| `generate_timesheet_summary` / timesheet tools                                              | summary text                  | Calendar event description                |
| Analytics `get_*_analytics`                                                                 | metrics                       | leadership / status when asked            |

## R&D Launchpad

Load `rnd-launchpad-mcp-sdlc` for release loop / Build / Validate.

| Tools (primary)                                                            | Join keys out           | Typical next                |
| -------------------------------------------------------------------------- | ----------------------- | --------------------------- |
| `get_me`, `list_projects`, `list_project_names`, `get_project`             | Launchpad **projectId** | releases; Hub match by name |
| `list_releases`, `get_release`, `get_release_lock_status`, `list_versions` | release / revision ids  | scope, QA, lock wait        |
| Discover/Plan/Build/Validate tools                                         | epic/story/feedback ids | status when delivery asked  |
| `search_project_rag`, `ask_project_assistant`, `get_project_memory`        | distilled facts         | enrich status narrative     |

## R&D Pulse / GTM Pulse

No fixed inventory in-repo. After client/project identity is known, use
`mcp_search_tools` on the Pulse server for metrics/health tools. Do not invent
tool names.

## Slack

| Tools                                    | Join keys out                    | Typical next                                                                                |
| ---------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------- |
| `search_messages`, `get_channel_history` | channel, `thread_ts`, permalink  | `get_thread`; Sources                                                                       |
| `get_thread`                             | full thread text                 | synthesize                                                                                  |
| `get_user`                               | Slack profile / email if present | Hub cross-check                                                                             |
| `post_message`                           | (write — ask)                    | only when user wants a send; **never** `#general` or `#virtual-water-cooler` (hard-blocked) |

## Gmail

| Tools                                                                 | Join keys out              | Typical next                    |
| --------------------------------------------------------------------- | -------------------------- | ------------------------------- |
| `search_emails`                                                       | message id, subject, links | `get_email`                     |
| `get_email`                                                           | body, Drive/doc URLs       | Drive `get_document_content`    |
| `list_labels`                                                         | label id + name            | `modify_email_labels`           |
| `send_email` / drafts / `send_draft` / labels / trash (optional HTML) | (write — ask)              | only when user wants send/draft |

## Google Drive

| Tools                                                                                                           | Join keys out                | Typical next        |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------- |
| `search_files`, `list_files`, `get_file_metadata`                                                               | **file_id**, `web_view_link` | content tools       |
| `get_document_content`                                                                                          | doc text / sheet CSV         | synthesize          |
| `get_spreadsheet_values`                                                                                        | cell `values` (2D)           | synthesize / update |
| create/update/append doc, create/update/append/clear sheet, add sheet, folder, upload, share, rename/move/trash | (write — ask)                | only when user asks |

Prefer `create_spreadsheet` / `update_spreadsheet_values` / `append_spreadsheet_values` when the user wants a **Google Sheet**. Use the local xlsx skill only for a local `.xlsx` file. Drive mutations use `drive.file` and may fail (403) on files the app did not create or open.

## Google Calendar

| Tools                                                                 | Join keys out                                       | Typical next                      |
| --------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------- |
| `list_calendars`                                                      | **calendar_id**, summary, primary                   | event tools with `calendar_id`    |
| `list_events`, `search_events`                                        | event ids, titles, times                            | `get_event`                       |
| `get_event`                                                           | attendee **emails**, description links, `html_link` | Hub; Slack/Gmail; Drive; meetings |
| `query_freebusy`                                                      | busy intervals                                      | `create_event` scheduling         |
| `create_event` (optional Meet) / update / delete / `respond_to_event` | (write — ask)                                       | Hub-resolved emails first         |

Pass `calendar_id` on event tools when not using the primary calendar (from `list_calendars`).

## Meetings (first-party)

| Tools            | Join keys out                                      | Typical next                        |
| ---------------- | -------------------------------------------------- | ----------------------------------- |
| `meeting_search` | meeting **id**, title, date, summary               | `meeting_read`                      |
| `meeting_read`   | summary, action items, topics, optional transcript | synthesize; Sources as Meeting + id |

## Jira / Confluence (Atlassian)

| Tools                                              | Join keys out   | Typical next            |
| -------------------------------------------------- | --------------- | ----------------------- |
| `searchJiraIssuesUsingJql`, `getJiraIssue`, …      | issue key, URLs | status / agenda context |
| `searchConfluenceUsingCql`, `getConfluencePage`, … | page id, URLs   | docs context            |
| shared `searchAtlassian` / `fetchAtlassian`        | resource refs   | deepen                  |

## Breadth checklist (status / prep)

When the ask is status, brief, prep, or “what’s going on with X”, plan to touch
every **connected** system that can hold signal:

`[ ] Hub  [ ] Launchpad (if delivery)  [ ] Slack  [ ] Gmail  [ ] Meetings`
`[ ] Drive  [ ] Calendar  [ ] Jira  [ ] Confluence  [ ] Pulse (if metrics)`

Mark skipped (disconnected/error) in the reply. Never pretend you searched a
skipped connector.
