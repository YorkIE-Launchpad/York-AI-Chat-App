# LaunchPad MCP pitfalls

## Required fields (common failures)

| Tool                                                                                                    | Must send                                                                                     |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `create_release`                                                                                        | `projectId`, `name`, **`startDate`**, **`releaseDate`** (`yyyy-MM-dd` or ISO; target ≥ start) |
| `activate_release`                                                                                      | `projectId`, `releaseId`, **`reason`** (audit why activating)                                 |
| `update_release_status`                                                                                 | `releaseId`, `status`, **`reason`** (required for draft/active/skip)                          |
| `update_release`                                                                                        | include **`reason`** with field changes                                                       |
| `seed_release_from_prior`                                                                               | `projectId`, `releaseId`, **`mode`** (`baseline_copy` \| `agent`); `promptText` when `agent`  |
| `set_release_scope`                                                                                     | `items` array (max 500) — not a free-form blob                                                |
| `create_job`                                                                                            | `name`, `automationType`, `targets`, `scheduleType`, `scheduleTime`, `timezone`               |
| `create_cursor_agent`                                                                                   | `projectId`, `releaseId`, `promptText`, and `sourceRepository` **or** `sourcePrUrl`           |
| `cursor_agent_followup`                                                                                 | `promptText`                                                                                  |
| `start_scratch_agent`                                                                                   | `prompt`                                                                                      |
| `init_onboarding`                                                                                       | `method` (`zip`\|`scratch`\|`figma`\|`migrate`\|`feedback`); feedback also needs Jira fields  |
| `start_onboarding_migrate`                                                                              | `releaseId`                                                                                   |
| `enhance_prompt`                                                                                        | `prompt`                                                                                      |
| `backend_code_chat_send_message` / `infra_analysis_chat_send_message` / `cloud_debug_chat_send_message` | **`prompt`** (not `message`); optional `mode`                                                 |
| `update_prd`                                                                                            | `document` object                                                                             |
| `update_budget`                                                                                         | `budgetUsd` > 0                                                                               |
| `switch_version`                                                                                        | top-level `versionId`                                                                         |
| `install_feedback_snippet`                                                                              | `enabled` boolean                                                                             |
| `start_feedback_ai_fix_batch`                                                                           | `feedbackIds` — **string UUIDs**, min 2                                                       |
| PAT tools                                                                                               | `githubToken` / `figmaToken` / `apiKey` as named fields                                       |

## Model router (Cursor agents)

- LaunchPad **always** chooses the Cursor `--model` via the **model router** (platform default or project override).
- Do **not** pass `model` on `create_cursor_agent` — it is ignored. Optional: `analyticsSource`, `routerPart` (`frontend`|`backend`|`cloud`).
- Admins configure modes with `get_platform_model_router` / `update_platform_model_router` and per-project `get_project_model_router` / `update_project_model_router` (`inherit: true` = platform default).
- Modes: `fixed` (one model including Auto), `self_select` (OpenAI picks from catalog), `fixed_by_part` (FE/BE/Cloud).
- On **Client Link / Backend Code / Cloud Debug**, `self_select` **re-runs** the OpenAI picker on every new user message. Same model → follow-up on the existing agent. Different model → prior agent is terminalized for Cost Analytics, then a **fresh** agent spawns with `preResolved` (no second OpenAI call). Non-`self_select` modes still only force fresh when router `updatedAt` is newer than the agent.
- Mid-chat model changes create **multiple agent ids** in one conversation: each run’s spend lands under its own `modelId` in Cost `byModel` / Agent Analytics. OpenAI picker tokens are **not** project Cursor spend.
- Agent Analytics run drawer shows spawn `model` plus the router **selection reason** (persisted on create in `ProjectAgentModelSelection`). Older runs may have the model without a reason.
- Cost Analytics / usage ledger attribute spend to the run’s spawn **`modelId`** (null/blank treated as Auto). Historical rows are not recomputed when the router changes.

## IDs

- **Feedback** ids are **UUIDs** (`feedbackIdSchema`). Integers fail MCP validation.
- **Release** / **project** ids are positive integers.
- Never invent ids — resolve via list/get tools.

## Confirm gates

Pass `confirm: true` for destructive tools, including:

- `lock_release`, `delete_project`, `delete_feedback`, `cancel_*`, `revert_release_to_baseline`, disconnect integrations, delete jobs, `fail_stuck_dev_repo_git_ops`, etc.

Omitting confirm returns a tool error before the API call.

## Polling (no SSE)

MCP excludes SSE streams. After start tools, poll:

| Start                                                              | Poll                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lock_release`                                                     | Platform: poll **`get_release_lock_status`** (~30 min; no SSE). Dev-repo implement: **`skipLockAgentOperations: true`** (immediate)                                                                                                                                                                                                            |
| `start_scope_implement`                                            | Default **`target: "platform"`**. Modes: **`execution: "sequential"`** (separate PR each); **`batch` + `sequential_agents_shared_pr`** (shared PR, different commits); **`parallel_agents_separate_prs`**; **`single_agent_shared_pr`** (combined prompt). Pass **`items[].sortOrder`**. Poll for **hours**. Use `development` only when asked |
| `start_feedback_ai_fix`                                            | `get_feedback_ai_fix_status`                                                                                                                                                                                                                                                                                                                   |
| `spawn_dev_agent` / `create_cursor_agent`                          | `get_agent_status` / `get_cursor_agent`                                                                                                                                                                                                                                                                                                        |
| `backend_code_chat_send_message` (and other `*_chat_send_message`) | `*_chat_get_session` (no SSE)                                                                                                                                                                                                                                                                                                                  |
| `start_backend_cloud_deploy`                                       | `get_backend_cloud_deploy_latest` / `get_backend_cloud_deploy_run`                                                                                                                                                                                                                                                                             |
| `start_preview`                                                    | `get_preview_status`                                                                                                                                                                                                                                                                                                                           |
| `run_infra_analysis`                                               | `get_infra_analysis_latest` / `get_infra_analysis_result`                                                                                                                                                                                                                                                                                      |
| QA message generation                                              | `get_qa_message` / `retry_qa_generation`                                                                                                                                                                                                                                                                                                       |

Reasonable poll interval: a few seconds to tens of seconds for long jobs; do not busy-loop. Scope implement and lock can run for **minutes to hours** — keep polling. Stop on terminal statuses (`completed`, `failed`, `cancelled`, `ERROR`, etc.).

## Release / revision mistakes

| Mistake                                             | Correct behavior                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Activate without `reason`                           | Always pass **`reason`** on `activate_release` / `update_release_status`                                               |
| Implement on locked release                         | Use the **new active** patch; locked cannot get revisions                                                              |
| Promise preview with zero revisions                 | `seed_release_from_prior` with **`mode: "baseline_copy"`** (last tag)                                                  |
| Seed without `mode`                                 | Always pass `mode`; backend rejects otherwise                                                                          |
| After lock, skip waiting / stop after a few polls   | Platform: poll **`get_release_lock_status`** (~30 min). Dev implement: use **`skipLockAgentOperations: true`** instead |
| Implement on development without being asked        | Default **`target: "platform"`** (LaunchPad frontend/preview)                                                          |
| Lock after development implement with backend agent | Pass **`skipLockAgentOperations: true`**                                                                               |
| Stop implement poll after a few minutes             | Sequential queues can take **hours** (`done/total`); keep polling                                                      |
| Activate a second line while one is active          | Prefer **lock** then use auto next active; keep others draft                                                           |
| Use `switch_version` expecting live deploy          | Use `activate_version` for live; switch is temporary preview                                                           |
| Treat release name (`1.0.0`) as revision            | Revisions are `R1`, `R2`, …                                                                                            |

## Backend Code chat mistakes

| Mistake                                          | Correct behavior                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Send with `message`                              | Use **`prompt`** — backend rejects otherwise                                            |
| Fall back to `spawn_dev_agent` when chat fails   | Fix args / retry `backend_code_chat_send_message`; that surface owns create + follow-up |
| Use `agent_followup` with a chat Cursor agent id | Keep sending via `backend_code_chat_send_message`                                       |
| Assume archive blocks sends                      | `send_message` get-or-creates a session; poll `get_session` after                       |

## Project memory

| Mistake                                | Correct behavior                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Manually curating memory each turn     | It self-updates: preferences per prompt, knowledge nightly. Only call `refresh_project_memory` to force it           |
| Expecting memory when disabled         | Gated by `PROJECT_MEMORY_ENABLED` (default off). `get_project_memory` returns empty lenses until enabled + distilled |
| Expecting a new preference immediately | Preferences need ≥2 sightings before they inject; a single stray comment is ignored                                  |

## Hard exclusions (no MCP tools)

- AWS cloud-debug MCP (`aws_command`, `get_deploy_context`)
- Webhooks, OAuth callbacks, plugin key poll/complete
- Multipart ZIP/file uploads (use UI for ZIP revisions)
- SSE (`*/stream`, `*/agent-events`)
- Internal deploy secret routes
- Public stakeholder-email-only chat mutations

## Auth

- Prefer MCP API key (`lp_mcp_…`) or JWT as `Authorization: Bearer …`
- Create keys in app: **Integrations → LaunchPad MCP**, or `create_mcp_api_key`
- 401/403 → stop; user must refresh token or create a new MCP key
