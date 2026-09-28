# Meeting prep — recurring vs one-off playbooks

Use for: “prep me for tomorrow”, “prepare agendas for next week”, “brief me on
my 3pm”, “what should I cover in X”.

**Not** for bare “what’s on my calendar Tuesday” (Calendar list only).

The deliverable is a **short, agenda-first brief per meeting**, not a dump of
everything found. Research widely, then synthesize: every line must earn its
place and cite a source.

## Step 0 — Find and classify each meeting

```text
list_events(window) → skip focus/OOO/holds/declined → get_event(eventId)
→ title, when, attendee emails, description, links
→ classify:
   RECURRING if get_event shows `RecurringEventId:` or `Recurrence:`/RRULE,
             or the event id looks like `<seriesId>_<YYYYMMDDTHHMMSSZ>`,
             or search_events(title, past 90d) finds 2+ earlier events with the same title
   otherwise ONE-OFF
```

Drop the user's own email from the attendee list before researching people.

## Playbook A — Recurring meeting

Goal: what changed since last time, whether last time's action items got done,
and what this session must decide.

```text
A1 History (sequential):
   search_events(query=title, time_min=now-90d, time_max=meeting start)
   → keep events whose id starts with the seriesId (or same title) → newest = "last held"
   get_event(last instance) → previous agenda / description
   meeting_search(title) and meeting_search(key attendee names)
   → keep notes dated on a past instance date or with the same title
   meeting_read(most recent match) → summary, key topics, ACTION ITEMS
A2 Verify each action item (parallel, cap 8, window = since last held):
   Slack search_messages("<distinctive words> after:<last date>")
   Gmail search_emails("newer_than:<N>d <distinctive words>") → get_email
   Jira searchJiraIssuesUsingJql(text ~ "<words>" AND updated >= "<last date>")
   Drive search_files("<words>") when the item mentions a doc/deck/sheet
   → status per item:
       Done         evidence shows it happened (message, merged ticket, sent doc)
       In progress  evidence of partial work
       Still open   evidence it is pending/blocked
       No update found   nothing found (never guess "Done")
A3 Context since last held (parallel):
   Slack DMs/threads with attendees + the best shared/project channel history
   Gmail with attendees; Jira/Launchpad/Confluence if delivery-ish
   Hub get_leave_wfh_calendar → who is out
```

## Playbook B — One-off meeting

Goal: who you're meeting, how the relationship got here, and what the meeting
should achieve.

```text
B1 Parties (parallel):
   Internal (@york.ie): Hub list_employees/search → role, squad; leave/WFH
   External: group by company domain (skip gmail/outlook/etc.)
     Hub list_clients / projects matching the company name
     WebFetch https://<domain> → one line on who they are
     Gmail search_emails("newer_than:180d (from:@domain OR to:@domain)") → get_email top threads
     Slack search_messages(("Company" OR "Person") after:<180d ago>) → get_thread on best hit
B2 Context (parallel, last 30d):
   Slack DMs with attendees; Gmail with attendees; Drive docs named in invite/threads;
   meeting_search(attendee names) for any earlier conversation;
   Jira/Launchpad/Confluence only if the title implies delivery work
```

## Synthesis rules (both playbooks)

- **Synthesize, don't dump.** No per-connector sections, no raw message lists.
- **Cite inline** with `[n]` after the claim; every claim, agenda item,
  question, and risk needs at least one source. If you cannot cite it, drop it.
- **Agenda:** 3–6 concrete topics, most important first, each with a one-line
  “why now”, suggested minutes, and owner only if a source names one. Put
  unresolved action items on the agenda when they matter.
- **Skip empty sections** entirely (never write “No Slack found”).
- **Sources go only at the end**, numbered to match the inline `[n]`, and list
  only sources actually cited. Follow with one line of connectors checked /
  not connected.
- If research found nothing beyond the invite, say so in the bottom line and
  keep the agenda minimal (cite the invite).
- Multi-meeting asks: one brief per meeting under a `## Week of …` heading;
  number sources per meeting.

## Output templates

Recurring:

```markdown
### <Title> · <Mon, Sep 28, 10:00> · Recurring (weekly) · last held <date>

**Bottom line:** <1–2 sentences on what this session must achieve>

**Since last time**

- <decision / progress / new issue> [2]

**Action items from <date>**

- **Done:** <item> (<owner>): <what shows it> [3]
- **In progress:** <item> (<owner>) [4]
- **No update found:** <item> (<owner>)

**Agenda**

1. **<Topic>** (10 min, <owner>) - <why now> [1][5]
2. …

**Questions to ask**

- … [4]

**Risks / watch-outs**

- … [6]

---

**Sources**

1. [Calendar invite: <title>](html_link)
2. [Slack #acme-delivery, 2026-09-24](permalink)
3. Meeting notes: <title>, <date> (meeting <id>)

_Checked: Calendar, Slack, Gmail, Jira, Meeting notes · Not connected: Confluence_
```

One-off: same skeleton, but replace **Since last time** and **Action items**
with:

```markdown
**Who you're meeting**

- **<Name>**: <role, company, relationship history with us> [2]

**Context so far**

- <key ask / proposal / open question from threads> [3]
```

## Worked example

User: “Prep me for my meetings tomorrow.”

```text
→ list_events(tomorrow) → 3 real meetings → get_event ×3 (parallel)
→ "Acme weekly" has RecurringEventId → Playbook A
    search_events("Acme weekly", past 90d) → last held Sep 21
    meeting_search("Acme weekly") → meeting_read → 4 action items
    per item: Slack + Gmail + Jira since Sep 21 (parallel)
→ "Intro: Globex x York" has no recurrence, external @globex.com → Playbook B
    Hub list_clients("Globex"); WebFetch globex.com; Gmail from:@globex.com 180d; Slack "Globex"
→ Reply: one brief per meeting using the templates above
```
