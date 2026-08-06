---
name: york-os
description: >-
  York IE company OS router and multi-source tool planner — Hub
  (people/culture/HR/clients/projects), R&D Launchpad (client SaaS delivery),
  R&D Pulse / GTM Pulse (analytics), Slack, Gmail, Drive, Google Calendar,
  Jira, Confluence, and Zoom-captured meetings. Use for company or work
  questions; multi-connector tool planning with cross-tool ID chaining;
  prepare agendas / meeting prep; brief me / catch me up / what's coming up;
  client status / project status / "how is project Y" / "update on client Z";
  who is out; open loops / promises / follow-ups; scheduling or calendar
  invites; searching across Slack, email, meetings, or Drive; choosing among
  Hub / Launchpad / Pulse / communications tools.
---

# York OS — Tool Router

VECOS is York IE’s company OS: one assistant over internal platforms and
comms. Prefer connected York systems over web search or invented status.
Deep Hub or Launchpad workflows: load `hub-mcp` or `rnd-launchpad-mcp-sdlc`
after routing here.

**References (load when needed):**

- [connectors.md](references/connectors.md) — tools + join keys
- [tool-planning.md](references/tool-planning.md) — plan-then-execute (500+ tools)
- [meeting-prep.md](references/meeting-prep.md) — agendas / prep
- [work-brief.md](references/work-brief.md) — catch-me-up / person / open loops
- [client-status.md](references/client-status.md) — client account briefs
- [project-status.md](references/project-status.md) — project delivery briefs

## Platform map

| System              | What it holds                                                             | How to use                                                                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hub**             | People, HR, clients, projects, leave, timesheets, allocations, quotations | Hub MCP → follow `hub-mcp`                                                                                                                                                                                                                                                                                            |
| **R&D Launchpad**   | Client SaaS build & delivery (releases, features, bugs, QA)               | Launchpad MCP → follow `rnd-launchpad-mcp-sdlc`                                                                                                                                                                                                                                                                       |
| **R&D Pulse**       | Analytics for that R&D product/project                                    | R&D Pulse MCP (discover live tools)                                                                                                                                                                                                                                                                                   |
| **GTM Pulse**       | GTM / go-to-market analytics                                              | GTM Pulse MCP (discover live tools)                                                                                                                                                                                                                                                                                   |
| **Slack**           | Chat, DMs, threads                                                        | MCP: `search_messages`, `get_thread`, `get_channel_history`, `get_user`; write: `post_message` (ask; never `#general` / `#virtual-water-cooler`)                                                                                                                                                                      |
| **Gmail**           | Email                                                                     | MCP: `search_emails`, `get_email`, `list_labels`; write: `send_email`, `create_draft`, `update_draft`, `send_draft`, `modify_email_labels`, `trash_email` (ask; optional `body_html`)                                                                                                                                 |
| **Drive**           | Docs, Sheets, decks, shared files                                         | MCP: `search_files`, `get_document_content`, `get_spreadsheet_values`, …; write: docs/sheets/folders, `append_*`, `upload_file`, `share_file`, `rename_file` / `move_file` / `trash_file` (ask). Mutations may 403 on files not created/opened by the app (`drive.file`). Prefer Google Sheets tools over local xlsx. |
| **Google Calendar** | Calendar events                                                           | MCP: `list_calendars`, `list_events`, `search_events`, `get_event`, `query_freebusy`; write: `create_event` (optional Meet), `update_event`, `delete_event`, `respond_to_event` (ask). Pass `calendar_id` (default primary).                                                                                          |
| **Jira**            | Issues, projects, JQL                                                     | MCP: `getJiraIssue`, `searchJiraIssuesUsingJql`, …; write: `createJiraIssue`, `editJiraIssue`, `transitionJiraIssue`, `addCommentToJiraIssue`, `addWorklogToJiraIssue` (ask)                                                                                                                                          |
| **Confluence**      | Pages, spaces, CQL                                                        | MCP: `getConfluencePage`, `searchConfluenceUsingCql`, …; write: `createConfluencePage`, `updateConfluencePage`, `createConfluenceFooterComment`, `createConfluenceInlineComment` (ask)                                                                                                                                |
| **Meetings**        | Captured Zoom/meeting notes & transcripts                                 | First-party: `meeting_search`, `meeting_read` (not MCP)                                                                                                                                                                                                                                                               |

GTM Launchpad is not in the MCP catalog — do not invent tools for it.

**Three calendars (do not conflate):**

- **Google Calendar** — schedule / invites / “what’s on my calendar”.
- **`meeting_search` / `meeting_read`** — Zoom-captured notes & transcripts
  (“what did we discuss”). Never substitute for Calendar.
- **Hub `get_leave_wfh_calendar`** — who is on leave / WFH (“who’s out”).

## Hard rule — Plan then execute

For multi-source company asks (prep, brief, status, open loops, catch-me-up):

1. **Classify** intent (see table below).
2. Form a **short tool-call plan**: systems to touch, phases, join keys,
   what runs in parallel. Do **not** dump a long preamble to the user — start
   working. See [tool-planning.md](references/tool-planning.md).
3. **Execute** phase by phase. Revise the plan when new ids/emails/keys appear.
4. With 500+ tools / meta mode: narrow `mcp_search_tools` by connector +
   keyword; after matches, **immediately** `mcp_call_tool`.
5. Skip disconnected connectors; note gaps; continue. Cap depth: enrich
   meaningful items; deepen only promising hits.

## Hard rule — Cross-tool chaining

Reuse every useful key from prior results. Never ask the user for a company
email, client id, or project id a tool already returned.

| From                        | Extract                                    | Feed into                                                               |
| --------------------------- | ------------------------------------------ | ----------------------------------------------------------------------- |
| Calendar events             | eventId, title, attendee **emails**, links | Hub people/leave; Slack/Gmail; Drive; `meeting_search`                  |
| Hub employees               | **email**, name, squad                     | Calendar attendees; Slack; Gmail; leave                                 |
| Hub clients                 | **clientId**, name                         | projects, quotations; Slack/Gmail/Drive/meetings; Launchpad             |
| Hub quotations              | quotation id, **project ids**              | Hub projects/allocations; Launchpad; Jira                               |
| Hub projects / summaries    | **projectId**, title, client               | allocations, release notes; Launchpad; Jira; Slack/Gmail/Drive/meetings |
| Hub allocations             | staff **emails**                           | leave; Slack; Calendar                                                  |
| Launchpad projects/releases | Launchpad **projectId**, release ids       | scope/QA; Hub by name; Jira; Pulse                                      |
| Slack search                | channel + `thread_ts`, permalink           | `get_thread`; Sources                                                   |
| Gmail search                | message id, Drive links                    | `get_email`; Drive content                                              |
| `meeting_search`            | meeting `id`                               | `meeting_read`                                                          |
| Jira / Confluence           | issue key / page id                        | get issue/page                                                          |
| Pulse                       | live metric tools                          | after identity known, if metrics/status is broad                        |

Full map: [connectors.md](references/connectors.md).

## Intent → sources

| User intent                                    | Start here                           | Then                                                                        |
| ---------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| Who is / org / leave / timesheets / staffing   | Hub                                  | `hub-mcp`                                                                   |
| Who’s out this week                            | Hub `get_leave_wfh_calendar`         | not Google Calendar                                                         |
| Feature, bug, release, delivery ops            | R&D Launchpad                        | `rnd-launchpad-mcp-sdlc`; Pulse if metrics                                  |
| Metrics, usage, funnel, platform health        | R&D Pulse or GTM Pulse               | discover live tools                                                         |
| What was said / promised / agreed / open loops | **Comms fan-out**                    | [work-brief.md](references/work-brief.md)                                   |
| Catch me up / brief me / status with a person  | **Plan + fan-out**                   | [work-brief.md](references/work-brief.md)                                   |
| **Client status** / update on client Z         | Hub clients                          | [client-status.md](references/client-status.md) — all relevant connectors   |
| **Project status** / how is project Y          | Hub projects                         | [project-status.md](references/project-status.md) — Hub + Launchpad + comms |
| Docs, decks, shared files                      | Drive                                | Gmail if email context helps                                                |
| List only: “what’s on my calendar Tuesday”     | Google Calendar `list_events`        | `get_event` if detail needed                                                |
| **Prep / prepare agendas / prep for meetings** | Calendar then **Enrichment fan-out** | [meeting-prep.md](references/meeting-prep.md)                               |
| Schedule / invite / “set up a meeting with …”  | Hub resolve → Calendar               | **Schedule with a person**                                                  |
| Meeting notes / “what did we discuss”          | `meeting_search` → `meeting_read`    | Slack/Gmail if needed                                                       |
| Jira tickets / Confluence wiki                 | Jira / Confluence                    | Hub/Launchpad if delivery context                                           |

**List vs prep:** listing the calendar is Calendar-only. Preparing agendas,
briefing, or enriching meetings is **never** Calendar-alone — run enrichment.

## Hard rule — Enrichment fan-out (meeting prep)

For “prepare agendas”, “prep for next week”, “brief me on my meetings”:

1. Calendar `list_events` for the window → skip noise (focus blocks) →
   `get_event` for each real meeting → emails, title, links.
2. **Parallel:** Hub resolve key attendees + leave for the week; Slack
   `search_messages` (+ `get_thread`); Gmail `search_emails` / `get_email`;
   `meeting_search` → `meeting_read`; Drive when links/titles imply docs;
   Jira/Launchpad/Confluence when title/attendees imply delivery.
3. Synthesize **per-meeting** agendas grounded in sources. Never invent
   talking points. End with `Sources:`.

Details: [meeting-prep.md](references/meeting-prep.md).

## Hard rule — schedule with a person

For “schedule a meeting with X”, calendar invites with named York people:

1. **Resolve attendees via Hub first.** `list_employees` or
   `search_organization` (load `hub-mcp`). Use returned **email** for
   Calendar `attendees`. Never ask for a company email when Hub matches.
2. **Build description from tools when asked** (e.g. timesheet summary): Hub
   `generate_timesheet_summary` for the named window → `create_event`
   `description`.
3. **Pick time.** User-given time, or free gap from `list_events`, or one
   AskUserQuestion with 2–4 slots and exactly one `recommended`.
4. **Call** Calendar `create_event` with `summary`, ISO `start`/`end`,
   `description`, comma-separated `attendees`. Permission UI may prompt —
   still call. Do not hand a copy-paste invite when the tool is available.
5. If Calendar is disconnected, say so clearly.

### Example

User: “Set a preview meeting with Kalrav Parsana; put my last 10 days timesheet
summary in the description.”

```text
→ Hub list_employees("Kalrav Parsana") → email
→ Hub generate_timesheet_summary(start/end for last 10 days)
→ Calendar list_events (optional free slot) OR AskUserQuestion once for time
→ Calendar create_event(summary, start, end, description, attendees=email)
→ Reply with created event details
```

### Ask rules (scheduling)

- Never AskUserQuestion for meta permission (“may I ask…”, “can I proceed…”).
- Never ask for York employee emails when Hub can resolve the name.
- Time-only AskUserQuestion is fine when the slot is unspecified and a wrong
  guess would be costly; otherwise pick a reasonable default and proceed.

## Hard rule — commitments & promises

For “what did I promise Jay?”, “any open loops with Y?”, agreements,
action items, follow-ups:

1. **Do not answer from memory alone.** Search tools first.
2. Fan out (**in parallel**): Slack (`search_messages` + commitment cues →
   `get_thread`); Gmail (`search_emails` / `get_email`); `meeting_search` →
   `meeting_read`; Drive only when implied.
3. Resolve identity lightly if ambiguous (Hub / Slack `get_user`).
4. **Synthesize** with **source + date**. If nothing solid, say so and list
   sources checked — never invent. End with `Sources:`.
5. Skip disconnected connectors; note gaps; continue.

See [work-brief.md](references/work-brief.md).

### Example

User: “What did I promise Jay?”

```text
→ Slack search_messages (Jay + commitment terms)
→ Gmail search_emails (Jay / from:me / newer_than:…)
→ meeting_search("Jay") → meeting_read on matches
→ Answer: bullets with source+date, or "checked Slack, Gmail, meetings — none found"
→ Sources: markdown links from tool payloads (or connector + id when no URL)
```

## Golden rules

1. Prefer tools over guessing. When the answer used MCP/linkable hits,
   **always** end with a `Sources:` section of bullet markdown links
   `[Title](https://...)` using real URLs from tool payloads (`html_link`,
   `web_view_link`, permalinks, issue/page URLs). If a hit has no URL, cite
   the connector and identifier as plain text — never invent URLs or sources.
2. Unavailable/disabled connector → state it; do not pretend you searched it.
   For status/prep, list which systems were checked and which were skipped.
3. This skill routes and plans. Deep Hub/Launchpad work → load those skills.
4. Answer in chat unless the user explicitly asks for a file.
5. Never invent agenda items, commitments, or client/project status.
