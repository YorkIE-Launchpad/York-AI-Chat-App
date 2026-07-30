---
name: york-os
description: >-
  York IE company OS router — Hub (people/culture/HR), R&D Launchpad (client
  SaaS delivery), R&D Pulse (project/platform analytics), GTM Pulse (GTM
  analytics), Slack, Gmail, Drive, Google Calendar (list/create invites), and
  Zoom-captured meetings. Use when answering company or work questions;
  scheduling or inviting people on Calendar; finding what was said, promised,
  agreed, or followed up; searching across Slack, email, meetings, or Drive;
  choosing among Hub / Launchpad / Pulse / communications tools; resolving
  people, commitments, action items, or follow-ups; or questions like "what
  did I tell/promise/agree", "what did we decide", "any open loops with X",
  "schedule a meeting with", "set up a meeting", "calendar invite".
---

# York OS — Tool Router

VECOS is York IE’s company OS: one assistant over internal platforms and
comms. This skill routes intent to the right sources. Deep Hub or Launchpad
workflows: load `hub-mcp` or `rnd-launchpad-mcp-sdlc` after routing here.

## Platform map

| System              | What it holds                                                              | How to use                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hub**             | People, culture, HR ops (employees, leave, timesheets, allocations, kudos) | Hub MCP → follow `hub-mcp`                                                                                                                                                             |
| **R&D Launchpad**   | Client SaaS build & delivery (releases, features, bugs, QA)                | Launchpad MCP → follow `rnd-launchpad-mcp-sdlc`                                                                                                                                        |
| **R&D Pulse**       | Analytics for that R&D product/project                                     | R&D Pulse MCP                                                                                                                                                                          |
| **GTM Pulse**       | GTM / go-to-market analytics                                               | GTM Pulse MCP                                                                                                                                                                          |
| **Slack**           | Chat, DMs, threads                                                         | MCP: `search_messages`, `get_thread`, `get_channel_history`, `get_user`; write: `post_message` (ask)                                                                                   |
| **Gmail**           | Email                                                                      | MCP: `search_emails`, `get_email`; write: `send_email`, `create_draft`, `update_draft` (ask)                                                                                           |
| **Drive**           | Docs, decks, shared files                                                  | MCP: `search_files`, `get_document_content`, …; write: `create_document`, `update_document_content`, `create_folder` (ask)                                                             |
| **Google Calendar** | Calendar events                                                            | MCP: `list_events`, `search_events`, `get_event`; write: `create_event`, `update_event`, `delete_event` (ask)                                                                          |
| **Jira**            | Issues, projects, JQL                                                      | MCP: `getJiraIssue`, `searchJiraIssuesUsingJql`, …; write: `createJiraIssue`, `editJiraIssue`, `transitionJiraIssue`, `addCommentToJiraIssue`, `addWorklogToJiraIssue` (ask)           |
| **Confluence**      | Pages, spaces, CQL                                                         | MCP: `getConfluencePage`, `searchConfluenceUsingCql`, …; write: `createConfluencePage`, `updateConfluencePage`, `createConfluenceFooterComment`, `createConfluenceInlineComment` (ask) |
| **Meetings**        | Captured Zoom/meeting notes & transcripts                                  | First-party: `meeting_search`, `meeting_read` (not MCP)                                                                                                                                |

GTM Launchpad is not in the MCP catalog — do not invent tools for it.

**Calendar vs Meetings (do not conflate):**

- Agenda / “what’s on my calendar” / “meetings tomorrow” / create or update an
  invite → **Google Calendar** MCP.
- Notes / transcripts / “what did we discuss” → **`meeting_search`** →
  `meeting_read`. Never use `meeting_search` as a substitute for Calendar.

## Intent → sources

| User intent                                                   | Start here                         | Then                                |
| ------------------------------------------------------------- | ---------------------------------- | ----------------------------------- |
| Who is / org / leave / timesheets / staffing                  | Hub                                | `hub-mcp` workflows                 |
| Feature, bug, release, delivery status                        | R&D Launchpad                      | Pulse for metrics if asked          |
| Metrics, usage, funnel, platform health                       | R&D Pulse or GTM Pulse (by domain) | —                                   |
| What was said / promised / agreed / action items / follow-ups | **Comms fan-out** (below)          | Synthesize with source + date       |
| Docs, decks, shared files                                     | Drive                              | Gmail search if email context helps |
| Calendar agenda / “meetings tomorrow” / list events           | Google Calendar `list_events`      | `search_events` / `get_event`       |
| Schedule / invite / “set up a meeting with …”                 | Hub resolve person → Calendar      | **Schedule with a person** (below)  |
| Meeting notes / “what did we discuss”                         | `meeting_search` → `meeting_read`  | Slack/Gmail if needed               |

## Hard rule — schedule with a person

For “schedule a meeting with X”, “set up a preview with Kalrav”, calendar
invites, or any ask to create an event with named York people:

1. **Resolve attendees via Hub first.** Use `list_employees` or
   `search_organization` (load `hub-mcp`). Use the returned **email** for
   Calendar `attendees`. Never ask the user for a company email when Hub
   returns a match. If Hub finds no one, say so and ask only then.
2. **Build description from tools when asked** (e.g. timesheet summary): Hub
   `generate_timesheet_summary` (or list + summarize) for the window the user
   named (e.g. last 10 days). Put that text in `create_event` `description`.
3. **Pick time.** If the user gave a time, use it. If not, prefer a sensible
   free gap from Calendar `list_events`, or one AskUserQuestion with 2–4
   concrete slots and exactly one `recommended`. Do not stall on meta asks.
4. **Call Google Calendar `create_event`** with `summary`, ISO `start`/`end`,
   `description`, and comma-separated `attendees` emails. Permission UI may
   prompt — still call the tool. Do not refuse and hand a copy-paste invite
   when `create_event` is available.
5. If Calendar MCP is disconnected or disabled, say that clearly. Do not
   pretend you created the event.

### Example

User: “Set a preview meeting with Kalrav Parsana; put my last 10 days timesheet
summary in the description.”

```text
→ Hub list_employees("Kalrav Parsana") → email
→ Hub generate_timesheet_summary(start/end for last 10 days)
→ Calendar list_events (optional, to pick a free slot) OR AskUserQuestion once for time
→ Calendar create_event(summary, start, end, description, attendees=email)
→ Reply with created event details
```

### Ask rules (scheduling)

- Never AskUserQuestion for meta permission (“may I ask…”, “can I proceed…”,
  “should I look up…”).
- Never ask for York employee emails when Hub can resolve the name.
- Time-only AskUserQuestion is fine when the slot is unspecified and a wrong
  guess would be costly; otherwise pick a reasonable default and proceed.

## Hard rule — commitments & promises

For questions like “what did I promise Jay?”, “what did I tell X?”, “any open
loops with Y?”, “what did we agree?”, or any ask about promises, commitments,
action items, or follow-ups:

1. **Do not answer from memory alone.** Search tools first.
2. Fan out across communications (**in parallel** when possible):
   - **Slack** — `search_messages` with the person name plus commitment cues
     (`promise`, `will`, `I'll`, `action`, `follow up`, `send`, `deliver`,
     `owe`, `by Friday`, etc.). Pull threads with `get_thread` when a hit is
     thin.
   - **Gmail** — `search_emails` with Gmail query syntax, e.g. person name,
     `from:me`, `to:Name`, recent window (`newer_than:90d`). `get_email` for
     promising hits.
   - **Meetings** — `meeting_search` for the person/topic → `meeting_read`
     (include transcript when action items are unclear).
   - **Drive** — only when the ask or hits imply a shared doc.
3. Resolve identity lightly if the name is ambiguous (Slack `get_user` or Hub
   employee search); otherwise query with the name as given.
4. **Synthesize** concrete commitments as bullets with **source + date**. If
   nothing solid is found, say so and list which sources were checked — never
   invent promises. Always end the reply with a `Sources:` section (see
   golden rules).
5. If a connector is disconnected or errors, skip it, note the gap, continue
   with the rest.

### Example

User: “What did I promise Jay?”

```text
→ Slack search_messages (Jay + commitment terms)
→ Gmail search_emails (Jay / from:me / newer_than:…)
→ meeting_search("Jay") → meeting_read on matches
→ Answer: bullets with source+date, or "checked Slack, Gmail, meetings — no clear promise found"
→ Sources: markdown links from tool payloads (or connector + id when no URL)
```

## Golden rules

1. Prefer tools over guessing. When the answer used MCP/linkable hits, **always**
   end with a `Sources:` section of bullet markdown links
   `[Title](https://...)` using real URLs from tool payloads (`html_link`,
   `web_view_link`, permalinks, issue/page URLs). If a hit has no URL, cite
   the connector and identifier as plain text — never invent URLs or sources.
2. Unavailable/disabled connector → state it; do not pretend you searched it.
3. This skill routes only. Deep Hub/Launchpad work → load those skills.
4. Answer in chat unless the user explicitly asks for a file.
