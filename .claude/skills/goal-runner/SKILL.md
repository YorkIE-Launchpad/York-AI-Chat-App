---
name: goal-runner
description: >-
  Auto-detect goal type and drive work to completion across multi-tick /goal
  loops and one-shot “keep going until done” tasks. Use when the user starts
  /goal, an automation tick says continue working toward a goal, the prompt
  mentions GOAL_STATUS, or they ask to keep working, finish a goal, make
  tests pass, ship a fix, or continue until done. Classify the goal, pick the
  right playbook, take concrete steps, and only signal complete when objective
  criteria are met.
---

# Goal runner — detect type, work until done

You are operating under a **goal loop** or a finish-until-done request. Prefer
progress over narration. Use this skill on the **first** goal tick and every
continuation until the goal is truly complete.

## Status contract (required)

End **every** goal-tick reply with exactly one of these lines (last line preferred):

- `GOAL_STATUS: complete` — only when the goal’s success criteria are met **and**
  you can point to evidence (commands, files, tool results, UI checks).
- `GOAL_STATUS: in_progress` — more work remains, blocked on external input, or
  evidence is incomplete.

Do **not** use `complete` for “I have a plan”, “started investigating”, or
“likely fixed without re-checking”. The app stops automation on `complete`.

## Auto-detect goal type

On the first tick (or when the goal changes), classify into one primary type.
State it briefly once, then execute — do not re-debate every tick unless reality
disagrees.

| Type             | Signals in the goal text                              | Done means                                                       |
| ---------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| **fix**          | bug, error, broken, regression, crash, wrong behavior | Root cause addressed; verification shows symptom gone            |
| **tests-ci**     | tests pass, CI green, flake, coverage                 | Relevant suite/CI green (or clearly scoped failing subset fixed) |
| **implement**    | implement, add feature, build, create, ship           | Behavior exists, code/docs wired, basic check passes             |
| **refactor**     | cleanup, rename, restructure, simplify                | Structure changed; behavior preserved (tests or smoke)           |
| **research**     | investigate, why, find out, diagnose, analyze         | Findings written; open questions listed if any remain            |
| **ops-status**   | check, status, deploy, health, outage, monitor        | Current factual state + next action if unhealthy                 |
| **content-docs** | write, document, PRD, README, summary                 | Artifact exists at the expected path/place                       |
| **verify**       | confirm, validate, ensure, smoke test                 | Pass/fail with evidence; no more changes unless fail             |
| **multi**        | several independent outcomes in one goal              | Each sub-goal done; complete only when all are done              |

If ambiguous, prefer the type that maps to **observable proof** (tests-ci >
implement > research).

## Tick workflow (every continuation)

1. **Recall** goal + prior progress from the thread (do not reset context).
2. **Type** — keep prior classification unless wrong.
3. **Next step** — one high-leverage move for that type (tools, edits, checks).
   Prefer doing the work over restating the plan.
4. **Evidence** — capture what you ran/read and what it showed.
5. **Decide** — more left? → end `GOAL_STATUS: in_progress`. Done with proof? →
   `GOAL_STATUS: complete` + short proof line.
6. If **blocked** (missing credentials, ambiguous product choice, external human
   decision): say the blocker clearly and still end
   `GOAL_STATUS: in_progress` (automation will retry; do not fake complete).

## Playbooks (concise)

### fix

Reproduce or read error → narrow cause → smallest correct change → re-run the
failing scenario. Complete only after re-check.

### tests-ci

Identify failing command/scope → fix code or test → re-run same scope → green
before complete.

### implement

Clarify acceptance from the goal text → implement → smoke or unit check for the
new behavior → complete when acceptance is met.

### refactor

Ensure baseline (tests or smoke) → change structure → re-run baseline → complete
if behavior holds.

### research

Gather primary sources (code, logs, tools, docs) → synthesize answer → complete
when the question is answered; if only partial, stay in_progress and say what’s missing.

### ops-status

Query systems of record (Hub, LaunchPad, Slack, etc. via skills/tools) → report
facts → complete when status is accurate; if remediation was requested, complete
only after remediation + re-check.

### content-docs

Draft/write the artifact where expected → complete when the deliverable exists
and matches the ask.

### verify

Run the checks only → report pass/fail with evidence → complete on verified
pass; on fail, stay in_progress and fix only if the goal also asked to fix.

### multi

Split into checklist; each tick clear one item; complete only when every item
is checked with evidence.

## Cross-skill routing

| Goal domain                           | Also load / follow                           |
| ------------------------------------- | -------------------------------------------- |
| Company data, people, calendar, slack | `york-os` (+ hub/launchpad skills as routed) |
| LaunchPad release/ship                | `rnd-launchpad-mcp-sdlc`                     |
| HTML deck / one-pager                 | `html-artifact`                              |
| Office docs                           | `docx` / `pptx` / `xlsx` / `pdf` as named    |

Detect type **first**, then lean on the domain skill for tools — do not skip
the status contract.

## Anti-patterns

- Ending `complete` without re-running failed checks
- Treating “wrote a plan” as done for fix/implement/tests goals
- Changing type every tick without new evidence
- Asking the user to wait or to re-trigger a step you can do with tools
- Long recaps; prefer delta progress + evidence + status line
