# Meeting prep — agendas from all connectors

Use for: “meetings next week and prepare agendas”, “prep me for tomorrow”,
“brief me on my meetings”, “what should I cover in X”.

**Not** for bare “what’s on my calendar Tuesday” (Calendar list only).

## Tool-call plan

```text
Phase 1: Calendar list_events(time_min/time_max for window) → event list
Phase 2: For each real meeting (skip focus/OOO noise) → get_event
         → eventId, title, when, attendee emails, description links
Phase 3 (parallel):
  - Hub list_employees / search for key attendees (if names without emails)
  - Hub get_leave_wfh_calendar for the same week (attendance)
  - Slack search_messages per meeting (title + key people)
  - Gmail search_emails (people / subject cues / newer_than window)
  - meeting_search(title or people) → ids of prior related meetings
  - Drive search_files / get_document_content when links or titles imply docs
  - Jira/Launchpad/Confluence only if title/attendees imply client delivery
Phase 4: Deepen — get_thread, get_email, meeting_read (transcript if actions unclear),
         Drive/Jira gets on best hits
Phase 5: Per-meeting agenda + Sources; list connectors checked/skipped
```

## Worked example

User: “Figure out my meetings for next week and prepare agendas.”

```text
→ Plan as above (do not narrate at length)
→ list_events(next Mon–Sun)
→ get_event on "Acme weekly", "Launchpad sync", …
→ emails: a@york…, b@client…
→ parallel: Hub leave; Slack "Acme"; Gmail "Acme newer_than:14d";
            meeting_search("Acme"); Drive if description has doc link
→ meeting_read / get_thread / get_email on hits
→ Reply with per-meeting sections (template below)
```

## Output template

```markdown
## Week of <dates>

### <Meeting title> — <when>

- **Goal / likely purpose:** … (from invite + context; say if only invite known)
- **Attendees / notes:** … (Hub leave/WFH if relevant)
- **Recent context:** bullets from Slack/Gmail/prior meetings with dates
- **Open loops / action items:** … (from meeting_read / threads / mail)
- **Suggested agenda:** 3–6 concrete items **grounded in sources**

(repeat per meeting)

### Connectors

- Checked: …
- Skipped: … (disconnected / n/a)

Sources:

- [Event](html_link) …
- [Slack …](permalink) …
- Meeting <id> — <title>
- …
```

## Rules

- Never invent talking points. If enrichment is empty, say “no recent Slack /
  email / meeting notes found” and keep agenda minimal from the invite only.
- Chain emails from Calendar into Hub/Slack/Gmail — do not re-ask the user.
- Prefer parallel Phase 3 calls. Cap deepen to promising hits.
- Always end with `Sources:` using real URLs or connector + id.
