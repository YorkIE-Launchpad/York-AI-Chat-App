# Hub MCP tool map (detailed)

Companion to [SKILL.md](SKILL.md) and [platform.md](platform.md).
Cursor server: `york-hub` / `user-york-hub`.

**Always** call `GetMcpTools` for the live input schema before invoking a tool.
Descriptions below match Hub MCP module copy (grounded in
`docs/PROJECT_CONTEXT.md`) plus LLM selection hints.

Legend: **R** = read, **W** = mutate/write.

---

## Auth

| Tool       | R/W | When to use                              | Notes                                  |
| ---------- | --- | ---------------------------------------- | -------------------------------------- |
| `mcp_auth` | W   | Auth/permission errors from any Hub tool | Empty args; reconnect, then retry once |

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
| `get_employee_project_allocation_analytics`   | Utilization, bench, staffing decisions    | Employee↔project allocation + bench                                                                                               |
| `get_employee_overview_analytics`             | Headcount / churn / tenure / mood / leave | **India-only** (`country = IN`)                                                                                                   |
| `get_code_quality_analytics`                  | Engineering quality oversight             | Aggregate + per-employee                                                                                                          |
| `get_project_red_flag_analytics`              | Which projects need attention             | Delivery risk / red flags                                                                                                         |
| `get_mbo_analytics`                           | MBO cycle health                          | `type` + fiscal `year` (≥ 2021). Types: `MBO_OVERVIEW`, `MBO_PERFORMANCE`, `MBO_GOAL_COMPLETION`, `MBO_WEIGHTAGE`, `MBO_CATEGORY` |
| `get_candidate_added_analytics`               | Hiring intake funnel                      | Candidate-addition KPIs                                                                                                           |
| `get_interview_overview_analytics`            | Interview funnel                          | Optional `jobPositionId` → real-time position report                                                                              |
| `get_employee_onboarding_checklist_analytics` | Onboarding completion                     | Optional name/email `search`                                                                                                      |
| `get_timesheet_analytics`                     | Timesheet compliance                      | Required `startDate`/`endDate`; max **366** days; fill/approval rates, streaks, auto-rows                                         |
| `get_bucket_utilisation_analytics`            | Bucket capacity vs hours                  | Filters: `search`, `squad_id`, `product_manager_email`, `utilisation_status` ∈ `low`\|`medium`\|`high`\|`over`, sort              |

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

## Employees / organization — people resolution

**Domain:** Directory, profiles, org search, reporting/squad teams.
**Always resolve email here before leave/MBO/inventory/timesheet filters.**

| Tool                   | R/W | Description                                                                                                       |
| ---------------------- | --- | ----------------------------------------------------------------------------------------------------------------- |
| `list_employees`       | R   | Search Hub employee directory for active people; resolve identities before teams/assignments/leave/MBOs/inventory |
| `get_employee_profile` | R   | Profile by **email** under caller RBAC                                                                            |
| `search_organization`  | R   | Broader org search (people/projects text `q`)                                                                     |
| `get_employee_team`    | R   | Reporting / squad team for an employee                                                                            |

---

## Projects — client delivery & staffing

**Domain:** Project Management — delivery core (allocations, release notes,
Jira quality, AI bench). MCP does not create/edit projects or passwords.

| Tool                                  | R/W | Description                                                            | Prefer when                                                            |
| ------------------------------------- | --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `list_projects`                       | R   | Accessible projects as **id + title** pairs                            | Fast picker / name→id                                                  |
| `list_project_summaries`              | R   | Active/inactive summaries: status, client, squad, allocation oversight | Delivery overview; optional `active`                                   |
| `get_project`                         | R   | One project + accessible delivery metadata                             | After you have UUID                                                    |
| `list_project_allocations`            | R   | Full/partial/burst staffing on a project                               | “Who is on project X?”                                                 |
| `get_project_allocation_timeline`     | R   | Employee’s active/upcoming allocations across projects                 | Needs project `id` **and** employee `email`; report is employee-scoped |
| `get_project_bench_suggestions`       | R   | AI bench suggestions for a project                                     | Staffing gaps on a known project                                       |
| `send_project_bench_suggestions_chat` | W   | Org-wide AI bench search / multi-turn                                  | Natural-language staffing; optional `conversation_id`                  |
| `list_project_release_notes`          | R   | Release notes (Jira import / published changes)                        | Filter `status` `DRAFT`\|`PUBLISHED`                                   |
| `get_project_jira_quality`            | R   | Jira quality metrics for a project                                     | Delivery health                                                        |

---

## Timesheets — log, submit, approve hours

**Domain:** Daily work logs; draft pipeline; manager approval; streak gating.
Statuses: `DRAFT` → `SUBMITTED` → `APPROVED` \| `REJECTED`.
Categories: `PROJECT` \| `MANAGEMENT` \| `BENCH`. `employee_id` = email.

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

---

## Leave — time off

**Domain:** Balances, apply, manager/HR review, notice-period rules.
Combined calendar/inbox shared with WFH.

| Tool                              | R/W | Description                                                                                                                                                                                             |
| --------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_my_leave_requests`          | R   | Current user’s leaves (status/year/type filters)                                                                                                                                                        |
| `list_employee_leave_requests`    | R   | Another employee’s leaves (manager/HR)                                                                                                                                                                  |
| `get_leave_wfh_calendar`          | R   | Combined approved leave+WFH; `filter` `all`\|`squad`\|`team`; `month` **0–11**                                                                                                                          |
| `list_pending_leave_wfh_requests` | R   | Combined leave+WFH awaiting **current manager**                                                                                                                                                         |
| `apply_for_leave`                 | W   | Apply; Hub validates balances, dates, notice policy, conflicts, routing. Types: SICK, PRIVILEGE, MATERNITY, PATERNITY, UNPAID, FESTIVAL, FLOATING_VACATION. Length: FULL_DAY / FIRST_HALF / SECOND_HALF |
| `review_leave_request`            | W   | `action` `APPROVED`\|`REJECTED` + optional comment                                                                                                                                                      |

---

## Work from home — remote days

**Domain:** Parallel to leave; policy/balance/pilot checks; analytics.

| Tool                            | R/W | Description                                                                        |
| ------------------------------- | --- | ---------------------------------------------------------------------------------- |
| `list_my_wfh_requests`          | R   | Current user’s WFH requests/statuses                                               |
| `get_wfh_request`               | R   | One WFH by id                                                                      |
| `get_wfh_summary`               | R   | Balance/utilization summary (optional employee email)                              |
| `get_wfh_analytics`             | R   | Manager utilization / compliance analytics (optional year)                         |
| `list_pending_wfh_requests`     | R   | WFH-only approval inbox                                                            |
| `apply_for_work_from_home`      | W   | Apply; `reason` min 10 chars; Hub validates ranges/conflicts/balance/pilot/routing |
| `review_work_from_home_request` | W   | `APPROVED`\|`REJECTED` + optional comment                                          |

---

## Hiring — recruitment pipeline

**Domain:** Positions → candidates → interviews; AI bench for a role.
No offers/portal/files via MCP.

| Tool                                    | R/W | Description                                     |
| --------------------------------------- | --- | ----------------------------------------------- |
| `list_hiring_positions`                 | R   | Job positions                                   |
| `get_hiring_position`                   | R   | Position detail                                 |
| `list_hiring_candidates`                | R   | Candidates (CRM-style pipeline)                 |
| `get_hiring_candidate`                  | R   | Candidate detail                                |
| `list_hiring_interviews`                | R   | Interviews; optional interviewer email filter   |
| `get_hiring_interview`                  | R   | Interview detail / scorecard-accessible fields  |
| `get_hiring_position_bench_suggestions` | R   | AI bench suggestions for filling a **position** |

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

| Tool                        | R/W | Description                                                                                      |
| --------------------------- | --- | ------------------------------------------------------------------------------------------------ |
| `list_hub_requests`         | R   | Board list; filters: type enhancement\|issue, status, priority, module, assignee, mine, search   |
| `get_hub_request_stats`     | R   | KPI counts (open / in progress / completed)                                                      |
| `get_hub_request`           | R   | Detail: status, votes, timeline                                                                  |
| `list_hub_request_comments` | R   | Discussion thread                                                                                |
| `create_hub_request`        | W   | Submit with type, module, title, description, **business_reason**, priority; optional `finalize` |
| `add_hub_request_comment`   | W   | Private comment (authorized parties)                                                             |
| `toggle_hub_request_upvote` | W   | Toggle upvote on a request                                                                       |

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
| “What’s on the dashboard news?” | `list_announcements`                                                           |
| “Staffing on project …”         | `list_project_summaries` → `list_project_allocations`                          |
| “Who’s available / bench …”     | `send_project_bench_suggestions_chat` or project/position bench tools          |
| “Fill my timesheet”             | `list_my_timesheet_drafts` → `bulk_save_timesheets` → `submit_timesheet_draft` |
| “Approve timesheets”            | `list_pending_timesheet_reviews` → `bulk_approve_timesheets_by_filters`        |
| “Book leave / WFH”              | calendar/summary → `apply_for_*`                                               |
| “Pending approvals”             | `list_pending_leave_wfh_requests` and/or timesheet pending                     |
| “Hiring pipeline”               | `list_hiring_positions` → candidates/interviews                                |
| “Team MBO status”               | `get_team_mbo_statuses` (+ year)                                               |
| “Laptop / license for …”        | `list_inventory_items` / `list_software_subscriptions`                         |
| “File a Hub idea”               | `create_hub_request`                                                           |
| “Send kudos”                    | resolve email → `send_kudos`                                                   |
| “Show utilization / red flags”  | analytics catalog → specific `get_*_analytics`                                 |

---

## Intentionally not in MCP

Risk Register, Policy Center, Orientation, Shop checkout, Awards admin, Vault,
Meeting Tracker, Daily Scrum, Employee Documents, Confirmations/farewell PDFs,
salary burn & OT report generation, file binary upload/download, leave balance
adjustments, Group Management / M2M admin, People's Corner, FitWalk, etc.

Add new modules only via Nest + RBAC + `hub-mcp/src/modules/` with descriptions
grounded in `docs/PROJECT_CONTEXT.md`.
