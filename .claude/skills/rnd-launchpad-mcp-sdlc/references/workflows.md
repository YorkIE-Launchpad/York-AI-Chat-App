# LaunchPad MCP workflows

Spine: **one active → seed if empty → work (platform implement default) → lock (skip agent if development) → poll if needed → seed next → loop**.

Never implement or seed on a **locked** id. Never promise preview without **active + ≥1 revision**.

---

## Canonical release loop

1. `list_releases` → note `activeReleaseId` (exactly one `active`; others draft/locked/skip)
2. `list_versions` filtered to that release (or project versions tied to it)
3. **If no revisions:**
   ```json
   seed_release_from_prior({
     "projectId": <id>,
     "releaseId": <activeReleaseId>,
     "mode": "baseline_copy"
   })
   ```
   (`mode: "agent"` only with `promptText` when user wants AI delta)
4. **Work** on active: scope / implement / agents / preview / QA / feedback
5. **Ship cycle:**
   - Platform work (default):
   ```json
   lock_release({ "releaseId": <activeReleaseId>, "confirm": true })
   ```
   Then poll until ready (up to **~30 minutes**; never SSE):
   ```json
   get_release_lock_status({ "releaseId": <sameId> })
   ```
   Stop when `locked === true` and `agentActive === false` (or `readyForNextCycle === true`)
   - Development-repo implement: lock immediately without backend agent:
   ```json
   lock_release({ "releaseId": <activeReleaseId>, "confirm": true, "skipLockAgentOperations": true })
   ```
6. `list_releases` → new `active` (often empty patch)
7. Goto step 3 on the **new** active id

---

## 0. Empty active release only

Same as loop steps 3–4. Signals: active with zero versions / “awaiting first revision”.

---

## 1. New feature on existing project

### Plan

1. Preflight (`get_me`, `list_projects`, `list_releases`, `list_versions`)
2. Optional Discover/PRD
3. `create_epic` / `create_story`
4. Ensure one active:
   - `create_release` with `startDate` + `releaseDate`, or
   - `activate_release` on a draft with **`reason`** (prefer only after prior lock)
5. If no revisions → **seed `baseline_copy`**
6. `set_release_scope` with `items`

### Build

7. `start_scope_implement` with `execution: "sequential"` and default **`target: "platform"`** (LaunchPad frontend/preview; use `development` only if user asks) → poll for **hours** if needed until terminal
8. `list_versions` → expect new `Rn`
9. Optional agents; `start_preview`

### Validate + close cycle

10. QA / feedback as needed
11. Lock:
    - If implement was **platform**: `lock_release` `{ confirm: true }` → poll `get_release_lock_status` (~30 min)
    - If implement was **development**: `lock_release` `{ confirm: true, skipLockAgentOperations: true }` (bypass backend agent)
12. `list_releases` → seed next active

**Example create_release:**

```json
{
  "projectId": 12,
  "name": "1.1.0",
  "startDate": "2026-07-14",
  "releaseDate": "2026-08-01"
}
```

---

## 2. After lock (next line)

Identical to loop seed/list after lock. Do not call implement on the locked release.

---

## 3. Bug from client feedback

1. Preflight; active must have a live revision (seed first if empty)
2. `list_feedback` / `get_feedback` — UUID `feedbackId`
3. `start_feedback_ai_fix` → poll `get_feedback_ai_fix_status`
4. `approve_feedback`
5. `start_preview`
6. Optional: continue to lock loop when shipping

---

## 4. Full Validate (QA)

1. Active + revision required
2. `get_qa_config` → topics / chats / `send_qa_chat_message` → poll
3. `list_qa_reports` → optional `move_qa_report_to_feedback` → §3

---

## 5. Temporary vs live revision

| Goal                       | Tool                                            |
| -------------------------- | ----------------------------------------------- |
| Peek without changing live | `switch_version`                                |
| Make live                  | `activate_version` (on **active** release only) |

---

## 6. Backend code fix pass (development repo)

Use **backend code chat** only — do **not** use `spawn_dev_agent` / `agent_followup` for Backend Code tab work.

1. `backend_code_chat_get_session` — inspect session / messages / whether an agent is already running
2. `backend_code_chat_send_message` with **`prompt`** (required; not `message`) and usually `mode: "agent"`
   - First send **creates/resumes** the Cursor agent on the linked development repo
   - Later sends are **follow-ups** on the same project chat
   - Archived thread is fine: send still get-or-creates a session — no separate spawn path
3. Poll `backend_code_chat_get_session` until the assistant turn is terminal (no SSE)
4. More work → repeat step 2–3 (same tool = follow-up). Optional: `backend_code_chat_stop` / `backend_code_chat_archive`

**Example:**

```json
{
  "projectId": 12,
  "prompt": "Apply the security fixes from the report: ...",
  "mode": "agent"
}
```

Same `prompt` field for `infra_analysis_chat_send_message` and `cloud_debug_chat_send_message`.

---

## Decision checklist

- [ ] One active release; others draft/locked/skip
- [ ] Empty active seeded with `mode: "baseline_copy"` before work
- [ ] Build writes only on active
- [ ] Implement defaulted to `target: "platform"` unless user asked for development
- [ ] After platform lock, polled `get_release_lock_status` (~30 min; not SSE); after development implement, locked with `skipLockAgentOperations: true`
- [ ] Next cycle seeded on **new** active id
- [ ] Destructive calls use `confirm: true`
