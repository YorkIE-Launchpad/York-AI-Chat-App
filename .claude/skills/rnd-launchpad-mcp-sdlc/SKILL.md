---
name: launchpad-mcp-sdlc
description: >-
  Runs LaunchPad via MCP using the release loop: one active release, seed from
  last tag when empty, work, lock, poll backend agent, seed next active, repeat.
  Also covers Discover/Plan/Build/Validate, features, bugs, and QA. Use when
  shipping releases or operating LaunchPad through MCP.
---

# LaunchPad MCP SDLC

Operate LaunchPad through MCP with the **release loop** as the spine:

**one active release** → if no revision, **seed from last tag** → **work** → **lock** → **wait for backend agent** → next **active** → seed again → loop.

Others stay **draft** (or locked/skip). Do **not** call raw REST unless MCP is unavailable.

## When to use

- Ship features / fixes / QA on LaunchPad via MCP
- Confusion about active release, empty revisions, or post-lock wait
- Any release lifecycle work

## Preflight (always)

1. `get_me`
2. `list_projects` / `list_project_names` → `projectId`
3. `list_releases` → exactly one **active** (others draft/locked/skip)
4. `list_versions` → does active have `R1`+?

If active has **zero** revisions → seed before Build/Validate (see loop step 2).

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

| Rule             | Detail                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| One active       | Keep one `active`; leave others `draft` until lock                                                                                     |
| Empty active     | Always `seed_release_from_prior` with `mode: "baseline_copy"` (last tag) unless user wants `mode: "agent"` + `promptText`              |
| Implement target | Default **`platform`** (LaunchPad frontend/preview). Use **`development`** only when user asks for the linked development repo         |
| Lock wait        | Platform: poll `get_release_lock_status` (~30 min). Development implement: **`skipLockAgentOperations: true`** — no backend agent poll |
| Next cycle       | After lock settles, seed the **new** active before more work                                                                           |

Full model: [platform-model.md](references/platform-model.md). Sequences: [workflows.md](references/workflows.md).

## Intent on the loop

```
Feature  → Plan backlog/scope on active → Build (seed if needed → implement) → Validate → lock loop
Bug      → feedback AI fix on active+revision → preview → optional lock loop
QA       → Validate on active+revision
Ship     → lock → poll get_release_lock_status → seed next active → loop
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

### Backend code fixes (development repo)

1. `backend_code_chat_get_session` → `backend_code_chat_send_message` with **`prompt`** + `mode: "agent"` (creates/resumes; later sends = follow-ups)
2. Poll `backend_code_chat_get_session` — never `spawn_dev_agent` for Backend Code tab work

### Ship (end of cycle)

1. `lock_release` (`confirm: true`)
2. Poll `get_release_lock_status` until `readyForNextCycle` (or `locked && !agentActive`) — expect **up to ~30 minutes**; keep polling
3. `list_releases` → new active
4. `seed_release_from_prior` `{ mode: "baseline_copy" }` on **new** active
5. Resume work on that line

## MCP golden rules

- Destructive: `confirm: true`
- Long-running: start → poll (never SSE). Scope implement can take **hours**; lock up to **~30 min**
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
