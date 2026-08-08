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

**Never park solely because “job started.”** Starting an async job is not enough
progress to end the tick unless you either (a) poll to a terminal state and do the
next step, or (b) emit a durable `RESUME:` line after a real poll budget (see
Async protocol).

## Auto-detect goal type

On the first tick (or when the goal changes), classify into one primary type.
State it briefly once, then execute — do not re-debate every tick unless reality
disagrees.

| Type             | Signals in the goal text                                                              | Done means                                                                 |
| ---------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **fix**          | bug, error, broken, regression, crash, wrong behavior                                 | Root cause addressed; verification shows symptom gone                      |
| **tests-ci**     | tests pass, CI green, flake, coverage                                                 | Relevant suite/CI green (or clearly scoped failing subset fixed)           |
| **implement**    | implement, add feature, build, create, ship (local/non-LaunchPad)                     | Behavior exists, code/docs wired, basic check passes                       |
| **refactor**     | cleanup, rename, restructure, simplify                                                | Structure changed; behavior preserved (tests or smoke)                     |
| **research**     | investigate, why, find out, diagnose, analyze                                         | Findings written; open questions listed if any remain                      |
| **ops-status**   | check, status, deploy, health, outage, monitor                                        | Current factual state + next action if unhealthy                           |
| **content-docs** | write, document, PRD, README, summary                                                 | Artifact exists at the expected path/place                                 |
| **verify**       | confirm, validate, ensure, smoke test                                                 | Pass/fail with evidence; no more changes unless fail                       |
| **launchpad**    | LaunchPad, release, migrate, conversion, preview, fidelity, Client Link, active release | Observable LaunchPad outcome (preview/QA/ship/fidelity) with tool evidence |
| **multi**        | several independent outcomes in one goal                                              | Each sub-goal done; complete only when all are done                        |

If the goal mixes LaunchPad ship/fidelity with other work, prefer **`launchpad`**
(or **`multi`** with a LaunchPad checklist) over plain implement.

If ambiguous otherwise, prefer the type that maps to **observable proof**
(tests-ci > implement > research).

## Tick workflow (every continuation)

1. **Recall** goal + prior progress + any `RESUME:` line from the thread (do not
   reset context; do not re-seed or re-launch blindly).
2. **Type** — keep prior classification unless wrong.
3. **Resume first** — if a prior tick parked long-running work, poll that job
   before starting new work.
4. **Next step** — one high-leverage move for that type (tools, edits, checks).
   Prefer doing the work over restating the plan. After any start tool, apply
   the **Async / wait protocol** immediately in this same tick.
5. **Evidence** — capture what you ran/read and what it showed.
6. **Decide** — more left? → end `GOAL_STATUS: in_progress` (with `RESUME:` if
   parking). Done with proof? → `GOAL_STATUS: complete` + short proof line.
7. If **blocked** (missing credentials, ambiguous product choice, external human
   decision): say the blocker clearly and still end
   `GOAL_STATUS: in_progress` (automation will retry; do not fake complete).

## Async / wait protocol (required for external jobs)

Applies whenever you start or discover a long-running job (LaunchPad migrate /
implement / lock / preview / AI fix, CI, agents, deploys, etc.).

### In-tick (default)

1. Call the start tool.
2. **Keep the turn alive.** Poll status tools every few–tens of seconds until
   terminal (`completed` / `failed` / `cancelled` / `locked && !agentActive` /
   `done >= total` / equivalent).
3. On terminal **success**, immediately run the next SDLC step in the same tick
   (e.g. `start_preview` → open pages → compare → correct again).
4. On terminal **failure**, recover (see matrix) or re-run with a fixed prompt;
   do not end after a single failed status lookup.

### Cross-tick park (only when necessary)

Park only if the job is **hours-scale** (multi-item implement) or you hit a hard
in-tick poll budget while the job is still legitimately running.

When parking, end with **one durable line** (before `GOAL_STATUS: in_progress`):

```
RESUME: projectId=<id> releaseId=<id> conversionId=<id?> agentId=<id?> step=<poll_migrate|poll_implement|poll_lock|...> next=<tool_name>
```

Next tick:

1. Parse `RESUME:` from prior replies.
2. Poll `next` / status tools **first**.
3. Continue; never restart the full journey or re-seed unless evidence says the
   job died with no revision and a restart is required.

### Recovery matrix

| Symptom                                         | Do this (same tick)                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Agent / conversion id “not found for project”   | Do **not** stop. Use alternates: `list_versions`, implement run status, preview status; if new `Rn` exists, continue.    |
| Opaque agent id but migration was started       | Poll versions + preview until revision appears or failure is confirmed; then verify.                                     |
| Preview stuck on “loading Login”                | Retry auth with displayed mock credentials; alternate login path; hard-refresh / restart preview; capture error evidence. |
| Production auth HTTP 400 / unreachable          | Continue compare with preview-only + recorded residual; do not claim 95% from imagination.                               |
| Active release has zero revisions               | `seed_release_from_prior` `{ mode: "baseline_copy" }` then resume work.                                                  |
| Lock agent still running after long poll        | Keep polling `get_release_lock_status`; if must park, `RESUME:` with step=poll_lock.                                     |
| Status says failed / cancelled                  | Read error; re-start with corrected prompt only if the goal still requires the fix; else report residual.                |

Ending `in_progress` with only “waiting for next tick / migration started” and
no `RESUME:` line and no alternate poll is an **anti-pattern**.

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

### launchpad

Load and follow **`rnd-launchpad-mcp-sdlc`** on the first LaunchPad tick and
every continuation (not one-off). Prefer the skill’s **continuous controller**
([`references/continuous-loop.md`](../rnd-launchpad-mcp-sdlc/references/continuous-loop.md)):
sense → decide phase (Discover / Plan / Build / Validate / Ship) → act → poll →
advance or rewind → next release. Preflight active release + revision before
Build/Validate writes.

- **Continuous / 24×7 deliver** → full phase loop + release loop forever until
  goal criteria evidenced; emit `PHASE` / `NEXT_ACTION` / `RESUME` / `GOAL_STATUS`
- **Feature/ship** → Plan scope → seed → implement platform → preview → QA → lock → seed next
- **Bug** → feedback AI fix → poll → preview
- **Visual fidelity / migrate / parity** → Frontend visual parity playbook in the skill
- **QA fail** → rewind to Build, re-Validate (do not claim ship)

Complete only with evidence (preview/QA/lock/fidelity). Async protocol is mandatory
after every start tool. Do **not** complete after a single lock unless the goal
was only that ship event.

### multi

Split into checklist; each tick clear one item; complete only when every item
is checked with evidence.

When the multi goal is **visual fidelity / migrate + compare** (or similar):

1. Auth preview (mock creds if shown); do not park on login “loading”.
2. Open target internal routes.
3. Screenshot compare preview vs prod (or preview-only if prod blocked).
4. File structured correction migrate / platform implement.
5. **Poll** migrate/implement to terminal revision (recovery matrix if agent id fails).
6. Restart/await preview; re-open same pages; re-compare.
7. Loop until ≥95% parity **or** residual diffs documented with why unblockable.
8. Complete only with evidence — never from “source migration is complete.”

## Cross-skill routing

| Goal domain                                   | Also load / follow                                                    |
| --------------------------------------------- | --------------------------------------------------------------------- |
| Company data, people, calendar, slack         | `york-os` (+ hub/launchpad skills as routed)                          |
| LaunchPad release / ship / migrate / fidelity | **`rnd-launchpad-mcp-sdlc`** (required every launchpad tick)          |
| HTML deck / one-pager                         | `html-artifact`                                                       |
| Office docs                                   | `docx` / `pptx` / `xlsx` / `pdf` as named                             |

Detect type **first**, then lean on the domain skill for tools — do not skip
the status contract. LaunchPad domain work must keep the SDLC skill in play
across ticks (resume from `RESUME:` and prior release/revision ids).

## Anti-patterns

- Ending `complete` without re-running failed checks
- Treating “wrote a plan” or “job started” as done for fix/implement/tests/launchpad goals
- Ending the tick immediately after `start_*` / migrate without polling
- Waiting for the next 2m/5m goal interval instead of in-tick polling
- Treating “Agent not found” as terminal without alternate status paths
- Claiming ≥95% visual parity without side-by-side evidence
- Changing type every tick without new evidence
- Asking the user to wait or to re-trigger a step you can do with tools
- Long recaps; prefer delta progress + evidence + status line
