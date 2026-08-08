# LaunchPad MCP pitfalls

## Required fields (common failures)

| Tool | Must send |
| ---- | --------- |
| `create_release` | `projectId`, `name`, **`startDate`**, **`releaseDate`** |
| `activate_release` | `projectId`, `releaseId`, **`reason`** |
| `update_release_status` | `releaseId`, `status`, **`reason`** |
| `update_release` | include **`reason`** with field changes |
| `seed_release_from_prior` | `projectId`, `releaseId`, **`mode`** (`baseline_copy` \| `agent`); `promptText` when `agent` |
| `set_release_scope` | `items` array (max 500) |
| `create_job` | `name`, `automationType`, `targets`, `scheduleType`, `scheduleTime`, `timezone` |
| `create_cursor_agent` | `projectId`, `releaseId`, `promptText`, and `sourceRepository` **or** `sourcePrUrl` |
| `cursor_agent_followup` | `promptText` |
| `start_scratch_agent` | `prompt` |
| `init_onboarding` | `method` (`zip`\|`scratch`\|`figma`\|`migrate`\|`feedback`); feedback also needs Jira fields |
| `start_onboarding_migrate` | `releaseId` |
| `enhance_prompt` | `prompt` |
| Backend / infra / cloud-debug `*_send_message` | **`prompt`** (not `message`) |
| `update_prd` | `document` object |
| `update_budget` | `budgetUsd` > 0 |
| `switch_version` | top-level `versionId` |
| `install_feedback_snippet` | `enabled` boolean |
| `start_feedback_ai_fix_batch` | `feedbackIds` — **string UUIDs**, min 2 |
| `lock_release` | `confirm: true` |
| PAT tools | named token fields |

## Continuous agent anti-patterns

| Mistake | Correct |
| ------- | ------- |
| End tick with “started implement; wait” | Poll in-tick **or** emit `RESUME:` + poll next tick first |
| Restart Discover every 2m goal tick | Resume from active release / `RESUME:` / incomplete phase |
| Mark `GOAL_STATUS: complete` after one lock mid multi-release goal | Complete only when full goal criteria evidenced |
| Skip Validate always | If goal mentions quality/QA/test, run Validate before ship |
| Never go back after QA fails | Rewind to Build; re-Validate |
| Implement on locked release | Work only on **new active** |
| Seed `mode: agent` without intent | Default `baseline_copy` |
| Park without durable ids | Always `RESUME: projectId=… releaseId=… step=… next=…` |
| Busy-loop 100ms polls | 5–30s intervals; backoff for long jobs |
| Infinite retry same failed call | Max **2** auto-retries; then residual or different tactic |
| Invent product facts in stories | Drop back to Discover sensors |
| Spend without budget check on large agents | Optional `get_budget` / cost tools when available |
| Choose `development` for “fix preview UI” | `platform` implement |

## Model router (Cursor agents)

- LaunchPad **always** chooses Cursor `--model` via model router.
- Do **not** pass `model` on `create_cursor_agent`.
- Admins: platform/project model router tools; modes `fixed` / `self_select` / `fixed_by_part`.

## IDs

- **Feedback** ids are **UUIDs**. Integers fail validation.
- **Release** / **project** ids are positive integers.
- Never invent ids — resolve via list/get.

## Confirm gates

Pass `confirm: true` for destructive tools, including:

`lock_release`, `delete_project`, `delete_feedback`, `cancel_*`, `revert_release_to_baseline`, disconnect integrations, delete jobs, `fail_stuck_dev_repo_git_ops`, etc.

## Polling (no SSE)

| Start | Poll |
| ----- | ---- |
| `lock_release` | Platform: `get_release_lock_status` (~30 min). Dev implement: `skipLockAgentOperations: true` |
| `start_scope_implement` | `get_scope_implement_*` + `list_versions` for **hours** |
| `start_feedback_ai_fix` | `get_feedback_ai_fix_status` |
| `spawn_dev_agent` / `create_cursor_agent` | `get_agent_status` / `get_cursor_agent` |
| `*_chat_send_message` | matching `*_get_session` |
| `start_backend_cloud_deploy` | deploy latest/run |
| `start_preview` | `get_preview_status` |
| `run_infra_analysis` | infra latest/result |
| `generate_understand_graph` | `get_understand_status` |
| QA generation | `get_qa_message` / `retry_qa_generation` |

Stop on terminal statuses (`completed`, `failed`, `cancelled`, `ERROR`, locked&&!agentActive, etc.).

## Goal-tick / long-job anti-patterns

| Mistake | Correct |
| ------- | ------- |
| Exit right after migrate/implement “started” | Poll to terminal; then next step |
| Wait for next /goal interval instead of polling | Interval is backstop; in-tick poll |
| Treat “Agent not found” as terminal | Alternate: versions / implement / preview |
| Park mid-job without RESUME | Always durable RESUME line |
| Restart seed/journey every tick | Resume prior release/revision |
| Claim ≥95% parity without screenshots | Side-by-side or residual + reason |
| Stop at preview “loading Login” | Mock creds / restart_preview / evidence |
| Backend Code for preview parity | Platform implement only unless asked |

## Release / revision mistakes

| Mistake | Correct |
| ------- | ------- |
| Activate without `reason` | Always pass reason |
| Implement on locked release | New active only |
| Preview with zero revisions | Seed baseline_copy first |
| Seed without `mode` | Always pass mode |
| Skip lock poll | Platform poll ~30 min |
| Default development target | Default **platform** |
| Lock after development implement with agent | `skipLockAgentOperations: true` |
| Stop implement poll after minutes | Hours OK for sequential queues |
| Second concurrent active | Prefer lock first |
| `switch_version` expecting live | Use `activate_version` |
| Confuse release `1.0.0` with revision | Revisions are R1, R2, … |

## Backend Code chat mistakes

| Mistake | Correct |
| ------- | ------- |
| Send with `message` | Use **`prompt`** |
| Fall back to `spawn_dev_agent` | Stay on backend_code_chat_* |
| Use `agent_followup` with chat agent id | Keep send_message |
| Assume archive blocks sends | send get-or-creates session |

## Project memory

| Mistake | Correct |
| ------- | ------- |
| Manually curating memory each turn | Self-updates; `refresh_project_memory` only to force |
| Expect memory always | Gated by `PROJECT_MEMORY_ENABLED` |
| Expect one sighting to stick | Preferences need ≥2 sightings |

## Hard exclusions (no MCP tools)

- AWS cloud-debug MCP (`aws_command`, `get_deploy_context`)
- Webhooks, OAuth callbacks, plugin key poll/complete
- Multipart ZIP/file uploads (use UI for ZIP revisions)
- SSE (`*/stream`, `*/agent-events`)
- Internal deploy secret routes
- Public stakeholder-email-only chat mutations

## Auth

- Prefer MCP API key (`lp_mcp_…`) or JWT Bearer
- Create keys: Integrations → LaunchPad MCP, or `create_mcp_api_key`
- 401/403 → stop; refresh token / new key
