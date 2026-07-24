# People Management Module — PRD

**One-liner:** A single place inside the HRMS where managers and HR maintain the employee record — profiles, reporting structure, org hierarchy, and lifecycle status — as the source of truth the rest of the HRMS relies on.
**Author:** Kalrav Parsana · **Date:** 2026-07-23 · **Status:** Draft

## Problem

Today employee data is scattered across spreadsheets, email threads, and disconnected tools. When someone joins, moves teams, changes managers, or leaves, updates are manual, inconsistent, and often late. This breaks everything downstream that assumes a correct org picture — leave approvals routing to the wrong manager, allocation/utilization reports built on stale reporting lines, and HR spending hours reconciling records. A People Management module gives the organization one authoritative, always-current view of who works here, who they report to, and what state they are in.

## Goals

- Establish a single source of truth for every active employee profile and reporting relationship.
- Cut the time to complete a common people change (new hire, transfer, manager change, exit) to **under 5 minutes** with no downstream re-entry.
- Reach **≥95% of active employees** having a complete profile (manager, role, department, location, start date) within 60 days of launch.
- Ensure any reporting-line change propagates automatically to dependent modules (leave/WFH approval routing, org chart) within the same session — **zero manual re-syncs**.

## Non-goals

- **Payroll, compensation, and benefits** processing (separate module).
- **Recruitment/ATS** and candidate pipelines — this module starts at "hired."
- **Performance reviews / goal (MBO) management** — consumes profile data but is out of scope here.
- **Time tracking, leave balances, and attendance logic** — this module owns the _people record_, not the _transactions_ against it.
- Full historical HR analytics/BI dashboards beyond basic headcount views.

## Target users

- **HR administrators / HR ops** — own accuracy and lifecycle changes across the org.
- **People managers** — view and update their direct/indirect reports; initiate transfers and manager changes.
- **Employees** — self-service view/edit of a limited set of their own profile fields.
- **Downstream systems/modules** — consume the org graph via a stable internal API.

## Proposed solution

A People Management module organized around three views:

1. **Employee profile** — a structured record with identity, role, department, location, employment type, manager, start date, and lifecycle status. Fields are permission-scoped (employee-editable vs HR-only).
2. **Org & reporting structure** — an interactive org chart derived from manager relationships, with drill-down into teams and squads. Changing a manager here updates the graph and notifies affected approval routing.
3. **Lifecycle management** — guided flows for the key transitions: onboard, transfer/reorg, manager change, and offboard. Each flow captures effective dates and produces an auditable event.

All changes are versioned with an audit trail (who changed what, when, effective date). The module exposes a read API so leave/WFH, allocation, and reporting modules always resolve the current org picture.

## Requirements

**P0 — must ship**

- Create, view, edit, and deactivate an employee profile with core fields (name, work email, role/title, department, location, employment type, manager, start date, status).
- Assign and change reporting manager; org chart reflects it immediately.
- Role-based access control: employee, manager, HR admin scopes with field-level permissions.
- Audit trail for every profile and reporting change, including effective date.
- Read API/interface so other HRMS modules resolve current manager and org data.
- Employee lifecycle status (Active, On Leave, Inactive/Exited) that gates downstream behavior.

**P1 — should ship**

- Guided lifecycle flows (onboard, transfer, manager change, offboard) with required-field validation.
- Search and filter the directory (by name, department, manager, location, status).
- Self-service: employees edit a limited set of their own fields (contact, personal details) with optional HR approval.
- Bulk import/update via CSV for initial migration and mass reorgs.

**P2 — nice-to-have**

- Effective-dated future changes (schedule a transfer to take effect on a date).
- Custom fields configurable by HR without engineering.
- Basic headcount views (by department, location, manager).

## Open questions

- **Source of truth vs. sync:** Is this module the authoritative record, or does another system (AD/Google Workspace) partly own identity? Assumed authoritative here.
- **Self-service edit scope:** Which fields can employees change directly vs. require HR approval? Assumed contact/personal only.
- **Manager change side effects:** Should in-flight leave/WFH approvals reroute to the new manager or stay with the original approver? Assumed reroute for pending, retain history for completed.
- **Effective-dated changes:** Launch need or fast-follow? Assumed P2.
- **Multi-country / entity:** Do location, employment type, or data-privacy rules differ enough by country (India vs US) to need per-region field configs? Assumed single global schema at launch.
- **Historical migration:** How much history (past managers, past roles) must migrate vs. start clean at go-live?
