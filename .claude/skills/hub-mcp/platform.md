# York Hub platform — how it works

Companion to [SKILL.md](SKILL.md). Grounded in `docs/PROJECT_CONTEXT.md`.
Read the matching section before calling tools in that domain.

## What Hub is

**York IE Hub v2** is York IE Labs’ internal **HRMS / employee-operations**
platform for a software consultancy (~100–500 employees). It replaced a legacy
DynamoDB Hub. One permission-gated SaaS covers people, time, delivery, hiring,
culture, and ops.

| Surface          | Package             | Who uses it                                     |
| ---------------- | ------------------- | ----------------------------------------------- |
| Main Hub SPA     | `frontend/`         | Employees, managers, HR, ops, leadership        |
| Nest API         | `backend/`          | SPA, Hub MCP, M2M partners                      |
| Candidate portal | `candidate-portal/` | External candidates (magic-link auth)           |
| Hub MCP          | `hub-mcp/`          | AI clients acting **as the signed-in employee** |

Stack: React 19 + NestJS 10 + TypeORM/Postgres + Cognito JWT + AWS (ECS, SSM,
S3, SES). Global API envelope: `{ success, data, statusCode, message?, timestamp }`.

## Core vocabulary (use these terms)

| Term                | Meaning for tools                                                          |
| ------------------- | -------------------------------------------------------------------------- |
| **Employee email**  | Primary identity key for people, timesheets, leave, kudos, allocations     |
| **Function**        | Product/org unit in the hierarchy                                          |
| **Squad**           | Team under a function; used in timesheet/calendar/analytics filters        |
| **Guild**           | Cross-cutting community (skills/culture), not a delivery team              |
| **Reporting tree**  | Manager hierarchy; drives leave/WFH/timesheet approval routing             |
| **Project**         | Client-delivery unit with status, client, squad, ownership emails          |
| **Allocation**      | Staffing of an employee on a project: full / partial / **burst**           |
| **Bucket**          | Project capacity bucket; compared to worked hours in utilisation analytics |
| **Bench**           | Employees not fully allocated; AI “bench suggestions” find candidates      |
| **Work category**   | Timesheet: `PROJECT` \| `MANAGEMENT` \| `BENCH`                            |
| **Work item**       | Configurable timesheet label (admin-managed configs)                       |
| **RBAC permission** | Capability flags (e.g. `manage-announcements`, `view-clients`)             |

## Auth, identity, RBAC

- Cognito JWT on `/api/*`; Google OAuth supported; inactive users blocked except
  auth/me + logout.
- Frontend hydrates permissions from `/api/auth/permissions` for nav/routes.
- **MCP uses the connected employee’s tokens** → same Nest RBAC as Hub UI.
- Permission failures are normal; explain them; never invent elevated access.
- Profiles, hierarchy, directory, onboarding status live under Auth/User.
- **Not in MCP:** password flows, exit checklists, farewell PDFs, employee
  document matrix, probation confirmation letters.

## Organization & announcements

Org structure: Functions → Squads → Guilds, designations, celebrations,
benefits catalog, announcements.

**Announcements** are the org/culture news surface on the dashboard.

- Create publishes + notifies; drafts are for `manage-announcements` authors
  only (Save as Draft / My Drafts / publish-from-draft in UI).
- Audience can be country-scoped (`ALL` / `IN` / `US`).
- Expiry is a **unix timestamp (seconds)**.
- MCP: full CRUD; **no file attachments** via MCP.
- Success goal in product: dashboard reach / announcement visibility.

## People (employees)

Employee directory + profile + reporting/squad team.

- Resolve people with `list_employees` / `search_organization` **before** any
  tool that needs an email or team context.
- `get_employee_profile` returns what the caller’s RBAC allows.
- `get_employee_team` is reporting/squad context for managers and team tools.
- Hub also has Employee Documents, Confirmations, Transitions — **not MCP**.

## Timesheets

Employees log daily hours against projects, buckets, and work-item categories.
Managers review/approve. Daily cron can pre-create **drafts** from calendar,
Jira, and Gerrit activity. Missing-timesheet streaks can **gate Hub access**.

**Lifecycle:** `DRAFT` → `SUBMITTED` → `APPROVED` \| `REJECTED`

**Work categories:** `PROJECT` (needs `timesheet_project_id`) \| `MANAGEMENT` \|
`BENCH`

**Key behaviors for tools:**

- Personal editing: drafts list, bulk save (atomic multi-row for **current
  user**), single create/update/delete, AI description/summary helpers.
- Submit moves draft → submitted with final hours/project/description.
- Manager: pending inbox, team week/day views, squad lists, bulk approve by
  filters (`approved_by` = approver email).
- Work-item configs are admin labels (`create/update/deactivate`).
- `employee_id` on timesheet rows = **email**.
- Min hours per entry is enforced by Nest (MCP schema mirrors ≥ 0.1).

See also `docs/timesheet.md` for the full FRD.

## Leave

Balances, applications, approvals, settlements across leave types. Manager
approval chains + HR policy.

**Types (MCP enum):** `SICK`, `PRIVILEGE`, `MATERNITY`, `PATERNITY`, `UNPAID`,
`FESTIVAL`, `FLOATING_VACATION`

**Length:** `FULL_DAY` \| `FIRST_HALF` \| `SECOND_HALF`

**Notice-period policy:** when serving notice, unused **sick** and **floating
vacation** expire automatically; **privilege** remains with manager approval.

Hub validates balances, date conflicts, and approval routing on apply.
Reviewers approve/reject (`APPROVED` / `REJECTED`) with optional comment.

Combined surfaces with WFH:

- `get_leave_wfh_calendar` — approved leave+WFH; filters `all` \| `squad` \|
  `team`; month is **0–11**.
- `list_pending_leave_wfh_requests` — manager’s combined inbox.

**Not in MCP:** balance adjustments, festival-leave admin config, absolute
leave reporting exports, cancel flows if not exposed by tools.

## Work from home (WFH)

Parallel to leave: date-range requests, conflicts, balance/pilot policy,
manager review, summary + analytics cards.

- Apply requires `reason` (min 10 chars).
- Same day-length enum as leave.
- Integrates with timesheet draft generation / attendance expectations.
- Use WFH-specific pending list **or** the combined leave+WFH inbox.

## Project management

Operational core for **client delivery**. Used daily by PMs, EMs, delivery
leads.

Includes (in Hub): project CRUD/status, client linkage, squad/function,
ownership emails (Product Manager, Strategist, Lead, Dev Principal, APM,
Engineering Manager), allocations (full/partial/burst), buckets, release notes
(Jira import, AI summaries), Slack/Jira/Gerrit, code-quality views, passwords.

**MCP coverage (read + AI bench):**

- Selectors: `list_projects` (id/title pairs) vs `list_project_summaries`
  (richer status/client/squad/allocation oversight; `active` filter).
- Detail: `get_project`.
- Staffing: `list_project_allocations`; timeline is **employee-scoped** even
  though the route includes a project id (`get_project_allocation_timeline`).
- Bench: AI ranked suggestions + optional multi-turn chat
  (`conversation_id`).
- Delivery comms: release notes (`DRAFT` \| `PUBLISHED`); Jira quality metrics.

**Not in MCP:** project create/update/delete, password vault, burst mutation
workflows, Risk Register (separate module, not exposed).

## Clients & quotations

**Clients:** account CRUD, status, project linkage; personas + AI insights from
Zoom transcripts in Hub UI. RBAC: `view-clients` / `manage-clients`.
MCP: list/get only (no persona sync tools).

**Quotations:** sales/pre-sales quotes, versions, positions, regions, margin
planning (v1 + v2). MCP: list/get quotation, line items, linked delivery
projects — not full authoring/export.

## Hiring

Pipeline: positions → candidates → interviews → assessments → offers →
onboarding handoff; referrals; separate candidate portal.

MCP: list/get positions, candidates, interviews; AI bench suggestions for a
**position**. Optional interviewer email filters on interview list.

**Not in MCP:** offer PDFs, document verification uploads, magic-link portal
auth, public careers pages, referral admin.

Analytics siblings: `get_candidate_added_analytics`,
`get_interview_overview_analytics` (optional `jobPositionId` for real-time
position report).

## MBO (Management by Objectives)

Goal-setting, mid-cycle reviews, weightages, manager–employee discussions for
quarterly/annual cycles.

MCP: list/get MBOs, goals, team status board (`year`), team members’ MBO
records. Mutations (create goals, submit reviews) are largely Hub UI.

Analytics: `get_mbo_analytics` with type
`MBO_OVERVIEW` \| `MBO_PERFORMANCE` \| `MBO_GOAL_COMPLETION` \|
`MBO_WEIGHTAGE` \| `MBO_CATEGORY` + fiscal `year`; years via
`get_available_analytics_years`.

## Kudos, awards, shop

**Kudos:** peer recognition with message + category; feed/history; optional
coin grants into Shop/Awards. MCP: list/get/send; given/received history by
email. Hub may apply review/notification rules on send.

**Awards / Shop:** nomination programs and coin store — **not MCP** (except
indirect kudos side effects).

## Hub Requests

Internal **product-feedback / feature-request** system (not IT ticketing for
laptops).

- Types: `enhancement` \| `issue`
- Status: `open` → `in_progress` → `done`
- Priority: `low` \| `moderate` \| `high` \| `critical`
- Module picker = Hub sidebar module key (includes **Other** in UI)
- Filters: mine / assigned / show closed; upvotes; comments (requester,
  assignee, or moderator)
- Assignees can set status; moderators keep priority/assignee/module/Jira
- `create_hub_request` needs title, description, **business_reason**, priority;
  `finalize` when ready for normal notifications
- **No attachments via MCP**

## Inventory

Hardware + software asset accountability for IT/ops.

**Hardware:** statuses (in stock, assigned, retired, …); assignment categories
(Intern, Contractor, Company Use, Accessories/Extra Hardware, Employee);
history logs; stock summary by family. Assigned lists sequential tags; in-stock
FIFO.

**Software subscriptions:** lifecycle `ACTIVE` \| `TRIAL` \| `PAUSED` \|
`EXPIRED` \| `CANCELLED` (+ `ALL` filter); metrics tool for seat/cost overview.

MCP is **read-oriented** — no assign/reassign/retire mutations.

## Analytics (read-only)

Leadership/manager dashboards. Permission-filtered (`view-analytics` and
related). MCP never invents KPI numbers.

| Report                      | Business use                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| Dashboard catalog           | Discover pinable charts the user can see                                                      |
| Employee project allocation | Utilization + bench staffing decisions                                                        |
| Employee overview           | **India-scoped** (`country = IN`) headcount, churn, tenure, mood, leaves                      |
| Code quality                | Aggregate + per-employee engineering oversight                                                |
| Project red flags           | Delivery risk needing attention                                                               |
| MBO analytics               | Cycle overview/performance/goals/weightage/category by fiscal year                            |
| Candidate added             | Hiring funnel intake                                                                          |
| Interview overview          | Funnel; optional one position real-time                                                       |
| Onboarding checklist        | Completion/compliance matrix (+ search)                                                       |
| Timesheet analytics         | Fill/approval rates, trends, project hours, missing streaks, auto-rows; date range ≤ 366 days |
| Bucket utilisation          | Capacity vs worked hours; bands `low`\|`medium`\|`high`\|`over`                               |

**Not in MCP:** salary burn CSV upload/downloads, monthly overtime report email,
generic CSV exports.

Optional `forceFetch` on many analytics tools bypasses cached snapshots.

## Surfaces Hub has that MCP does not expose

Risk Register, Policy Center, Orientation, Start Your Day, News, People's
Corner / Business Network, Spark, Elevate, AI Skills Library, Link Vault,
Meeting Tracker, Daily Scrum, Notes, Resource Request, Executive Items /
Generate Reports, Internal Service Management, Backend Audit, Group Management
admin, York Chatbot UI, FitWalk/Wellness, Floor Plan, Benefits browser.

Prefer Hub UI (or new MCP modules) for those.

## Architecture reminder

```text
MCP tool → BackendClient (user JWT) → Nest DTO + RBAC + service → Postgres
```

MCP stores only OAuth pending/audit (`mcp_oauth_*`, `mcp_audit_events`). Cognito
tokens are AES-sealed into the MCP Bearer — never logged, never long-term in DB.

Deployed: MCP container :3100 beside Nest :3001; hosts `mcp.*` vs `api.*`.

## Keeping this accurate

1. Update `docs/PROJECT_CONTEXT.md` when Hub behavior changes.
2. Align `hub-mcp` tool `description` strings with that doc.
3. Mirror important semantics here and in [tools.md](tools.md).
