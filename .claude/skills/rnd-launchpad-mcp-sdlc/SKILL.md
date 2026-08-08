---
name: rnd-launchpad-mcp-sdlc
description: >-
  Runs LaunchPad via MCP using the release loop: one active release, seed from
  last tag when empty, work, lock, poll backend agent, seed next active, repeat.
  Also covers Discover/Plan/Build/Validate, features, bugs, QA, and frontend
  visual-parity migrate/compare loops. Use when shipping releases or operating
  LaunchPad through MCP.
---

# LaunchPad MCP SDLC

Operate LaunchPad through MCP with the **release loop** as the ship spine:

**one active release** → if no revision, **seed from last tag** → **work** → **lock** → **wait for backend agent** → next **active** → seed again → loop.

Others stay **draft** (or locked/skip). Do **not** call raw REST unless MCP is unavailable.

Visual-fidelity / migration work sits in **Build → Frontend** and still obeys
active+revision rules — it does not skip preflight or seed.

## When to use

- Ship features / fixes / QA on LaunchPad via MCP
- Confusion about active release, empty revisions, or post-lock wait
- Frontend visual parity / migrate / compare against production or preview
- Any release lifecycle work (including goal-loop ticks)

## Product spine (journey)

Presentation layer: Discover → Plan → Build → Validate (URL section/area params).
Nav allows jumps; progress badges are soft guidance. Hard gates still apply
(active+revision for chat/preview; locked release cannot take new revisions).

```
Discover: Capture → Profiles → Documents → Brief
Plan:     Backlog → Releases (active + scope)
Build:    Frontend (preview / Client Link / migrate) → lock → Backend → Cloud
Validate: QA (loops back into feedback / next release often)
```

| Phase        | Stages                              | Job                                                     |
| ------------ | ----------------------------------- | ------------------------------------------------------- |
| **Discover** | Capture, Profiles, Documents, Brief | Project memory before planning/shipping                 |
| **Plan**     | Backlog, Releases                   | Work packages + release cadence                         |
| **Build**    | Frontend, Backend, Cloud            | UI/preview, APIs after lock, env/deploy/infra           |
| **Validate** | QA                                  | Automated QA; often loops to feedback / next Plan cycle |

**Lifecycle glue (Plan ↔ Build):**

Draft release → Active → Seed revision(s) → Frontend work / Client Link →
Client approval → **Lock** → Backend agent → next active (seed again).

Client Link hangs off **active release + live revision** — not a separate phase.
Without those, chat/preview are blocked.

Happy path is left-to-right; free nav is allowed. Prefer continuing from the
current incomplete stage rather than restarting Discover each tick.

Full model: [platform-model.md](references/platform-model.md).

## Preflight (always)

1. `get_me`
2. `list_projects` / `list_project_names` → `projectId`
3. `list_releases` → exactly one **active** (others draft/locked/skip)
4. `list_versions` → does active have `R1`+?

If active has **zero** revisions → seed before Build/Validate (see loop step 2).

## Preview surface = platform (critical)

When the user says **on preview**, **LaunchPad preview**, **through launchpad**, or asks to show UI/cards/logo on preview:

| Do                                                    | Don't                                              |
| ----------------------------------------------------- | -------------------------------------------------- |
| `start_scope_implement` with **`target: "platform"`** | `target: "development"`                            |
| Then poll implement to terminal → **`start_preview`** | Backend Code chat                                  |
| Keep polling status tools until terminal              | `backend_code_chat_send_message` / dev-repo agents |

Use **`development`** / Backend Code **only** when the user explicitly names the development repo or Backend Code tab.

## Release loop (primary operating model)

```
1. Identify active release (list_releases)
2. No revision? → seed_release_from_prior(mode="baseline_copy") on ACTIVE id
3. Work (scope, implement on target=platform by default, agents, preview, QA, feedback fix)
4. Done → lock_release(confirm=true)
   - If implement was development → also skipLockAgentOperations=true (bypass backend agent)
5. If not skipped: poll get_release_lock_status until locked=true and agentActive=false (~30 min)
6. list_releases → new active patch (often empty)
7. Goto 2 on the NEW active id — never implement/seed on the locked id
```

| Rule             | Detail                                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| One active       | Keep one `active`; leave others `draft` until lock                                                                                                  |
| Empty active     | Always `seed_release_from_prior` with `mode: "baseline_copy"` (last tag) unless user wants `mode: "agent"` + `promptText`                           |
| Implement target | Default **`platform`** (LaunchPad frontend/preview). Use **`development`** only when user asks for the linked development repo                      |
| Wait after start | **Always poll** until terminal (`completed` / `failed` / `locked && !agentActive` / done≥total). Never stop after start; never ask the user to wait |
| Next cycle       | After lock settles, seed the **new** active. After implement terminal for a preview ask → `start_preview` without asking                            |
| Lock wait        | Platform: poll `get_release_lock_status` (~30 min). Development implement: **`skipLockAgentOperations: true`** — no backend agent poll              |

Sequences: [workflows.md](references/workflows.md).

## In-tick polling (goal loops + normal turns)

After any start tool (`start_scope_implement`, migrate/conversion, `start_preview`,
`lock_release`, feedback AI fix, etc.):

1. **Stay in the turn.** Poll status every few–tens of seconds until terminal.
2. On success, run the **next** SDLC step immediately (preview → open UI → compare, etc.).
3. Do **not** end a goal tick with “started; wait 5 minutes” — the interval is a
   backstop, not a substitute for polling.
4. If force-parked (hours-scale job or poll budget): emit durable state for goal-runner:

```
RESUME: projectId=… releaseId=… conversionId=… agentId=… step=poll_migrate next=list_versions
GOAL_STATUS: in_progress
```

5. **“Agent not found for this project”** is not terminal — alternate poll paths:
   `list_versions` (new `Rn`?), implement run status tools, `get_preview_status`,
   conversion/list tools when available. Continue when a revision or preview update
   appears; only re-start after confirmed death + goal still needs the work.

See [pitfalls.md](references/pitfalls.md).

## Intent on the loop

```
Feature       → Plan backlog/scope on active → Build (seed if needed → implement) → Validate → lock loop
Bug           → feedback AI fix on active+revision → preview → optional lock loop
QA            → Validate on active+revision
Ship          → lock → poll get_release_lock_status → seed next active → loop
Visual parity → Build Frontend: compare → correct migrate → poll → re-preview → re-compare (loop)
```

## Short playbooks

Tools: [tool-map.md](references/tool-map.md).

### Feature

1. Optional Discover/PRD
2. Epics/stories; ensure **one active** (`create_release` needs `startDate`+`releaseDate`, or `activate_release` with **`reason`**)
3. If no revisions: `seed_release_from_prior` `{ mode: "baseline_copy" }`
4. `set_release_scope` → `start_scope_implement` `{ execution: "sequential", target: "platform" }` (use `development` only if asked) → poll for hours if needed → terminal
5. `start_preview` → QA
6. Lock: platform → `lock_release` `{ confirm: true }` + poll; development implement → `lock_release` `{ confirm: true, skipLockAgentOperations: true }`

### Bug / feedback

1. Active + ≥1 revision required
2. `list_feedback` / `get_feedback` (UUID id) → `start_feedback_ai_fix` → poll → `approve_feedback`
3. Preview; continue loop if shipping

### QA

1. `get_qa_config` / topics / `send_qa_chat_message` → reports
2. Failures → `move_qa_report_to_feedback` → bug playbook

### Frontend visual parity / correction

Use for fidelity goals (e.g. ≥95% match production internal pages), migrate fixups,
or “compare preview vs prod.” Stays on **platform** preview — not development Backend Code.

1. Preflight: active + ≥1 revision; `start_preview` / poll `get_preview_status` if needed
2. **Auth preview** — use displayed mock credentials (e.g. login form hint); never stop at
   “loading Login” without retry, alternate path, or restart preview + evidence
3. Open target internal routes; capture screenshots (and prod side-by-side when reachable)
4. Diff → structured correction prompt → `migrate_frontend` / readonly migrate / platform
   scope implement (`target: "platform"`)
5. **Poll until terminal** — implement/migrate status tools; if agent id invalid:
   `list_versions` + preview/implement status until new revision or confirmed failure
6. Restart/await preview on the new revision; re-open **same** pages; re-compare
7. Loop until criteria met (or residual diffs + unblockable reason documented)
8. Optional ship: lock loop only after fidelity criteria satisfied

Login/auth surface intentionally left alone unless the goal says otherwise.
Clean install / TypeScript / production build constraints from the correction prompt must pass.

Full numbered sequence: [workflows.md](references/workflows.md) §7.

### Backend code fixes (development repo)

1. Only when user explicitly asks for Backend Code / development repo
2. `backend_code_chat_get_session` → `backend_code_chat_send_message` with **`prompt`** + `mode: "agent"` (creates/resumes; later sends = follow-ups)
3. Poll `backend_code_chat_get_session` — never `spawn_dev_agent` for Backend Code tab work

### Ship (end of cycle)

1. `lock_release` (`confirm: true`)
2. Poll `get_release_lock_status` until `readyForNextCycle` (or `locked && !agentActive`) — expect **up to ~30 minutes**; keep polling
3. `list_releases` → new active
4. `seed_release_from_prior` `{ mode: "baseline_copy" }` on **new** active
5. Resume work on that line

## MCP golden rules

- Destructive: `confirm: true`
- Long-running: start → poll (never SSE). Scope implement can take **hours**; lock up to **~30 min**. **Do not end the turn mid-poll.**
- Goal ticks: same rule — poll in-tick; park only with `RESUME:` after a real wait budget
- Ask the user only for real forks (platform vs development when ambiguous **and** no preview cue; seed `agent` vs `baseline_copy` when unspecified). Otherwise auto-continue next SDLC step.
- `create_release`: `startDate` + `releaseDate`
- `start_scope_implement`: prefer **`execution: "sequential"`** (separate PR per story); default **`target: "platform"`**; all-in-one via **`batchMode`**: `sequential_agents_shared_pr` | `parallel_agents_separate_prs` | `single_agent_shared_pr`; always pass **`items[].sortOrder`**
- Development implement → lock with **`skipLockAgentOperations: true`** (bypass backend agent)
- Platform lock → poll `get_release_lock_status` (~30 min)
- `activate_release` / `update_release_status` / `update_release`: **`reason` required**
- `seed_release_from_prior`: **`mode` required** (`baseline_copy` \| `agent`)
- Feedback ids are UUIDs
- Exclusions: AWS debug MCP, webhooks, OAuth callbacks, multipart ZIP, SSE, internal secrets

See [pitfalls.md](references/pitfalls.md).

## References

| Topic                               | File                                               |
| ----------------------------------- | -------------------------------------------------- |
| Release loop + statuses + revisions | [platform-model.md](references/platform-model.md)  |
| Phase → tools                       | [tool-map.md](references/tool-map.md)              |
| Numbered sequences                  | [workflows.md](references/workflows.md)            |
| Required fields / poll / exclusions | [pitfalls.md](references/pitfalls.md)              |
| MCP package setup                   | [mcp-server/README.md](../../mcp-server/README.md) |
