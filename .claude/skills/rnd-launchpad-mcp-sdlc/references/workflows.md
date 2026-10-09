# LaunchPad MCP workflows

Spine for continuous agents: **sense → act → poll → next → (rewind) → next release**.

Canonical math of the platform is the **release loop**. Journey phases tell you
_what kind of work_ to do next; the release loop is _where_ Build/Validate write.

Never implement or seed on a **locked** id. Never promise preview without
**active + ≥1 revision**.

Continuous decision tree: [continuous-loop.md](continuous-loop.md).

---

## Canonical release loop

1. `list_releases` → note `activeReleaseId` (exactly one `active`; others draft/locked/skip)
2. `list_versions` for that release
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
   - Development-repo implement:
   ```json
   lock_release({
     "releaseId": <activeReleaseId>,
     "confirm": true,
     "skipLockAgentOperations": true
   })
   ```
6. `list_releases` → new `active` (often empty patch)
7. Goto step 3 on the **new** active id

---

## Continuous multi-cycle (24×7)

```
preflight
while goal_not_complete:
  RESUME first if present
  decide_phase  # discover|plan|build|validate|ship  (priority table)
  act_one_high_leverage_step
  if started_async:
    poll_until_terminal_or_park(RESUME)
  if validation_failed:
    set_phase build  # rewind
  if ship_ready and goal_wants_lock:
    lock → poll → seed next
  emit PHASE / NEXT_ACTION / GOAL_STATUS
```

### Per-phase one-shot sequences

#### D — Discover cycle

1. `get_client_details`
2. If sparse: `scrape_client_website` / `enrich_client_details` / `add_discovery_note` with goal text
3. `generate_discovery_summary` or `discovery_chat`
4. Optional: `generate_prd` / `generate_workspace_document`
5. Exit → Plan when stories can be named truthfully

#### P — Plan cycle

1. `get_backlog_suggestions` → `apply_backlog_suggestion` and/or `create_epic` + `create_story`
2. Ensure one active:
   - `create_release` with `startDate` + `releaseDate`, or
   - `activate_release` with **`reason`**
3. `set_release_scope` with items
4. Exit → Build

#### B — Build cycle (platform default)

1. Seed if empty (`baseline_copy`)
2. `start_scope_implement`:
   ```json
   {
     "projectId": 12,
     "releaseId": 99,
     "mode": "selected",
     "execution": "sequential",
     "target": "platform",
     "items": [
       { "storyId": 1, "sortOrder": 1 },
       { "storyId": 2, "sortOrder": 2 }
     ]
   }
   ```
3. Poll `get_scope_implement_active` / `get_scope_implement_run` + `list_versions` (hours OK)
4. `start_preview` → `get_preview_status` (boot failure → `get_preview_manifest` / `update_preview_manifest` / `update_preview_env`)
5. Optional fidelity: §7
6. Optional Backend Code (user asked) §6

#### V — Validate cycle

1. `get_qa_config` / topics / `send_qa_chat_message` → poll message
2. `list_qa_reports` → `move_qa_report_to_feedback` on fails
3. Feedback path §3
4. Rewind to Build until green or residual accepted

#### S — Ship cycle

Identical to release loop steps 5–7.

---

## 0. Empty active release only

Loop steps 3–4. Signals: active with zero versions / “awaiting first revision”.

### 0a. Greenfield — no prior tagged revision anywhere

`seed_release_from_prior` needs a prior tag. When none exists:

```json
start_first_revision_from_prompt({
  "projectId": <id>,
  "releaseId": <activeReleaseId>,
  "promptText": "Build the first revision: <product summary from discovery/PRD>"
})
```

Poll `get_cursor_agent` until terminal, then `list_versions` → R1 → preview.

For a blank scaffold instead (no agent), `create_empty_react_revision({ projectId, releaseId })`
publishes a minimal Vite React app as R1 synchronously.

---

## 1. New feature on existing project

### Plan

1. Preflight (`get_me`, `list_projects`, `list_releases`, `list_versions`)
2. Optional Discover/PRD
3. `create_epic` / `create_story`
4. Ensure one active (`create_release` or `activate_release` + reason)
5. If no revisions → seed `baseline_copy`
6. `set_release_scope` with `items`

### Build

7. `start_scope_implement` with `execution: "sequential"`, `target: "platform"` → poll
8. `list_versions` → expect new `Rn`
9. `start_preview`

### Validate + close cycle

10. QA / feedback as needed
11. Lock (platform: poll lock status; development: skipLockAgentOperations)
12. `list_releases` → seed next active → continue if continuous goal

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

Seed/list only on the **new** active. Do not implement on the locked release.

---

## 3. Bug from client feedback

1. Preflight; active must have a live revision (seed first if empty)
2. `list_feedback` / `get_feedback` — UUID `feedbackId`
3. `start_feedback_ai_fix` → poll `get_feedback_ai_fix_status`
4. `approve_feedback` when appropriate
5. `start_preview`
6. Optional: continue to lock loop when shipping

---

## 4. Full Validate (QA)

1. Active + revision required
2. `get_qa_config` → topics / chats / `send_qa_chat_message` → poll
3. `list_qa_reports` → optional `move_qa_report_to_feedback` → §3
4. Failures rewind to Build; success → Ship or next Plan

---

## 5. Temporary vs live revision

| Goal                       | Tool                                            |
| -------------------------- | ----------------------------------------------- |
| Peek without changing live | `switch_version`                                |
| Make live                  | `activate_version` (on **active** release only) |

---

## 6. Backend code fix pass (development repo)

Use **backend code chat** only — do **not** use `spawn_dev_agent` for Backend Code tab work.

1. `backend_code_chat_get_session`
2. `backend_code_chat_send_message` with **`prompt`** and usually `mode: "agent"`
3. Poll `backend_code_chat_get_session` until assistant terminal
4. More work → repeat send; optional stop/archive tools if exposed

```json
{
  "projectId": 12,
  "prompt": "Apply the security fixes from the report: ...",
  "mode": "agent"
}
```

Same `prompt` field for `infra_chat_send_message` and `cloud_debug_chat_send_message`
(poll `infra_chat_get_session` / `cloud_debug_chat_get_session`). Infra chat IaC
proposals are resolved with `infra_chat_confirm_change` / `infra_chat_reject_change`
(`messageId`). In-flight turn: `backend_code_chat_stop` / `infra_chat_stop` (cloud debug has no stop); queued follow-ups:
`<prefix>_list_queue` / `_steer_queued_message` / `_reorder_queue` / `_cancel_queued_message`.

Before development-repo work, read `get_project_conventions` and
`get_project_schema_inventory` and tell the agent to extend existing tables and
folders. After a development scope implement, check
`get_scope_schema_alignment_report({ releaseId, runId })`; after lock,
`get_release_lock_schema_alignment_report({ releaseId })`.

---

## 7. Frontend visual parity / correction loop

Build → Frontend only. Requires **active release + ≥1 revision**. Default **platform**.

### Cycle

1. Preflight
2. Zero revisions → seed `baseline_copy`
3. `start_preview` → poll ready
4. Authenticate with mock credentials if shown (never park purely on “loading Login”)
5. Navigate target routes; screenshot preview
6. Prod baseline side-by-side when reachable; else residual + continue
7. Diff → structured correction list
8. Ensure GitHub ready (`get_cursor_github_readiness` or rely on `migrate_frontend` preflight). On access failure: tell human to accept launchpad invite / fix Integrations — do **not** wait for a browser “Understood” dialog on the server.
9. `migrate_frontend` (same as UI Build Frontend App) / `start_scope_implement` `target: platform` with fix prompt — **stay in turn**
10. Poll to terminal (`get_cursor_agent` for migrate — treat `MIGRATE_PLATFORM_SYNC_FAILED` / FAILED / ERROR as terminal failure; versions / implement for scope); agent-not-found → alternate poll paths
11. Re-preview same pages; re-compare
12. Repeat until criteria met or residual + unblockable reason
13. Ship only if goal asks

### Resume after park

```
RESUME: projectId=<id> releaseId=<id> conversionId=<id?> agentId=<id?> step=poll_migrate next=list_versions
```

Next tick: poll first — do not re-seed or restart whole compare unless job confirmed dead.

---

## 8. Cloud deploy cycle

1. `get_deploy_map` / `prepare_deploy_map` / `patch_deploy_map` as needed
2. `backend_cloud_deploy_preflight`
3. `start_backend_cloud_deploy` → poll latest/run
4. Failures → preflight again or cloud_debug chat; do not invent AWS MCP tools
5. If deploy monitoring is on: `list_deploy_monitors` → `get_deploy_monitor` on the new run

---

## 9. CI/CD pipeline (optional)

1. `get_project_cicd` — if already `active`, skip to step 5
2. `enable_project_cicd` — adopts an existing pipeline, or returns `needsChoice` / `needsCreate`
3. `needsChoice` → `attach_project_cicd({ provider })`
4. `needsCreate` → **ask the user** → `create_project_cicd({ provider, branch? })` → poll `get_project_cicd` until `awaiting_deploy` / `pending_connection` / `active` / `error`
5. `sync_project_cicd_secrets({ environmentId })` (LaunchPad-created pipelines only)
6. `run_project_cicd` → poll `get_backend_cloud_deploy_run` with returned `runId`
7. Post-deploy: §11

---

## 10. Production errors via Sentry

1. `get_sentry_integration` — linked?
2. Not linked: `list_sentry_projects` → pick slugs with `linkedToOtherProject=false` → `set_sentry_integration({ sentryProjectSlugs: [...] })` (full list; omitted slugs unlink). Saving imports up to 50 unresolved issues per project.
3. Linked: `import_sentry_issues` (idempotent)
4. `list_feedback` → `SENTRY` items → §3 (AI fix). Auto-fix PRs never merge on their own.

---

## 11. Post-deploy health + PR security

1. `list_deploy_monitors` → verdict `healthy` | `regression` | `inconclusive`
2. `regression` → `get_deploy_monitor` → with user intent `spawn_deploy_regression_fix_agent({ runId, confirm: true })` → poll `get_cursor_agent`
3. PR review: `run_security_review({ repoFullName, prNumber })` → `list_security_review_findings({ prNumber })` → fix via Build or `dismiss_security_review_finding({ findingId, reason })`

---

## 12. Visual compare vs Figma (QA)

1. `get_qa_visual_testing_readiness` — Figma token ready?
2. `list_qa_visual_compare_runs` → `get_qa_visual_compare_run` (artifacts)
3. Failed run → `move_visual_run_to_feedback` (then §3) **or** `start_visual_fix_with_ai({ runId, repoPath, sourceBranch })` → poll `get_visual_run_fix_status`
4. Re-run compare (desktop app captures; MCP reads results)

---

## 13. Client Link share + build check

1. Preview ready (§B)
2. `run_client_link_verify` → poll `get_client_link_verify_status` (1–10 min) → `failed`: fix `failedCommand` in Build
3. Share: `share_client_link_preview` (24h keep-alive) or `create_preview_direct_link` (signed 30-day URL; ECS only — check `get_preview_status.directLinkAvailable`)
4. Stakeholder page itself: `get_client_link` (`{origin}/projects/{slug}`)

---

## Decision checklist

- [ ] One active release; others draft/locked/skip
- [ ] Empty active seeded with `mode: "baseline_copy"` before work (greenfield → first-revision tools)
- [ ] Build writes only on active
- [ ] Implement defaulted to `target: "platform"` unless user asked for development
- [ ] After any start tool, polled to terminal **in-turn** (or RESUME park)
- [ ] Agent-not-found recovered via versions / implement / preview status
- [ ] After platform lock, polled `get_release_lock_status`; after development implement, skip lock agent
- [ ] Next cycle seeded on **new** active id
- [ ] Continuous goals stay `in_progress` until evidence of full criteria
- [ ] QA failures rewind to Build before claiming ship
- [ ] Destructive calls use `confirm: true`
- [ ] Durable PHASE / NEXT_ACTION / RESUME lines on autonomous ticks
