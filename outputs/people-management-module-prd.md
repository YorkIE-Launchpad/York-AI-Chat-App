# People Management Module — PRD

**One-liner:** A centralized HRMS module for managing employee profiles, organizational structure, employment records, and key people changes.
**Author:** Kalrav Parsana · **Date:** 23 July 2026 · **Status:** Draft

## Problem

HR teams and managers often maintain employee information across spreadsheets, emails, and disconnected systems. This creates duplicate or outdated records, makes reporting difficult, and slows routine actions such as onboarding, manager changes, transfers, and exits. Employees also lack a reliable place to view and update their own information.

## Goals

- Establish one authoritative employee record for all active and former employees.
- Reduce HR time spent maintaining and locating people data by at least **40% within three months** of launch.
- Ensure at least **95% of active employee profiles are complete and current** within 60 days.
- Give authorized managers an accurate view of their teams and reporting hierarchy.
- Maintain an auditable history of sensitive profile and employment changes.

## Non-goals

- Payroll calculation and salary disbursement.
- Recruitment and applicant tracking.
- Performance reviews, goals, or learning management.
- Workforce scheduling, attendance, and leave management.
- Advanced workforce planning or predictive analytics.

## Target users

- **HR administrators:** Own employee records, lifecycle actions, and data quality.
- **People managers:** View their teams and initiate permitted changes.
- **Employees:** View organizational information and maintain approved personal details.
- **Leadership:** Access organization-level headcount and structure insights.

## Proposed solution

Add a role-based People Management module containing a searchable employee directory, detailed employee profiles, organization chart, teams and departments, and lifecycle actions. Employees can submit permitted profile updates; managers can view direct and indirect reports; HR can create and maintain employment records. Sensitive changes follow approval rules and all material actions are logged.

## Requirements

- **P0:** HR can create, view, edit, deactivate, and reactivate employee records with unique employee IDs.
- **P0:** Profiles support personal, contact, job, manager, department, location, employment-status, and joining-date information.
- **P0:** Role-based access restricts personal, employment, compensation, and administrative data by user role.
- **P0:** Users can search and filter employees by name, ID, department, manager, location, and status.
- **P0:** The system represents reporting relationships and prevents invalid or circular hierarchies.
- **P0:** HR can process manager changes, transfers, promotions, and exits while preserving effective-dated history.
- **P0:** Material changes record actor, timestamp, previous value, and new value in an audit log.
- **P1:** Employees can submit selected personal-data changes for approval.
- **P1:** Managers can view direct and indirect reports and initiate configured people changes.
- **P1:** HR can bulk import and export employee data with validation and error reporting.
- **P1:** Dashboards show headcount by department, location, employment type, and status.
- **P2:** Profiles support documents, configurable custom fields, and reminders for expiring records.

## Open questions

- Which profile fields and approval workflows must be configurable by each organization?
- Is compensation data included in this module or owned by a separate payroll/compensation module?
- Which privacy, retention, residency, and regulatory requirements apply by operating country?
- Should onboarding and offboarding tasks be part of the first release or separate workflow modules?
- Which systems require initial integrations, such as payroll, identity management, attendance, or accounting?
