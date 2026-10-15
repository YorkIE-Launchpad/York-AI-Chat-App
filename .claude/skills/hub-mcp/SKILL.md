---
name: hub-mcp
description: >-
  Operates York Hub via the york-hub / user-york-hub MCP server using
  PROJECT_CONTEXT domain semantics: org announcements, employees, organization
  (org chart, reportees, squad team), projects, meeting notes, workspace
  calendar, allocations/bench, timesheets, leave/WFH, hiring, MBO, inventory,
  hub requests, kudos, clients, quotations, and analytics. Use when calling Hub
  MCP tools, answering Hub data questions through MCP, choosing among those
  tools, or explaining Hub workflows/RBAC to the user.
---

# Hub MCP — Platform & Tool Guide

York IE Hub is an internal **HRMS / employee-operations** platform for York IE
Labs (consultancy, ~100–500 people). **Hub MCP** (`hub-mcp/`, Cursor server
`york-hub` / `user-york-hub`) authenticates the employee and forwards **118
tools** to Nest. **Nest owns validation, business rules, and RBAC.** MCP never
duplicates logic or queries Hub business tables.

Read this skill before selecting tools. Deep domain copy:
[platform.md](platform.md). Per-tool semantics: [tools.md](tools.md).
Canonical inventory: `docs/PROJECT_CONTEXT.md`. Runtime bootstrap:
`hub-mcp/knowledge/` (`hub://glossary`, `hub://intent-map`, `hub://platform`).

## Mental model

| Actor              | Typical needs                                                   |
| ------------------ | --------------------------------------------------------------- |
| Employee           | Own timesheets, leave/WFH, kudos, hub requests, profile         |
| Manager            | Approval inboxes, reportees/org chart, timesheets/MBO, calendar |
| Delivery lead / EM | Projects, allocations, bench AI, meeting notes, release notes   |
| Recruiter / HM     | Positions, candidates, interviews, position bench suggestions   |
| HR / ops           | Announcements, inventory reads, onboarding analytics            |
| Leadership         | Analytics catalog + utilization / hiring / MBO reports          |
| MCP session        | **Same Cognito user** as Hub UI → same permissions              |

**Identity key:** employee **email** (not numeric ids) for people, timesheets,
leave, kudos, many filters.

**Org vocabulary:** Function → Squad → Guild; **reporting tree** (`get_org_chart`,
`list_reportees`) drives approvals; **squad team** (`get_employee_team`) is a
different concept — use both when the user asks for “reportees and team”.
**Project** = client delivery; **Allocation** = full/partial/**burst**;
**Bench** = under-allocated staffing (KPIs → `get_employee_project_allocation_analytics`;
search → `send_bench_suggestions`; timesheet `BENCH` category ≠ staffing bench);
**Bucket** = project capacity vs hours.

## How Hub MCP works

```text
AI client → OAuth Connect → Hub SPA /mcp/authorize (Allow)
  → Sealed Bearer (Cognito AES-encrypted; never shown to LLM)
  → MCP tools (permission-filtered per session) → Nest /api/* under caller RBAC
```

Rules:

1. On auth failures → `mcp_auth` (empty) → retry once.
2. Prefer **list/search → get → mutate**.
3. Dates: `YYYY-MM-DD` unless schema says otherwise; announcement expiry is
   unix **seconds**; leave/WFH **calendar** `month` is **0–11**; WFH **analytics**
   `month` is **1–12**.
4. **Reconnect MCP** after Hub permission grants change (`tools/list` is filtered).
5. Policy/RBAC errors are expected — explain; do not bypass. MCP may deny
   before Nest with a generic unauthorized message (no internal permission names).
6. Never invent Hub records or analytics numbers.
7. No MCP for: generic arbitrary file upload/download, HR balance-adjustment
   mutations, salary burn / OT report exports, Risk Register, Vault, Shop
   checkout, Policy Center, etc. **Exception:** presigned Zoom recording/transcript
   URLs via `fetch_project_meeting_artifact_urls`.

## Intent → tools (start here)

| User intent                                     | Start                                                                          | Then                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Find a person / “who is”                        | `list_employees` or `search_organization`                                      | `get_employee_profile`                                                                                              |
| Org chart / who reports to whom                 | `get_org_chart` (email; optional `max_depth`)                                  | Present tree via `manager_email` / `depth`; on reportees 403 use `descendants`                                      |
| Manager reportees roster                        | `list_reportees` (email)                                                       | Pair with `get_employee_team` if user also said “team”                                                              |
| Squad / “who is on their team”                  | `get_employee_team` (`email`, `include_profiles` true)                         | Not the same as `list_reportees` — label sections separately                                                        |
| Resolve email for another tool                  | `list_employees` (name → **email**)                                            | Pass email to kudos, allocations, calendar `subject`, etc. — do not ask for company email when Hub matches          |
| Company / dashboard news                        | `list_announcements`                                                           | `get_announcement`; mutate only with `manage-announcements`                                                         |
| Project picker / meeting notes                  | `list_projects` (id+title)                                                     | `get_project`, `fetch_project_meeting_notes` (use row `id`, not `zoom_meeting_id`)                                  |
| Delivery overview                               | `list_project_summaries` (`active`?)                                           | allocations / release notes / jira quality                                                                          |
| Who is staffed on a project                     | `list_project_allocations`                                                     | profiles for emails if needed                                                                                       |
| Employee allocation history                     | `get_project_allocation_timeline` (project id + email) **or**                  | `get_employee_project_timeline` (employee, squad, or project filter)                                                |
| Bench strength / utilization / who’s available  | `get_employee_project_allocation_analytics`                                    | Not timesheet `BENCH` category alone                                                                                |
| Find bench people (NL search)                   | `send_bench_suggestions` (optional `conversation_id`)                          | `get_hiring_position_bench_suggestions` for a **role**; then employee profiles                                      |
| Project Zoom notes / transcript                 | `list_projects` → `fetch_project_meeting_notes`                                | `fetch_project_meeting_note`; `fetch_project_meeting_transcript` or `fetch_project_meeting_artifact_urls` if needed |
| Find/delete Workspace calendar event (delivery) | `list_workspace_calendar_events` (`subject` email, `q` = Zoom id)              | `delete_workspace_calendar_event` — requires `manage-projects`                                                      |
| Log my hours                                    | `list_my_timesheet_drafts`                                                     | `bulk_save_timesheets` → `submit_timesheet_draft`                                                                   |
| Show / list hours **in a calendar window**      | `list_projects` (if named) → `list_timesheets` or `generate_timesheet_summary` | `YYYY-MM-DD` start/end; filter by project id when named                                                             |
| Show **last N hours logged**                    | `list_projects` → `list_timesheets` (wide recent range + project)              | Sort newest; accumulate row `hours` until ≥ N — not N days or wall-clock 24h                                        |
| Approve hours                                   | `list_pending_timesheet_reviews`                                               | `bulk_approve_timesheets_by_filters` (`approved_by` email)                                                          |
| Book leave                                      | `check_leave_wfh_conflicts` / calendar                                         | `apply_for_leave`; edit/withdraw → `update_leave_request` / `delete_leave_request`                                  |
| Book WFH                                        | `get_wfh_summary` / conflict checks                                            | `apply_for_work_from_home` (`policy_reason`; `reason` ≥ 10 chars only if `OTHER`)                                   |
| Manager approval inbox                          | `list_pending_leave_wfh_requests` or domain-specific pending lists             | `review_leave_request` / `review_work_from_home_request`; hybrid pilot → `toggle_hybrid_wfh_pilot`                  |
| WFH compliance / tables                         | `get_wfh_analytics`                                                            | `get_wfh_analytics_tables` for paginated breakdowns                                                                 |
| Hiring pipeline                                 | `list_hiring_positions`                                                        | candidates → interviews                                                                                             |
| Team goals                                      | `get_team_mbo_statuses` (year)                                                 | `list_mbos` / `get_mbo`                                                                                             |
| Hardware / SaaS                                 | `list_inventory_items` / `list_software_subscriptions`                         | get + history/metrics                                                                                               |
| Product idea / bug for Hub                      | `create_hub_request`                                                           | upvote/comment only if asked; **avoid** `list_hub_requests` unless user asks to browse/search the board             |
| Thank a peer                                    | resolve email                                                                  | `send_kudos` (message + category)                                                                                   |
| Client / quote lookup                           | `list_clients` / `list_quotations`                                             | get + items + linked projects                                                                                       |
| KPIs / red flags                                | `get_analytics_dashboard_catalog`                                              | specific `get_*_analytics` (include `get_employee_project_timeline` for assignment history)                         |

## Domain semantics LLMs must know

### Organization & people

- **Employees:** `list_employees`, `get_employee_profile`.
- **Organization:** `search_organization` (people + accessible projects).
- **Reporting:** `get_org_chart`, `list_reportees` — manager hierarchy.
- **Squad team:** `get_employee_team` — peers / squad-led members; pass
  `include_profiles` for display names.

### Timesheets (`docs/PROJECT_CONTEXT` → Timesheet)

- Drafts may be auto-created from calendar/Jira/Gerrit; streaks can gate Hub.
- Status: `DRAFT` → `SUBMITTED` → `APPROVED` \| `REJECTED`.
- Category: `PROJECT` (needs `timesheet_project_id`) \| `MANAGEMENT` \| `BENCH`
  (hours logging, not staffing bench roster).
- `bulk_save_timesheets` = atomic multi-row for **current user only**.
- Work-item configs = admin labels for logging taxonomy.
- AI helpers draft description/summary; they do not submit.
- **Logged-hours quantity vs calendar:** Hub date filters are day-granular
  (`YYYY-MM-DD`). Phrases like “last N hours **logged**” mean the most recent
  timesheet rows whose `hours` sum to ~N — fetch recent rows and accumulate.
  Phrases like “hours logged **in the last N days / this week**” mean a
  calendar start/end window. Never map “10 hours” to “10 days”.

### Leave & WFH

- Leave types: `SICK`, `PRIVILEGE`, `MATERNITY`, `PATERNITY`, `UNPAID`,
  `FESTIVAL`, `FLOATING_VACATION`.
- Length: `FULL_DAY` \| `FIRST_HALF` \| `SECOND_HALF`.
- Serving notice: unused sick + floating vacation expire; privilege stays with
  approval.
- Apply tools run Nest validation (balances, conflicts, routing).
- Employees may **update** / **delete** own pending/submitted leave or WFH via MCP.
- Use `check_leave_wfh_conflicts`, `check_wfh_conflicts`, or
  `check_wfh_leave_conflicts` before apply when dates are known.
- WFH apply requires `policy_reason`; free-text `reason` (≥ 10 chars) only when
  `policy_reason` is `OTHER`.
- Review actions: `APPROVED` \| `REJECTED`.
- Calendar combines **approved** leave+WFH (`month` **0–11**); pending inboxes are
  manager-scoped (combined or leave-only / WFH-only).

### Projects, meetings, calendar

- Ownership roles in Hub (PM, strategist, lead, …) appear on project metadata
  when permitted.
- Allocations track full/partial/burst staffing on a project.
- Release notes: `DRAFT` \| `PUBLISHED` (Jira import / AI summaries in Hub).
- `send_bench_suggestions`: org-wide AI bench search; optional `conversation_id`
  for multi-turn.
- `get_hiring_position_bench_suggestions`: bench fit for an open **position** id.
- Meeting notes: always use list row **`id`** from `fetch_project_meeting_notes`
  — never `zoom_meeting_id`.
- Workspace calendar tools impersonate another user’s primary calendar via
  `subject` email; require **`manage-projects`**.

### Hub Requests (product feedback)

- Not IT inventory tickets — internal enhancement/issue board.
- Type `enhancement` \| `issue`; status `open` → `in_progress` → `done`;
  priority `low`\|`moderate`\|`high`\|`critical`.
- Create needs **business_reason**; `finalize` when ready for notifications.
- Comments: requester, assignee, or moderator only.
- **Discourage `list_hub_requests`:** do not call it for greetings, catch-me-up,
  briefs, Matter-style triage, leave/timesheet inboxes, or general Hub status.
  Use it only when the user explicitly asks to list, search, or browse Hub
  product-feedback requests (enhancement/issue board). Prefer
  `get_hub_request` / `get_hub_request_stats` when they name a specific id or
  ask for counts.

### Announcements

- Org culture surface on dashboard; country `ALL`/`IN`/`US`.
- Mutates need `manage-announcements`; no attachments via MCP.

### Analytics (read-only)

- Employee overview KPIs are **India-scoped**.
- MBO analytics need `type` + fiscal `year`; discover years first.
- Timesheet analytics require date range ≤ **366** days.
- Bucket utilisation bands: `low` \| `medium` \| `high` \| `over` (capacity vs
  hours — not org-wide bench FTE; use allocation analytics for bench strength).
- `get_employee_project_timeline`: assignment history; requires employee email,
  squad id, or project id.
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

**Resolve person:** search/list → use **email** everywhere downstream (kudos,
allocations, WFH/leave filters, calendar `subject`).

**Reportees + team for X:** `list_reportees` or `get_org_chart` **and**
`get_employee_team` with `include_profiles` — two sections.

**Timesheet week:** drafts → bulk save → optional AI → submit → (manager)
pending → bulk approve.

**Leave / WFH day:** summary/calendar → conflict check → apply → (manager)
pending → review; withdraw via delete when allowed.

**Staffing question:** allocation analytics and/or `send_bench_suggestions` →
employee profiles for shortlisted emails; project roster → `list_project_allocations`.

**Meeting context:** `list_projects` → notes list → single note or transcript.

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
  Center, documents, confirmations, shop, Meeting Tracker scheduling UI, etc.).

## Extending Hub MCP (repo)

1. Ship Nest API + RBAC (`route-config.service.ts`); run `npm run generate:route-access`.
2. Add `hub-mcp/src/modules/<name>/` with descriptions from
   `docs/PROJECT_CONTEXT.md` and aliases in `hub-mcp/knowledge/intent-map.md`.
3. Register in `hub-mcp/src/index.ts` (order matters for clients with ~40-tool caps).
4. Update `EXPECTED_TOOL_COUNT` in `hub-mcp/src/core/tool-catalog.test.ts`.
5. Update [tools.md](tools.md), [platform.md](platform.md), this skill, and
   `hub-mcp/README.md`.
