---
name: hub-mcp
description: >-
  Operates York Hub via the york-hub / user-york-hub MCP server using
  PROJECT_CONTEXT domain semantics: org announcements, employees, projects,
  allocations/bench, timesheets, leave/WFH, hiring, MBO, inventory, hub
  requests, kudos, clients, quotations, and analytics. Use when calling Hub
  MCP tools, answering Hub data questions through MCP, choosing among those
  tools, or explaining Hub workflows/RBAC to the user.
---

# Hub MCP — Platform & Tool Guide

York IE Hub is an internal **HRMS / employee-operations** platform for York IE
Labs (consultancy, ~100–500 people). **Hub MCP** (`hub-mcp/`, Cursor server
`york-hub` / `user-york-hub`) authenticates the employee and forwards tools to
Nest. **Nest owns validation, business rules, and RBAC.** MCP never duplicates
logic or queries Hub business tables.

Read this skill before selecting tools. Deep domain copy:
[platform.md](platform.md). Per-tool semantics: [tools.md](tools.md).
Canonical inventory: `docs/PROJECT_CONTEXT.md`.

## Mental model

| Actor              | Typical needs                                                |
| ------------------ | ------------------------------------------------------------ |
| Employee           | Own timesheets, leave/WFH, kudos, hub requests, profile      |
| Manager            | Approval inboxes, team timesheets/MBO, calendar, allocations |
| Delivery lead / EM | Projects, allocations, bench AI, release notes, red flags    |
| Recruiter / HM     | Positions, candidates, interviews                            |
| HR / ops           | Announcements, inventory reads, onboarding analytics         |
| Leadership         | Analytics catalog + utilization / hiring / MBO reports       |
| MCP session        | **Same Cognito user** as Hub UI → same permissions           |

**Identity key:** employee **email** (not numeric ids) for people, timesheets,
leave, kudos, many filters.

**Org vocabulary:** Function → Squad → Guild; reporting tree drives approvals;
**Project** = client delivery; **Allocation** = full/partial/**burst**;
**Bench** = under-allocated people; **Bucket** = project capacity vs hours.

## How Hub MCP works

```text
AI client → OAuth Connect → Hub SPA /mcp/authorize (Allow)
  → Sealed Bearer (Cognito AES-encrypted; never shown to LLM)
  → MCP tools → Nest /api/* under caller RBAC
```

Rules:

1. On auth failures → `mcp_auth` (empty) → retry once.
2. Prefer **list/search → get → mutate**.
3. Dates: `YYYY-MM-DD` unless schema says otherwise; announcement expiry is
   unix **seconds**; leave/WFH calendar `month` is **0–11**.
4. Policy/RBAC errors are expected — explain; do not bypass.
5. Never invent Hub records or analytics numbers.
6. No MCP for: file upload/download, balance adjustments, salary burn / OT
   report exports, Risk Register, Vault, Shop checkout, Policy Center, etc.

## Intent → tools (start here)

| User intent                                                 | Start                                                                 | Then                                                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Find a person / “who is”                                    | `list_employees` or `search_organization`                             | `get_employee_profile` / `get_employee_team`                                                                            |
| Calendar invite / Slack DM / kudos / any tool needing email | `list_employees` (name → **email**)                                   | Pass email to Calendar `attendees`, Slack, `send_kudos`, etc. — never ask the user for a company email when Hub matches |
| Company / dashboard news                                    | `list_announcements`                                                  | `get_announcement`; mutate only with `manage-announcements`                                                             |
| Project picker                                              | `list_projects` (id+title)                                            | `get_project`                                                                                                           |
| Delivery overview                                           | `list_project_summaries` (`active`?)                                  | allocations / release notes / jira quality                                                                              |
| Who is staffed                                              | `list_project_allocations`                                            | `get_project_allocation_timeline` (project id + email; **employee-scoped**)                                             |
| Find bench people                                           | `send_project_bench_suggestions_chat` or project/position bench tools | Use returned emails with employee tools                                                                                 |
| Log my hours                                                | `list_my_timesheet_drafts`                                            | `bulk_save_timesheets` → `submit_timesheet_draft`                                                                       |
| Approve hours                                               | `list_pending_timesheet_reviews`                                      | `bulk_approve_timesheets_by_filters` (`approved_by` email)                                                              |
| Book leave                                                  | `list_my_leave_requests` / calendar                                   | `apply_for_leave`                                                                                                       |
| Book WFH                                                    | `get_wfh_summary` / calendar                                          | `apply_for_work_from_home` (`reason` ≥ 10 chars)                                                                        |
| Manager approval inbox                                      | `list_pending_leave_wfh_requests`                                     | `review_leave_request` / `review_work_from_home_request`                                                                |
| Hiring pipeline                                             | `list_hiring_positions`                                               | candidates → interviews                                                                                                 |
| Team goals                                                  | `get_team_mbo_statuses` (year)                                        | `list_mbos` / `get_mbo`                                                                                                 |
| Hardware / SaaS                                             | `list_inventory_items` / `list_software_subscriptions`                | get + history/metrics                                                                                                   |
| Product idea / bug for Hub                                  | `create_hub_request`                                                  | list/stats/upvote/comment                                                                                               |
| Thank a peer                                                | resolve email                                                         | `send_kudos` (message + category)                                                                                       |
| Client / quote lookup                                       | `list_clients` / `list_quotations`                                    | get + items + linked projects                                                                                           |
| KPIs / red flags                                            | `get_analytics_dashboard_catalog`                                     | specific `get_*_analytics`                                                                                              |

## Domain semantics LLMs must know

### Timesheets (`docs/PROJECT_CONTEXT` → Timesheet)

- Drafts may be auto-created from calendar/Jira/Gerrit; streaks can gate Hub.
- Status: `DRAFT` → `SUBMITTED` → `APPROVED` \| `REJECTED`.
- Category: `PROJECT` (needs `timesheet_project_id`) \| `MANAGEMENT` \| `BENCH`.
- `bulk_save_timesheets` = atomic multi-row for **current user only**.
- Work-item configs = admin labels for logging taxonomy.
- AI helpers draft description/summary; they do not submit.

### Leave & WFH

- Leave types: `SICK`, `PRIVILEGE`, `MATERNITY`, `PATERNITY`, `UNPAID`,
  `FESTIVAL`, `FLOATING_VACATION`.
- Length: `FULL_DAY` \| `FIRST_HALF` \| `SECOND_HALF`.
- Serving notice: unused sick + floating vacation expire; privilege stays with
  approval.
- Apply tools run Nest validation (balances, conflicts, routing).
- Review actions: `APPROVED` \| `REJECTED`.
- Calendar combines **approved** leave+WFH; pending inbox is manager-scoped.

### Projects

- Ownership roles in Hub (PM, strategist, lead, …) appear on project metadata
  when permitted.
- Allocations track full/partial/burst staffing.
- Release notes: `DRAFT` \| `PUBLISHED` (Jira import / AI summaries in Hub).
- Bench tools rank available people with match reasoning; chat supports
  `conversation_id` for multi-turn.

### Hub Requests (product feedback)

- Not IT inventory tickets — internal enhancement/issue board.
- Type `enhancement` \| `issue`; status `open` → `in_progress` → `done`;
  priority `low`\|`moderate`\|`high`\|`critical`.
- Create needs **business_reason**; `finalize` when ready for notifications.
- Comments: requester, assignee, or moderator only.

### Announcements

- Org culture surface on dashboard; country `ALL`/`IN`/`US`.
- Mutates need `manage-announcements`; no attachments via MCP.

### Analytics (read-only)

- Employee overview KPIs are **India-scoped**.
- MBO analytics need `type` + fiscal `year`; discover years first.
- Timesheet analytics require date range ≤ **366** days.
- Bucket utilisation bands: `low` \| `medium` \| `high` \| `over`.
- Optional `forceFetch` bypasses cache where supported.
- Salary burn / OT report generation are **not** MCP tools.

### Inventory

- Hardware assignment categories (interpret history): Intern, Contractor,
  Company Use, Accessories/Extra Hardware, Employee.
- Software statuses: ACTIVE / TRIAL / PAUSED / EXPIRED / CANCELLED.
- MCP is read-only (no assign/reassign).

### Clients / quotations / hiring / MBO / kudos

- Clients need `view-clients` (or stronger); personas/AI sync are UI-only.
- Quotations: inspect quotes/items/linked projects — not full SOW authoring.
- Hiring MCP stops at positions/candidates/interviews (+ position bench).
- MBO MCP is mostly read (team boards need year).
- Kudos send may trigger Hub review + optional shop coins.

## Workflow checklists

**Resolve person:** search/list → use **email** everywhere downstream
(including Google Calendar `create_event` `attendees`, Slack, kudos).

**Timesheet week:** drafts → bulk save → optional AI → submit → (manager)
pending → bulk approve.

**Leave day:** calendar/summary → apply → (manager) pending → review.

**Staffing question:** project summaries → allocations and/or bench chat →
employee profiles for shortlisted emails.

**Analytics answer:** catalog/years → exact report tool → cite filters/year →
never invent.

**Safe mutate:** confirm target with get/list → smallest matching tool → on
403/401 explain missing Hub permission.

## Response style

- Cite tool results; say when RBAC hid fields.
- Prefer short tables for lists.
- Name analytics tool + year/range used.
- If incomplete, name the next tool that would fill the gap.
- Point users to Hub UI for non-MCP surfaces (Risk Register, Vault, Policy
  Center, documents, confirmations, shop, etc.).

## Extending Hub MCP (repo)

1. Ship Nest API + RBAC (`route-config.service.ts`).
2. Add `hub-mcp/src/modules/<name>/` with descriptions from
   `docs/PROJECT_CONTEXT.md`.
3. Register in `hub-mcp/src/index.ts`.
4. Update [tools.md](tools.md), [platform.md](platform.md), `hub-mcp/README.md`.
