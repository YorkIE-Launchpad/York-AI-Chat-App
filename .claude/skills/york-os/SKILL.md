---
name: york-os
description: >-
  York IE company OS router — Hub (people/culture/HR), R&D Launchpad (client
  SaaS delivery), R&D Pulse (project/platform analytics), GTM Pulse (GTM
  analytics), Slack, Gmail, Drive, and Zoom-captured meetings. Use when
  answering company or work questions; finding what was said, promised, agreed,
  or followed up; searching across Slack, email, meetings, or Drive; choosing
  among Hub / Launchpad / Pulse / communications tools; resolving people,
  commitments, action items, or follow-ups; or questions like "what did I
  tell/promise/agree", "what did we decide", "any open loops with X".
---

# York OS — Tool Router

VECOS is York IE’s company OS: one assistant over internal platforms and
comms. This skill routes intent to the right sources. Deep Hub or Launchpad
workflows: load `hub-mcp` or `rnd-launchpad-mcp-sdlc` after routing here.

## Platform map

| System            | What it holds                                                              | How to use                                                              |
| ----------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Hub**           | People, culture, HR ops (employees, leave, timesheets, allocations, kudos) | Hub MCP → follow `hub-mcp`                                              |
| **R&D Launchpad** | Client SaaS build & delivery (releases, features, bugs, QA)                | Launchpad MCP → follow `rnd-launchpad-mcp-sdlc`                         |
| **R&D Pulse**     | Analytics for that R&D product/project                                     | R&D Pulse MCP                                                           |
| **GTM Pulse**     | GTM / go-to-market analytics                                               | GTM Pulse MCP                                                           |
| **Slack**         | Chat, DMs, threads                                                         | MCP: `search_messages`, `get_thread`, `get_channel_history`, `get_user` |
| **Gmail**         | Email                                                                      | MCP: `search_emails`, `get_email`                                       |
| **Drive**         | Docs, decks, shared files                                                  | MCP: `search_files`, `get_document_content`, …                          |
| **Meetings**      | Captured Zoom/meeting notes & transcripts                                  | First-party: `meeting_search`, `meeting_read` (not MCP)                 |

GTM Launchpad is not in the MCP catalog — do not invent tools for it.

## Intent → sources

| User intent                                                   | Start here                         | Then                                |
| ------------------------------------------------------------- | ---------------------------------- | ----------------------------------- |
| Who is / org / leave / timesheets / staffing                  | Hub                                | `hub-mcp` workflows                 |
| Feature, bug, release, delivery status                        | R&D Launchpad                      | Pulse for metrics if asked          |
| Metrics, usage, funnel, platform health                       | R&D Pulse or GTM Pulse (by domain) | —                                   |
| What was said / promised / agreed / action items / follow-ups | **Comms fan-out** (below)          | Synthesize with source + date       |
| Docs, decks, shared files                                     | Drive                              | Gmail search if email context helps |
| Meeting notes / “what did we discuss”                         | `meeting_search` → `meeting_read`  | Slack/Gmail if needed               |

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
   invent promises.
5. If a connector is disconnected or errors, skip it, note the gap, continue
   with the rest.

### Example

User: “What did I promise Jay?”

```text
→ Slack search_messages (Jay + commitment terms)
→ Gmail search_emails (Jay / from:me / newer_than:…)
→ meeting_search("Jay") → meeting_read on matches
→ Answer: bullets with source+date, or "checked Slack, Gmail, meetings — no clear promise found"
```

## Golden rules

1. Prefer tools over guessing. Cite **Sources** for MCP/linkable hits.
2. Unavailable/disabled connector → state it; do not pretend you searched it.
3. This skill routes only. Deep Hub/Launchpad work → load those skills.
4. Answer in chat unless the user explicitly asks for a file.
