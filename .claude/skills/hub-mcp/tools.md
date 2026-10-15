# Hub MCP tool map (detailed)

Companion to [SKILL.md](SKILL.md) and [platform.md](platform.md).
Cursor server: `york-hub` / `user-york-hub`.

**118 tools** registered in `hub-mcp` (see `src/core/tool-catalog.test.ts`).
`tools/list` is **permission-filtered** per connected employee — reconnect MCP
after Hub permission changes.

**Always** inspect the live tool input schema from your MCP client before
invoking a tool. Descriptions below match Hub MCP module copy (grounded in
`docs/PROJECT_CONTEXT.md` and `hub-mcp/knowledge/`) plus LLM selection hints.

Legend: **R** = read, **W** = mutate/write.

**Registration order:** Meetings and Google Calendar register first in
`src/index.ts` so clients that cap visible tools (~40, often alphabetical)
still surface `fetch_project_meeting_*`.

---

## Auth

| Tool       | R/W | When to use                              | Notes                                  |
| ---------- | --- | ---------------------------------------- | -------------------------------------- |
| `mcp_auth` | W   | Auth/permission errors from any Hub tool | Empty args; reconnect, then retry once |

---

## Project meetings — Zoom AI notes (read-only)

**Domain:** AI meeting summaries, action items, red flags, and kudos tied to
Hub projects. Requires project access. Use list row **`id`** — never
`zoom_meeting_id`.

| Tool                                  | R/W | Description                                                                    |
| ------------------------------------- | --- | ------------------------------------------------------------------------------ |
| `fetch_project_meeting_notes`         | R   | Paginated meeting notes for a project; resolve `projectId` via `list_projects` |
| `fetch_project_meeting_note`          | R   | One note (bullets, action items, red flags, kudos)                             |
| `fetch_project_meeting_transcript`    | R   | Full transcript text when artifacts exist                                      |
| `fetch_project_meeting_artifact_urls` | R   | Presigned recording / transcript file URLs                                     |

---

## Google Workspace calendar (delivery ops)

**Domain:** Service-account access to another user’s primary calendar. Requires
**`manage-projects`**. Pass organizer/worker email as `subject`.

| Tool                              | R/W | Description                                                                           |
| --------------------------------- | --- | ------------------------------------------------------------------------------------- |
| `list_workspace_calendar_events`  | R   | Events in a window; optional `q` (often Zoom meeting id digits)                       |
| `delete_workspace_calendar_event` | W   | Delete by `eventId` from list (`recurringEventId` for series); `sendUpdates` optional |

---

## Analytics — leadership KPIs (all read-only)

**Domain:** Operational dashboards for managers/leadership. Requires analytics
permissions. Prefer catalog/years discovery before a specific report.
Do **not** fabricate numbers. Optional `forceFetch` refreshes cached snapshots
where the schema allows.

| Tool                                          | When to use                               | Key inputs / semantics                                                                                                            |
| --------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `get_analytics_dashboard_catalog`             | “What analytics can I see / pin?”         | Permission-filtered chart catalog                                                                                                 |
| `get_available_analytics_years`               | Before MBO analytics                      | Required `type` ∈ MBO report types                                                                                                |
| `get_employee_project_allocation_analytics`   | Utilization, **bench strength**, staffing | Org-wide allocation + bench FTE — not timesheet `BENCH` category                                                                  |
| `get_employee_overview_analytics`             | Headcount / churn / tenure / mood / leave | **India-only** (`country = IN`)                                                                                                   |
| `get_code_quality_analytics`                  | Engineering quality oversight             | Aggregate + per-employee                                                                                                          |
| `get_project_red_flag_analytics`              | Which projects need attention             | Delivery risk / red flags                                                                                                         |
| `get_mbo_analytics`                           | MBO cycle health                          | `type` + fiscal `year` (≥ 2021). Types: `MBO_OVERVIEW`, `MBO_PERFORMANCE`, `MBO_GOAL_COMPLETION`, `MBO_WEIGHTAGE`, `MBO_CATEGORY` |
| `get_candidate_added_analytics`               | Hiring intake funnel                      | Candidate-addition KPIs                                                                                                           |
| `get_interview_overview_analytics`            | Interview funnel                          | Optional `jobPositionId` → real-time position report                                                                              |
| `get_employee_onboarding_checklist_analytics` | Onboarding completion                     | Optional name/email `search`                                                                                                      |
| `get_timesheet_analytics`                     | Timesheet compliance                      | Required `startDate`/`endDate`; max **366** days; fill/approval rates, streaks, auto-rows                                         |
| `get_employee_project_timeline`               | Assignment history                        | Requires ≥1 of `employeeEmail`, `squadId`, `projectId`; includes missing exit dates                                               |
| `get_bucket_utilisation_analytics`            | Bucket capacity vs hours                  | `search`, `squad_id`, `product_manager_email`, `utilisation_status` ∈ `low`\|`medium`\|`high`\|`over`, `sort_by` / `sort_order`   |

**Out of MCP:** salary burn uploads/downloads, monthly OT report email/CSV.

---

## Announcements — org culture / dashboard news

**Domain:** Organization announcements (dashboard reach). Mutates need
`manage-announcements`. No file uploads via MCP. Country audience:
`ALL` \| `IN` \| `US`. Expiry = unix **seconds**.

| Tool                  | R/W | Description                                                                                                     |
| --------------------- | --- | --------------------------------------------------------------------------------------------------------------- |
| `list_announcements`  | R   | List announcements visible to user; filters: author email, type, country, min expiry, pagination                |
| `get_announcement`    | R   | Single announcement by UUID                                                                                     |
| `create_announcement` | W   | Create org announcement; title, description, expiry required; optional email send / india_only / time_sensitive |
| `update_announcement` | W   | Patch title/description/expiry/type                                                                             |
| `delete_announcement` | W   | Delete by id                                                                                                    |

---

## Employees — directory & profile

**Domain:** Active employee directory and profile. Resolve **email** before
leave, MBO, inventory, timesheet filters, kudos, allocations.

| Tool                   | R/W | Description                                             |
| ---------------------- | --- | ------------------------------------------------------- |
| `list_employees`       | R   | Search active directory; pagination + optional `search` |
| `get_employee_profile` | R   | Profile by **email** under caller RBAC                  |

---

## Organization — search, squad team, reporting graph

**Domain:** Org discovery. **Squad team** (`get_employee_team`) ≠ **reporting
graph** (`get_org_chart`, `list_reportees`). For “reportees and team for X”, call
both and present separate sections.

| Tool                  | R/W | Description                                                                                           |
| --------------------- | --- | ----------------------------------------------------------------------------------------------------- |
| `search_organization` | R   | Text search across users and accessible projects (`q`, optional `limit`)                              |
| `get_employee_team`   | R   | Squad peers / squad-led members; optional `email`, `include_profiles` for names                       |
| `get_org_chart`       | R   | Ancestors, person, nested descendants; optional `max_depth`                                           |
| `list_reportees`      | R   | Flat direct+indirect reportees for a manager email; on 403 for others use `get_org_chart.descendants` |

---

## Projects — client delivery & staffing

**Domain:** Project Management — delivery core (allocations, release notes,
Jira quality, AI bench). MCP does not create/edit projects or passwords.

| Tool                              | R/W | Description                                                            | Prefer when                                                      |
| --------------------------------- | --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `list_projects`                   | R   | Accessible projects as **id + title** pairs                            | Pickers, meeting notes, name→id                                  |
| `list_project_summaries`          | R   | Active/inactive summaries: status, client, squad, allocation oversight | Delivery overview; optional `active`                             |
| `get_project`                     | R   | One project + accessible delivery metadata                             | After you have UUID                                              |
| `list_project_allocations`        | R   | Full/partial/burst staffing on a project                               | “Who is on project X?”                                           |
| `get_project_allocation_timeline` | R   | Employee’s active/upcoming allocations                                 | Project `id` + employee `email`; employee-scoped                 |
| `send_bench_suggestions`          | W   | Org-wide AI bench search (NL `message`; optional `conversation_id`)    | Natural-language staffing; ranked availability + match reasoning |
| `list_project_release_notes`      | R   | Release notes (Jira import / published changes)                        | Filter `status` `DRAFT`\|`PUBLISHED`                             |
| `get_project_jira_quality`        | R   | Jira description-quality metrics for a project                         | Delivery health                                                  |

**Related (not under Projects module):** `get_employee_project_allocation_analytics`
(bench KPIs), `get_hiring_position_bench_suggestions` (role fit), meeting note
`fetch_project_meeting_*` tools.

---

## Timesheets — log, submit, approve hours

**Domain:** Daily work logs; draft pipeline; manager approval; streak gating.
Statuses: `DRAFT` → `SUBMITTED` → `APPROVED` \| `REJECTED`.
Categories: `PROJECT` \| `MANAGEMENT` \| `BENCH` (hours logging ≠ staffing bench).
`employee_id` = email.

| Tool                                    | R/W | Description                                                               |
| --------------------------------------- | --- | ------------------------------------------------------------------------- |
| `list_timesheets`                       | R   | Filtered list (employee, project, status, dates, squad, exclude_draft, …) |
| `get_timesheet`                         | R   | One entry for detailed work-log review                                    |
| `list_my_timesheet_drafts`              | R   | Current user’s drafts (pre-submit)                                        |
| `get_my_timesheet_draft_count`          | R   | Draft count (dashboard / Start Your Day style)                            |
| `list_timesheets_by_squad`              | R   | Squad-scoped list (`squadid`)                                             |
| `list_pending_timesheet_reviews`        | R   | Manager approval inbox                                                    |
| `get_team_weekly_timesheets`            | R   | Team week view (`week_start`, optional emails)                            |
| `get_team_daily_timesheets`             | R   | Team day view (`date`, optional emails)                                   |
| `create_timesheet`                      | W   | Create one personal entry                                                 |
| `update_timesheet`                      | W   | Update one entry by id                                                    |
| `delete_timesheet`                      | W   | Delete one entry                                                          |
| `bulk_save_timesheets`                  | W   | Atomic multi create/update for **current user** week/day sessions         |
| `submit_timesheet_draft`                | W   | Submit draft with final hours/project/description                         |
| `bulk_approve_timesheets_by_filters`    | W   | Manager bulk approve; requires `approved_by` email + optional filters     |
| `generate_timesheet_description`        | W   | AI description assist for a date                                          |
| `generate_timesheet_summary`            | W   | AI summary assist                                                         |
| `list_timesheet_work_item_configs`      | R   | Configurable work-item labels                                             |
| `create_timesheet_work_item_config`     | W   | Admin create label                                                        |
| `update_timesheet_work_item_config`     | W   | Admin update label                                                        |
| `deactivate_timesheet_work_item_config` | W   | Admin deactivate label                                                    |

**Chain (employee):** drafts → `bulk_save_timesheets` → optional AI →
`submit_timesheet_draft`.

**Chain (manager):** `list_pending_timesheet_reviews` →
`bulk_approve_timesheets_by_filters` (or team week/day for context).

**Logged hours phrasing:** “Last N hours **logged**” → accumulate recent row
`hours`; “hours in the last N **days**” → calendar `YYYY-MM-DD` range on
`list_timesheets`.

---

## Leave — time off

**Domain:** Balances, apply, update/delete own requests, manager/HR review,
notice-period rules. Combined calendar/inbox shared with WFH.

| Tool                              | R/W | Description                                                                                                                                                                                  |
| --------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_my_leave_requests`          | R   | Current user’s leaves (status/year/type; optional `adjustment_type` CREDIT/DEBIT/LAPSE on rows)                                                                                              |
| `list_employee_leave_requests`    | R   | Another employee’s leaves (manager/HR); pagination + filters                                                                                                                                 |
| `get_leave_wfh_calendar`          | R   | Combined **approved** leave+WFH; `filter` `all`\|`squad`\|`team`; `month` **0–11**                                                                                                           |
| `list_pending_leave_wfh_requests` | R   | Combined leave+WFH awaiting **current manager**                                                                                                                                              |
| `list_pending_leave_requests`     | R   | Leave-only manager inbox (WFH excluded)                                                                                                                                                      |
| `check_leave_wfh_conflicts`       | R   | Overlaps for current user before apply; approved = blocking, submitted = warning                                                                                                             |
| `apply_for_leave`                 | W   | Types: SICK, PRIVILEGE, MATERNITY, PATERNITY, UNPAID, FESTIVAL, FLOATING_VACATION. Length: FULL_DAY / FIRST_HALF / SECOND_HALF. Optional `compoff`; festival-admin may pass `employee_email` |
| `update_leave_request`            | W   | Patch own pending/submitted request; Hub re-validates                                                                                                                                        |
| `delete_leave_request`            | W   | Withdraw/delete allowed requests                                                                                                                                                             |
| `review_leave_request`            | W   | `action` `APPROVED`\|`REJECTED` + optional comment                                                                                                                                           |

**Not MCP:** HR balance-adjustment **mutations** (listing adjustment types on
history rows is fine).

---

## Work from home — remote days

**Domain:** Parallel to leave; policy/balance/pilot; analytics. WFH analytics
`month` is **1–12** (unlike leave/WFH calendar **0–11**).

| Tool                            | R/W | Description                                                                            |
| ------------------------------- | --- | -------------------------------------------------------------------------------------- |
| `list_my_wfh_requests`          | R   | Current user’s WFH requests/statuses                                                   |
| `list_employee_wfh_requests`    | R   | Another employee’s WFH (manager/HR); pagination + filters                              |
| `get_wfh_request`               | R   | One WFH by id                                                                          |
| `get_wfh_summary`               | R   | Balance/utilization summary (optional `employee_email`)                                |
| `get_wfh_analytics`             | R   | Charts; optional `year`, `month` (1–12), `period`, `includeTablePages`                 |
| `get_wfh_analytics_tables`      | R   | Paginated tables: `perEmployee`, `perProject`, `perSquad`, `perTeam`, `balanceLowest`  |
| `check_wfh_conflicts`           | R   | Overlapping WFH for current user before apply                                          |
| `check_wfh_leave_conflicts`     | R   | Overlapping WFH + leave for current user before apply                                  |
| `list_pending_wfh_requests`     | R   | WFH-only approval inbox                                                                |
| `apply_for_work_from_home`      | W   | `policy_reason` enum + dates; `reason` ≥ 10 chars only when `policy_reason` is `OTHER` |
| `update_work_from_home_request` | W   | Patch own pending/submitted WFH                                                        |
| `delete_work_from_home_request` | W   | Withdraw/delete allowed WFH                                                            |
| `review_work_from_home_request` | W   | `APPROVED`\|`REJECTED` + optional comment                                              |
| `toggle_hybrid_wfh_pilot`       | W   | Enable/disable hybrid pilot for a reportee (`employeeEmail`, `enabled`)                |

---

## Hiring — recruitment pipeline

**Domain:** Positions → candidates → interviews; AI bench for a role.
No offers/portal/files via MCP.

| Tool                                    | R/W | Description                                      |
| --------------------------------------- | --- | ------------------------------------------------ |
| `list_hiring_positions`                 | R   | Job positions; optional `open`, `location` IN/US |
| `get_hiring_position`                   | R   | Position detail; optional `includeMetadata`      |
| `list_hiring_candidates`                | R   | Candidates (CRM-style pipeline)                  |
| `get_hiring_candidate`                  | R   | Candidate detail                                 |
| `list_hiring_interviews`                | R   | Interviews; optional `interviewer_id` (email)    |
| `get_hiring_interview`                  | R   | Interview detail / scorecard-accessible fields   |
| `get_hiring_position_bench_suggestions` | R   | AI bench fit for an open **position** id         |

Related analytics: `get_candidate_added_analytics`,
`get_interview_overview_analytics`.

---

## MBO — goals & cycles

**Domain:** Performance goal cycles; manager team boards. Mostly read via MCP.

| Tool                     | R/W | Description                               |
| ------------------------ | --- | ----------------------------------------- |
| `list_mbos`              | R   | MBO records visible to caller             |
| `get_mbo`                | R   | One MBO by id                             |
| `list_mbo_goals`         | R   | Goals / templates                         |
| `get_team_mbo_statuses`  | R   | Team status board; requires fiscal `year` |
| `get_employee_team_mbos` | R   | Team members’ MBO records                 |

Related analytics: `get_mbo_analytics` + `get_available_analytics_years`.

---

## Inventory — hardware & software

**Domain:** IT asset accountability. Read-only via MCP (no assign/retire).

| Tool                                | R/W | Description                                                                                            |
| ----------------------------------- | --- | ------------------------------------------------------------------------------------------------------ |
| `list_inventory_items`              | R   | Hardware units; filters: status, assigned_to email, category, product_family, vendor, pool_depleted, … |
| `get_inventory_item`                | R   | One asset + assignment/lifecycle                                                                       |
| `get_inventory_item_history`        | R   | Assignment/lifecycle audit history                                                                     |
| `get_inventory_stock_summary`       | R   | Org-wide assigned/unassigned/family counts                                                             |
| `list_software_subscriptions`       | R   | SaaS subs; status ALL/ACTIVE/TRIAL/PAUSED/EXPIRED/CANCELLED                                            |
| `get_software_subscription`         | R   | One subscription                                                                                       |
| `get_software_subscription_metrics` | R   | Seat/lifecycle metrics overview                                                                        |

Assignment categories in Hub (for interpreting history): Intern, Contractor,
Company Use, Accessories/Extra Hardware, Employee.

---

## Hub Requests — product feedback board

**Domain:** Internal feature/enhancement/issue requests (not hardware tickets).
Statuses open → in_progress → done. Comments restricted to requester /
assignee / moderator.

| Tool                        | R/W | Description                                                                                                                                                                                                                                                     |
| --------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_hub_requests`         | R   | Board list; filters: type enhancement\|issue, status, priority, module, assignee, mine, search. **Discourage** — call only when the user explicitly asks to list/search/browse Hub product-feedback requests; never for greetings, briefs, or approval inboxes. |
| `get_hub_request_stats`     | R   | KPI counts (open / in progress / completed)                                                                                                                                                                                                                     |
| `get_hub_request`           | R   | Detail: status, votes, timeline                                                                                                                                                                                                                                 |
| `list_hub_request_comments` | R   | Discussion thread                                                                                                                                                                                                                                               |
| `create_hub_request`        | W   | Submit with type, module, title, description, **business_reason**, priority; optional `finalize`                                                                                                                                                                |
| `add_hub_request_comment`   | W   | Private comment (authorized parties)                                                                                                                                                                                                                            |
| `toggle_hub_request_upvote` | W   | Toggle upvote on a request                                                                                                                                                                                                                                      |

No attachments via MCP.

---

## Kudos — peer recognition

**Domain:** Values-aligned peer thanks; may grant shop coins per Hub config.

| Tool                  | R/W | Description                                                                     |
| --------------------- | --- | ------------------------------------------------------------------------------- |
| `list_kudos`          | R   | Feed; filters sender/recipient/review status/search                             |
| `get_kudos`           | R   | One entry by id                                                                 |
| `list_employee_kudos` | R   | `type` `given`\|`received` + `user_email`                                       |
| `send_kudos`          | W   | `recipient_email`, `message`, `category`; Hub applies review/notification rules |

---

## Clients — accounts

**Domain:** Client accounts for delivery/sales prep. Needs `view-clients` (or
stronger). Personas/AI insights are Hub UI only.

| Tool           | R/W | Description                        |
| -------------- | --- | ---------------------------------- |
| `list_clients` | R   | Client accounts                    |
| `get_client`   | R   | Client detail + accessible linkage |

---

## Quotations — sales proposals

**Domain:** Quotes/SOWs/margins (v1/v2). MCP is inspection, not authoring.

| Tool                            | R/W | Description                             |
| ------------------------------- | --- | --------------------------------------- |
| `list_quotations`               | R   | Quotations list                         |
| `get_quotation`                 | R   | Quotation detail                        |
| `list_quotation_items`          | R   | Line items / positions                  |
| `get_quotation_linked_projects` | R   | Delivery projects linked to a quotation |

---

## Selection cheat sheet

| User says…                      | First tools                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------ |
| “Who is … / find …”             | `list_employees` or `search_organization`                                      |
| “Org chart / reportees”         | `get_org_chart` and/or `list_reportees` + `get_employee_team` if “team” too    |
| “What’s on the dashboard news?” | `list_announcements`                                                           |
| “Project meeting notes”         | `list_projects` → `fetch_project_meeting_notes` → note/transcript/artifacts    |
| “Staffing on project …”         | `list_project_summaries` → `list_project_allocations`                          |
| “Bench strength / utilization”  | `get_employee_project_allocation_analytics`                                    |
| “Find bench people”             | `send_bench_suggestions` or `get_hiring_position_bench_suggestions`            |
| “Assignment history”            | `get_employee_project_timeline` or `get_project_allocation_timeline`           |
| “Fill my timesheet”             | `list_my_timesheet_drafts` → `bulk_save_timesheets` → `submit_timesheet_draft` |
| “Approve timesheets”            | `list_pending_timesheet_reviews` → `bulk_approve_timesheets_by_filters`        |
| “Book leave / WFH”              | conflict checks → calendar/summary → `apply_for_*`; edit via update/delete     |
| “Pending approvals”             | `list_pending_leave_wfh_requests` and/or domain-specific pending + timesheets  |
| “Hiring pipeline”               | `list_hiring_positions` → candidates/interviews                                |
| “Team MBO status”               | `get_team_mbo_statuses` (+ year)                                               |
| “Laptop / license for …”        | `list_inventory_items` / `list_software_subscriptions`                         |
| “File a Hub idea”               | `create_hub_request`                                                           |
| “List / search Hub requests”    | `list_hub_requests` (only when explicitly asked — otherwise avoid)             |
| “Send kudos”                    | resolve email → `send_kudos`                                                   |
| “Show utilization / red flags”  | analytics catalog → specific `get_*_analytics`                                 |
| “Workspace calendar event”      | `list_workspace_calendar_events` (`subject`, `q`) — needs `manage-projects`    |

---

## Intentionally not in MCP

Risk Register, Policy Center, Orientation, Shop checkout, Awards admin, Vault,
Meeting Tracker **scheduling UI**, Daily Scrum, Employee Documents,
Confirmations/farewell PDFs, salary burn & OT report generation, generic arbitrary
file upload/download (except meeting presigned URLs), HR leave balance
adjustment **mutations**, Group Management / M2M admin, People's Corner,
FitWalk, etc.

Add new modules via Nest + RBAC + `hub-mcp/src/modules/`, register in
`src/index.ts`, bump `EXPECTED_TOOL_COUNT` in `tool-catalog.test.ts`, and update
`hub-mcp/knowledge/`, [SKILL.md](SKILL.md), [platform.md](platform.md), and
`hub-mcp/README.md`.
