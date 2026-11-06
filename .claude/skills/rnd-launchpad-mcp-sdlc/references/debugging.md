# Debugging (GrowthOS / LaunchPad MCP)

Work **only through LaunchPad MCP**. Prefer evidence (status, logs, snapshots,
Sentry, monitors) over guessing. Standalone GrowthOS skill: `rnd-launchpad-mcp-debug`.
Cloud debug = **live app debug** (can read AWS logs). After a fix: Validate → Ship; Deploy only if environments exist.

---

## Triage first (pick one lane)

| Symptom                                                                       | Lane               | First tools                                                                          |
| ----------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------ |
| Preview blank / won’t boot / wrong port / login loop                          | **Preview**        | `get_preview_status` → manifest/env → restart → snapshot                             |
| Client Link / stakeholder page broken                                         | **Client Link**    | `get_client_link` → `get_public_preview_status` / `_logs` → `run_client_link_verify` |
| UI bug / visual / “fix this” from GrowthOS                                    | **Feedback / FE**  | `create_feedback` (new UUID) → `start_feedback_ai_fix` → preview snapshot            |
| App logic / API / DB in **development repo**                                  | **Backend Code**   | conventions + schema → `backend_code_chat_*` (`prompt`)                              |
| Live app / prod-like env broken; need AWS logs (project **has environments**) | **Cloud debug**    | `cloud_debug_chat_readiness` → `cloud_debug_chat_*` (agent reads AWS logs)           |
| IaC / infra analysis proposals                                                | **Infra chat**     | `infra_chat_*` → confirm/reject change                                               |
| Production exceptions already in Sentry                                       | **Sentry**         | `get_sentry_integration` → import → AI fix                                           |
| Post-deploy unhealthy                                                         | **Deploy monitor** | `list_deploy_monitors` → `get_deploy_monitor` (regression fix agent needs confirm)   |
| PR security findings                                                          | **Security**       | `run_security_review` → list findings → fix or dismiss                               |
| QA failures                                                                   | **QA**             | website `qa_chat_*` (see `rnd-launchpad-mcp-sdlc` / `qa-chat.md`)                    |

**Env gate:** cloud debug / deploy / CI only when `get_deploy_map` has environments.
No envs → do not ask to deploy; stay on preview / platform / backend chat.

---

## Golden rules

- Send field for Backend / infra / cloud-debug chats is **`prompt`**, not `message`.
- Prefixes: `backend_code_chat_*`, **`infra_chat_*`** (not `infra_analysis_chat_*`), `cloud_debug_chat_*`.
- **New** GrowthOS fix ask → `create_feedback` → AI fix. Never `update_feedback` an unrelated old UUID.
- After UI fix: preview ready → `get_preview_snapshot` → images in the reply.
- Poll chats/jobs **in-turn**; park only with durable `RESUME:`.
- Live AWS logs / runtime: use **cloud debug chat** (not raw `aws_command` / `get_deploy_context`).
- Max **2** auto-retries per tactic, then residual + different lane or ask.

---

## 1. Preview / frontend runtime

```
get_preview_status
→ stopped/failed? start_preview | restart_preview → POLL until ready
→ still bad? get_preview_manifest → update_preview_manifest / update_preview_env
→ last resort: redetect_preview_manifest(confirm=true)
→ get_preview_snapshot(route) — report consoleErrors as issues
→ UI bug → create_feedback → start_feedback_ai_fix → POLL → re-snapshot
```

| Mistake                                | Correct                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| Snapshot while `STARTING`              | Poll status first (409 `PREVIEW_NOT_RUNNING` → start)                                |
| Backend Code for “preview looks wrong” | Platform feedback AI fix / `start_scope_implement` `target: platform`                |
| Hand out host:port to client           | `share_client_link_preview` / `create_preview_direct_link` (ECS) / `get_client_link` |

---

## 2. Client Link / public preview

```
get_client_link
→ get_public_preview_status / get_public_preview_logs
→ run_client_link_verify → POLL get_client_link_verify_status
→ failed: read failedCommand + log tail → fix in Build → re-verify
```

---

## 3. Feedback / AI fix (GrowthOS “fix this”)

**New ask (default):**

```
create_feedback({ projectId, description })   # NEW UUID every time
→ start_feedback_ai_fix({ projectId, feedbackId })
→ POLL get_feedback_ai_fix_status
→ AWAITING_QUESTIONS → clarify_feedback_ai_fix
→ preview → get_preview_snapshot → Validate if needed
```

**Retry same filed bug:** optional `update_feedback` (repro only) → `start_feedback_ai_fix` on **same** UUID.

**From QA / visual / Sentry:** `move_qa_report_to_feedback` / `move_visual_run_to_feedback` / `import_sentry_issues` (idempotent) → AI fix.

---

## 4. Backend Code chat (development repo)

Use only when the bug is clearly **backend / development repo** (or user names Backend Code).

```
get_project_conventions / get_project_schema_inventory
→ backend_code_chat_get_session
→ backend_code_chat_send_message({ prompt, mode: "agent" })
→ POLL backend_code_chat_get_session until assistant terminal
→ optional: generate_understand_graph / get_scope_schema_alignment_report
```

Do **not** use `spawn_dev_agent` as a Backend Code workaround. In-flight: `backend_code_chat_stop` or queue tools (`_list_queue`, `_steer_queued_message`, …).

---

## 5. Cloud debug chat (live app debug + AWS logs)

**What it is:** debug the **live / deployed app** for a project environment.
The cloud-debug agent can **read AWS logs** (CloudWatch and related) and
inspect runtime — use it for “prod is down”, 5xx, timeouts, env-specific
failures. Not for preview-only UI polish (use preview / feedback AI fix).

**Only when project has environments** (or user explicitly asks cloud debug).

```
get_deploy_map                    # no envs → skip this lane (DEPLOY/cloud N/A)
→ cloud_debug_chat_readiness
→ cloud_debug_chat_get_session
→ cloud_debug_chat_send_message({
    prompt: "Investigate live <env>: <symptom>. Read recent AWS/app logs and report root cause."
  })
→ POLL cloud_debug_chat_get_session until assistant terminal
→ then fix via Backend Code / feedback / redeploy as indicated
```

- No `cloud_debug_chat_stop` — use queue tools or wait for terminal.
- Never call excluded raw AWS MCP tools (`aws_command`, `get_deploy_context`) — the chat agent already has log access.

---

## 6. Infra chat

```
infra_chat_get_session
→ infra_chat_send_message({ prompt })
→ POLL infra_chat_get_session
→ proposed IaC → infra_chat_confirm_change | infra_chat_reject_change (messageId)
```

Optional pipeline: `run_infra_analysis` → poll `get_infra_analysis_latest`.

---

## 7. Sentry production errors

```
get_sentry_integration
→ not linked: list_sentry_projects → set_sentry_integration({ sentryProjectSlugs })
→ linked: import_sentry_issues
→ list_feedback (feedbackSource=SENTRY) → start_feedback_ai_fix
```

Auto-fix PRs never merge themselves.

---

## 8. Deploy monitor regression

Only after a real deploy (envs exist):

```
list_deploy_monitors → get_deploy_monitor
→ healthy: done
→ regression: with user intent spawn_deploy_regression_fix_agent({ runId, confirm: true })
→ POLL get_cursor_agent
```

---

## 9. PR security findings

```
run_security_review({ repoFullName, prNumber })
→ list_security_review_findings
→ fix via Backend/platform lane OR dismiss_security_review_finding({ findingId, reason })
```

---

## Monitor matrix

| Start                               | Poll                            | Next                                               |
| ----------------------------------- | ------------------------------- | -------------------------------------------------- |
| `start_preview` / `restart_preview` | `get_preview_status`            | snapshot / fix manifest                            |
| `create_feedback`                   | (sync)                          | `start_feedback_ai_fix`                            |
| `start_feedback_ai_fix`             | `get_feedback_ai_fix_status`    | snapshot → re-Validate                             |
| `backend_code_chat_send_message`    | `backend_code_chat_get_session` | verify / understand                                |
| `cloud_debug_chat_send_message`     | `cloud_debug_chat_get_session`  | live-app root cause from AWS logs → fix / redeploy |
| `infra_chat_send_message`           | `infra_chat_get_session`        | confirm/reject                                     |
| `run_client_link_verify`            | `get_client_link_verify_status` | Build fix                                          |
| `run_infra_analysis`                | `get_infra_analysis_latest`     | infra chat                                         |
| `spawn_deploy_regression_fix_agent` | `get_cursor_agent`              | re-check monitors                                  |

---

## After the fix (complete the loop)

1. Evidence: snapshot / monitor / Sentry quiet / chat terminal success.
2. Re-Validate when UI/QA involved (`qa_chat_*`).
3. Ship when the cycle is ready.
4. Deploy **only if** `get_deploy_map` has environments — else `DEPLOY: n/a`.
