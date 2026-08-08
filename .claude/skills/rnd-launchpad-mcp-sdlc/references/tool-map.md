# MCP tool map by phase

Compact catalog. Prefer these tools; honor MCP schemas for required args.

For **which tool when** in the continuous agent, see [continuous-loop.md](continuous-loop.md).

## Orient / sensors (every tick)

| Tool | Use |
| ---- | --- |
| `get_me` | Auth / profile |
| `list_projects` / `list_project_names` | Resolve project |
| `get_project` | Project detail / repo linkage |
| `list_releases` / `get_release` | Release line + status |
| `get_release_lock_status` | Poll after lock (no SSE; up to ~30 min) |
| `list_versions` / `get_live_url` | Revisions R1… / live URL |
| `get_integrations_status` / `get_cursor_status` / `get_cursor_github_readiness` | Readiness |
| `get_project_memory` | Preferences / delivery conventions |
| `search_project_rag` / `ask_project_assistant` | Project Q&A |
| `list_project_chat_messages` | Project chat history |
| `get_project_rag_status` / `backfill_project_rag` | RAG index |
| `get_budget` / `get_project_cost` / `get_project_daily_spend` | Spend guardrails |

## Discover

| Tool | Use |
| ---- | --- |
| `get_client_details` / `patch_client_details` | Client profile |
| `scrape_client_website` / `enrich_client_details` / `add_competitor_from_website` / `refresh_competitors` | Research |
| `add_discovery_note` | Notes |
| `generate_discovery_summary` / `patch_discovery_summary` | Summary |
| `generate_discovery_questions` / `patch_discovery_questions` / `publish_discovery_questionnaire` / `unpublish_discovery_questionnaire` | Questionnaire |
| `capture_questionnaire_responses` / `generate_questionnaire_summary` | Responses |
| `discovery_chat` / `get_discovery_thread_status` | Discovery agent chat |
| `list_workspace_documents` / `create_workspace_document` / `update_workspace_document` / `delete_workspace_document` | Docs |
| `generate_workspace_document` / `regenerate_workspace_document` / `workspace_document_chat` | Doc AI |
| `export_workspace_document` / `list_workspace_document_revisions` / `restore_workspace_document_revision` | History |
| `workspace_document_jira_create` / `workspace_document_jira_link` | Doc → Jira |
| `patch_discovery_stakeholders` / `patch_engagement_phase` | Stakeholders / phase |
| `ingest_confluence_page` / `ingest_granola_note` / `ingest_hub_meetings` / `list_granola_notes` / `list_confluence_spaces` | Ingest |
| `generate_prd` / `get_prd` / `update_prd` / `prd_chat` / `regenerate_prd` | PRD |
| `sync_prd_from_discovery` / `list_prd_revisions` / `restore_prd_revision` | PRD sync |
| `generate_kickoff_presentation` / `get_kickoff_presentation` / `list_kickoff_presentations` / `export_kickoff_presentation` | Kickoff |
| `generate_persona_insights` / `refresh_persona_smart_fields` | Personas |
| `resolve_capture_context` | Capture context |

## Plan

| Tool | Use |
| ---- | --- |
| `list_epics` / `create_epic` / `update_epic` / `delete_epic` | Epics |
| `create_story` / `update_story` / `delete_story` | Stories |
| `epic_story_chat` | Backlog AI assist |
| `get_backlog_suggestions` / `apply_backlog_suggestion` | Suggestions from discovery |
| `bulk_create_jira_issues` / `get_jira_tickets` / `get_jira_ticket_context` / `list_jira_projects` / `suggest_jira_from_figma` | Jira |
| `create_release` | New line (`startDate` + `releaseDate` required) |
| `update_release` / `update_release_status` | Metadata / status — both need **`reason`** |
| `activate_release` | Make release active — requires **`reason`** |
| `get_release_scope` / `set_release_scope` | Scope items |
| `get_release_feature_suggestions` / `release_suggestion_repo_scan` | Feature ideas |
| `get_release_changelog` / `regenerate_review_summary` | Audit / review |

## Build — implement / seed / migrate

| Tool | Use |
| ---- | --- |
| `start_scope_implement` | Prefer `execution: sequential`, `target: platform`, `items[].sortOrder` |
| `get_scope_implement_active` / `get_scope_implement_run` | Poll implement |
| `clarify_scope_implement` | Unblock implement |
| `cancel_scope_implement` | Cancel (`confirm`) |
| `seed_release_from_prior` | Empty active → last tag (`mode: baseline_copy` \| `agent` + `promptText`) |
| `revert_release_to_baseline` | Revert (`confirm`) |
| `migrate_frontend` / `start_migrate_frontend_agent` | Dev → platform / migrate agents |
| `list_versions` / `activate_version` / `switch_version` | Revisions |

## Build — agents (generic / Cursor)

| Tool | Use |
| ---- | --- |
| `spawn_dev_agent` / `agent_followup` / `get_agent_status` / `stop_agent` | Project dev agents — **not** Backend Code tab |
| `create_cursor_agent` / `cursor_agent_followup` / `get_cursor_agent` | Cursor cloud agents |
| `stop_cursor_agent` / `stop_and_revert_cursor_agent` / `merge_cursor_agent_to_launchpad` | Cursor lifecycle |
| `start_scratch_agent` / `stop_scratch_agent` | Scratch |

## Build — preview

| Tool | Use |
| ---- | --- |
| `start_preview` / `get_preview_status` / `restart_preview` / `stop_preview` | Preview |
| `export_launchpad_zip` | Export platform zip |

## Build — backend code / architecture / infra

| Tool | Use |
| ---- | --- |
| `backend_code_chat_get_session` / `backend_code_chat_send_message` | Backend Code — field **`prompt`** |
| `backend_code_chat_build_plan` / `backend_code_chat_clear_pending_plan` | Plan controls |
| `generate_understand_graph` / `sync_understand_graph` / `get_understand_status` / `get_understand_graph` | Architecture graph |
| `get_understand_diff_overlay` / `get_understand_file_content` / `get_domain_graph` | Graph reads |
| `run_infra_analysis` / `get_infra_analysis_latest` / `get_infra_analysis_result` | Infra analysis pipeline |
| `infra_analysis_chat_*` (session / send `prompt` / queue / archive as exposed) | Infra chat |
| `get_dev_repo_tree` / `get_dev_repo_file` / `get_dev_repo_commits` / `get_dev_repo_changed_files` | Dev repo browse |
| `fail_stuck_dev_repo_git_ops` | Admin stuck git locks (`confirm`) |

## Build — cloud / env / deploy

| Tool | Use |
| ---- | --- |
| `get_deploy_map` / `patch_deploy_map` / `prepare_deploy_map` / `export_deploy_map` | Deploy map |
| `run_environment_scan` | Env scan |
| `backend_cloud_deploy_preflight` | Preflight |
| `start_backend_cloud_deploy` / `get_backend_cloud_deploy_latest` / `get_backend_cloud_deploy_run` | Cloud deploy poll |
| `cancel_backend_cloud_deploy` | Cancel |
| `cloud_debug_chat_readiness` / `cloud_debug_chat_*` | Cloud debug chat (`prompt` on send) |
| `get_platform_deploy_mode` / `prepare_platform_deploy_mode` / `resume_platform_deploy_mode` / `cancel_platform_deploy_mode` | Platform deploy mode |
| `list_app_deployments` | Deployments list |

## Validate

| Tool | Use |
| ---- | --- |
| `get_qa_config` / `update_qa_config` / `resolve_qa_config` / `get_qa_context` / `get_qa_auth_hints` | QA setup |
| `list_qa_projects` / `list_qa_topics` / `create_qa_topic` / `update_qa_topic` | Topics |
| `list_qa_chats` / `create_qa_chat` / `get_qa_chat` / `update_qa_chat` / `delete_qa_chat` | Chats |
| `send_qa_chat_message` / `get_qa_message` / `retry_qa_generation` | QA agent |
| `list_qa_reports` / `get_qa_report` / `move_qa_report_to_feedback` | Reports |
| `list_feedback` / `list_all_feedback` / `get_feedback` / `update_feedback` / `delete_feedback` | Feedback (**UUID** ids) |
| `start_feedback_ai_fix` / `get_feedback_ai_fix_status` / `clarify_feedback_ai_fix` | AI fix + poll |
| `start_feedback_ai_fix_batch` / `cancel_feedback_ai_fix` | Batch / cancel |
| `approve_feedback` | Approve → Jira when configured |
| `list_feedback_jira_labels` / `list_feedback_jira_priorities` | Jira meta |
| `list_preview_comments` / `create_preview_comment` / `update_preview_comment` / `delete_preview_comment` / `reply_preview_comment` | Preview comments |
| `install_feedback_snippet` | Snippet |

## Ship / release lifecycle

| Tool | Use |
| ---- | --- |
| `lock_release` | Lock active (`confirm`). Dev implement → `skipLockAgentOperations: true` |
| `get_release_lock_status` | Poll when backend agent used |
| `seed_release_from_prior` | Seed next empty active from last tag |
| `get_release_changelog` | Audit |

## Onboarding / project create

| Tool | Use |
| ---- | --- |
| `init_onboarding` / `start_onboarding_migrate` / `enhance_prompt` | Onboard methods |
| `check_slug_availability` / `create_project` paths via project tools | Create |
| `update_journey_tour` | Tour completed/skipped |

## Client link (read)

| Tool | Use |
| ---- | --- |
| `get_public_project` / `ensure_public_preview` / `get_public_preview_status` / `get_public_preview_logs` / `stop_public_preview` | Public preview |
| `get_client_link_messages` / `get_client_link_agent_status` / `get_client_link_summary` / `refresh_client_link_build` | Status |
| `resend_stakeholder_link` | Resend (when allowed) |

## Jobs / automations

| Tool | Use |
| ---- | --- |
| `list_jobs` / `list_project_jobs` / `get_job` / `create_job` / `update_job` / `delete_job` / `run_job` | Jobs |
| `list_job_runs` / `delete_job_run` | Runs |
| `get_automation_documents` / `get_automation_repos` | Automation meta |
| `validate_job_project_branch` | Branch validation |

## Cursor rules / skills / prompts / models

| Tool | Use |
| ---- | --- |
| Catalog/import/create rule & skill tools (`list_project_cursor_*`, `import_project_cursor_*`, custom CRUD) | Rules/skills |
| Managed prompt tools (`get/create/update/enhance` platform & project) | Prompts |
| `get_prompt_config` / `update_prompt_config` / option lists | Prompt config |
| `get_platform_model_router` / `update_platform_model_router` / `get_project_model_router` / `update_project_model_router` | Model router |
| `list_agent_analytics_runs` / `get_agent_analytics_run` / `list_cost_analytics` | Analytics |

## Auth / MCP keys

| Tool | Use |
| ---- | --- |
| `create_mcp_api_key` / `list_mcp_api_keys` / `revoke_mcp_api_key` | MCP keys |

## Monitor matrix (start → poll)

| Start | Poll | On success next |
| ----- | ---- | --------------- |
| `seed_release_from_prior` | `list_versions` | implement / preview |
| `start_scope_implement` | `get_scope_implement_active`, `get_scope_implement_run`, `list_versions` | `start_preview` |
| `migrate_frontend` / migrate agent | versions + agent status | re-preview / compare |
| `start_preview` / `restart_preview` | `get_preview_status` | QA / fidelity / approve |
| `lock_release` | `get_release_lock_status` | `list_releases` → seed |
| `start_feedback_ai_fix` | `get_feedback_ai_fix_status` | `approve_feedback` / preview |
| `send_qa_chat_message` | `get_qa_message`, `retry_qa_generation` | reports → feedback |
| `create_cursor_agent` / `spawn_dev_agent` | `get_cursor_agent` / `get_agent_status` | merge / preview if FE |
| `backend_code_chat_send_message` | `backend_code_chat_get_session` | verify / understand |
| `start_backend_cloud_deploy` | `get_backend_cloud_deploy_*` | smoke / next |
| `run_infra_analysis` | `get_infra_analysis_latest` | diagram / suggestions |
| `generate_understand_graph` | `get_understand_status` | architecture review |

Cursor agent `model` is always server-resolved; do not pass `model` on `create_cursor_agent`.
