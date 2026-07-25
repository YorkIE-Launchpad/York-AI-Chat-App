# MCP tool map by phase

Compact catalog. Prefer tools listed here; see MCP schemas for required args.

## Orient

| Tool                                              | Use                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `get_me`                                          | Auth / profile                                                                |
| `list_projects` / `list_project_names`            | Resolve project                                                               |
| `get_project`                                     | Project detail                                                                |
| `list_releases` / `get_release`                   | Release line + status                                                         |
| `get_release_lock_status`                         | Poll after lock (no SSE; up to ~30 min)                                       |
| `list_versions`                                   | Revisions (R1…)                                                               |
| `get_integrations_status` / `get_cursor_status`   | Readiness                                                                     |
| `get_project_memory`                              | Learned preferences/corrections + distilled delivery/conventions/architecture |
| `search_project_rag`                              | Semantic search over project RAG (captures, backlog, releases, deploys…)      |
| `ask_project_assistant`                           | Project-wide RAG Q&A (optional discovery mutations); persists chat history    |
| `list_project_chat_messages`                      | Project Chat history for the authenticated user                               |
| `get_project_rag_status` / `backfill_project_rag` | RAG index status / queue full reindex                                         |

## Discover

| Tool                                                                                   | Use                     |
| -------------------------------------------------------------------------------------- | ----------------------- |
| `get_client_details` / `patch_client_details`                                          | Client profile          |
| `scrape_client_website` / `enrich_client_details`                                      | Research                |
| `add_discovery_note`                                                                   | Notes                   |
| `generate_discovery_summary` / `patch_discovery_summary`                               | Summary                 |
| `discovery_chat`                                                                       | Discovery agent chat    |
| `list_workspace_documents` / `create_workspace_document` / `update_workspace_document` | Docs                    |
| `generate_workspace_document` / `workspace_document_chat`                              | Doc AI                  |
| `patch_discovery_stakeholders` / ingest\_\*                                            | Stakeholders / meetings |
| `generate_prd` / `get_prd` / `update_prd` / `prd_chat`                                 | PRD                     |
| `sync_prd_from_discovery` / `list_prd_revisions`                                       | PRD sync / history      |

## Plan

| Tool                                                   | Use                                             |
| ------------------------------------------------------ | ----------------------------------------------- |
| `list_epics` / `create_epic` / `update_epic`           | Epics                                           |
| `create_story` / `update_story`                        | Stories                                         |
| `get_backlog_suggestions` / `apply_backlog_suggestion` | Suggestions                                     |
| `create_release`                                       | New line (`startDate` + `releaseDate` required) |
| `update_release` / `update_release_status`             | Metadata / status — both need **`reason`**      |
| `activate_release`                                     | Make release active — requires **`reason`**     |
| `get_release_scope` / `set_release_scope`              | Scope items                                     |
| `get_release_feature_suggestions`                      | Release suggestions                             |

## Build

| Tool                                                                                              | Use                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start_scope_implement` / `get_scope_implement_active` / `get_scope_implement_run`                | Modes: sequential (separate PRs), batch+`sequential_agents_shared_pr`, batch+`parallel_agents_separate_prs`, batch+`single_agent_shared_pr`; honor `items[].sortOrder`; poll for hours |
| `cancel_scope_implement`                                                                          | Cancel (confirm)                                                                                                                                                                       |
| `seed_release_from_prior`                                                                         | Empty active → last tag (`mode: baseline_copy`) or `agent` + `promptText`                                                                                                              |
| `revert_release_to_baseline`                                                                      | Revert (confirm)                                                                                                                                                                       |
| `migrate_frontend`                                                                                | Dev → platform migrate                                                                                                                                                                 |
| `spawn_dev_agent` / `agent_followup` / `get_agent_status`                                         | Project dev agents (generic; **not** Backend Code tab)                                                                                                                                 |
| `create_cursor_agent` / `cursor_agent_followup` / `get_cursor_agent`                              | Cursor cloud agents                                                                                                                                                                    |
| `start_scratch_agent` / `stop_scratch_agent`                                                      | Scratch                                                                                                                                                                                |
| `list_versions` / `activate_version` / `switch_version`                                           | Revisions                                                                                                                                                                              |
| `start_preview` / `get_preview_status` / `restart_preview` / `stop_preview`                       | Preview                                                                                                                                                                                |
| `get_deploy_map` / `patch_deploy_map` / `prepare_deploy_map`                                      | Deploy map                                                                                                                                                                             |
| `run_environment_scan`                                                                            | Env scan                                                                                                                                                                               |
| `start_backend_cloud_deploy` / `get_backend_cloud_deploy_latest` / `get_backend_cloud_deploy_run` | Cloud deploy poll                                                                                                                                                                      |
| `run_infra_analysis` / `get_infra_analysis_latest`                                                | Infra                                                                                                                                                                                  |
| `backend_code_chat_get_session` / `backend_code_chat_send_message` / stop / archive               | Backend Code tab: create + follow-up via **`prompt`**; poll session                                                                                                                    |
| `infra_analysis_chat_*` / `cloud_debug_chat_*`                                                    | Infra / cloud-debug chat (same `prompt` on send)                                                                                                                                       |
| `refresh_project_memory`                                                                          | Force project-memory distillation now (both cadences); normally automatic                                                                                                              |

## Validate

| Tool                                                               | Use                            |
| ------------------------------------------------------------------ | ------------------------------ |
| `get_qa_config` / `update_qa_config` / `resolve_qa_config`         | QA setup                       |
| `list_qa_topics` / `create_qa_topic`                               | Topics                         |
| `create_qa_chat` / `send_qa_chat_message` / `get_qa_message`       | QA agent                       |
| `list_qa_reports` / `get_qa_report` / `move_qa_report_to_feedback` | Reports                        |
| `list_feedback` / `get_feedback` / `update_feedback`               | Feedback (UUID ids)            |
| `start_feedback_ai_fix` / `get_feedback_ai_fix_status`             | AI fix + poll                  |
| `start_feedback_ai_fix_batch` / `cancel_feedback_ai_fix`           | Batch / cancel                 |
| `approve_feedback`                                                 | Approve → Jira when configured |
| `list_preview_comments` / `create_preview_comment`                 | Preview comments               |

## Ship / lifecycle

| Tool                        | Use                                                                    |
| --------------------------- | ---------------------------------------------------------------------- |
| `lock_release`              | Lock active (confirm). Dev implement → `skipLockAgentOperations: true` |
| `get_release_lock_status`   | Poll when backend agent used (up to ~30 min); skip if already skipped  |
| `seed_release_from_prior`   | Seed next active empty from last tag                                   |
| `get_release_changelog`     | Audit                                                                  |
| `regenerate_review_summary` | Client review summary                                                  |

## Client link (read)

| Tool                                                                                    | Use                                     |
| --------------------------------------------------------------------------------------- | --------------------------------------- |
| `get_public_project` / `ensure_public_preview` / `get_public_preview_status`            | Public preview                          |
| `get_client_link_messages` / `get_client_link_agent_status` / `get_client_link_summary` | Status (no stakeholder-email mutations) |

## Auth / MCP keys

| Tool                                                              | Use                    |
| ----------------------------------------------------------------- | ---------------------- |
| `create_mcp_api_key` / `list_mcp_api_keys` / `revoke_mcp_api_key` | MCP keys               |
| `update_journey_tour`                                             | Tour completed/skipped |

## Admin (model router)

| Tool                                                         | Use                                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `get_platform_model_router` / `update_platform_model_router` | Platform Cursor model policy                                               |
| `get_project_model_router` / `update_project_model_router`   | Per-project override (`inherit: true` = platform)                          |
| `fail_stuck_dev_repo_git_ops`                                | Admin: clear stuck active/queued git locks for a project (`confirm: true`) |

Cursor agent `model` is always server-resolved; do not pass `model` on `create_cursor_agent`.
