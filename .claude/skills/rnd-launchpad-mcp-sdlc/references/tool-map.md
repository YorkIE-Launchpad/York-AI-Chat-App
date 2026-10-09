# MCP tool map by phase

Compact catalog synced to the LaunchPad MCP server (`mcp-server/src/tools/*`).
Prefer these tools; honor MCP schemas for required args.

For **which tool when** in the continuous agent, see [continuous-loop.md](continuous-loop.md).

## Tool profiles

The server may expose a subset via `MCP_TOOL_PROFILE` (default `full`). If a tool
listed here is missing from the client, the host is on a narrower profile — do
not invent a REST fallback; report the gap.

| Profile  | Domains                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `full`   | Everything below                                                                                                               |
| `core`   | auth, MCP keys, projects, onboarding, integrations, releases, agents, comments, cursor rules, security review, deploy monitors |
| `qa`     | auth, MCP keys, projects, QA, agents, comments                                                                                 |
| `deploy` | auth, MCP keys, projects, releases, deploy env, CI/CD, infra, agents, deploy monitors, cloud debug chat                        |

## Orient / sensors (every tick)

| Tool                                                                                                          | Use                                                                                           |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `get_me` / `update_me`                                                                                        | Auth / profile                                                                                |
| `list_projects` / `list_project_names`                                                                        | Resolve project (`list_projects` includes `clientLinkUrl`)                                    |
| `get_project` / `get_project_settings`                                                                        | Full detail / compact settings (repos, integrations, stakeholders, settings access)           |
| `update_project`                                                                                              | Patch name/description/status/stakeholders/settings access (owner/admin/settings-access only) |
| `list_releases` / `get_release`                                                                               | Release line + status                                                                         |
| `get_release_lock_status`                                                                                     | Poll after lock (no SSE; up to ~30 min)                                                       |
| `list_versions` / `get_live_url`                                                                              | Revisions R1… / live URL                                                                      |
| `get_integrations_status` / `get_cursor_status` / `get_cursor_github_readiness` / `get_figma_agent_readiness` | Readiness                                                                                     |
| `get_project_memory`                                                                                          | Preferences, knowledge lenses, `knowledgeRefresh` (status/cost/lastUpdatedAt)                 |
| `update_project_memory_settings`                                                                              | Toggle `knowledgeEnabled` (needs development repo)                                            |
| `get_project_memory_skill`                                                                                    | Rendered `SKILL.md` bodies (`skill=preferences\|knowledge\|both`)                             |
| `refresh_project_memory`                                                                                      | Sync preferences + enqueue knowledge agent; poll `get_project_memory` while queued/running    |
| `search_project_rag` / `ask_project_assistant`                                                                | Project Q&A                                                                                   |
| `list_project_chat_messages`                                                                                  | Project chat history                                                                          |
| `get_project_rag_status` / `backfill_project_rag`                                                             | RAG index                                                                                     |
| `get_budget` / `update_budget` / `get_project_cost` / `get_project_daily_spend`                               | Spend guardrails                                                                              |

## Development repo conventions / schema (before development work)

| Tool                                                              | Use                                                                                                            |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `get_project_conventions`                                         | Read `.launchpad/conventions.md` (customer engineering standards)                                              |
| `validate_project_conventions`                                    | Validate conventions file + referenced `.cursor/` paths                                                        |
| `get_project_schema_inventory`                                    | Existing tables/columns/FKs/master tables + folder layout. Extend existing tables — never create parallel ones |
| `get_scope_schema_alignment_report`                               | Per-item schema/layout alignment for a scope implement run (`releaseId`, `runId`; development target)          |
| `get_release_lock_schema_alignment_report`                        | Same check for the release-lock backend agent                                                                  |
| `list_developer_repo_branches` / `validate_developer_repo_branch` | Dev repo branches                                                                                              |

## Discover

| Tool                                                                                                                                   | Use                  |
| -------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `get_client_details` / `patch_client_details`                                                                                          | Client profile       |
| `scrape_client_website` / `enrich_client_details` / `add_competitor_from_website` / `refresh_competitors`                              | Research             |
| `add_discovery_note`                                                                                                                   | Notes                |
| `get_discovery_summary` / `generate_discovery_summary` / `patch_discovery_summary`                                                     | Summary              |
| `generate_discovery_questions` / `patch_discovery_questions` / `publish_discovery_questionnaire` / `unpublish_discovery_questionnaire` | Questionnaire        |
| `capture_questionnaire_responses` / `generate_questionnaire_summary`                                                                   | Responses            |
| `discovery_chat` / `get_discovery_thread_status`                                                                                       | Discovery agent chat |
| `list_workspace_documents` / `create_workspace_document` / `update_workspace_document` / `delete_workspace_document`                   | Docs                 |
| `generate_workspace_document` / `regenerate_workspace_document` / `workspace_document_chat`                                            | Doc AI               |
| `export_workspace_document` / `list_workspace_document_revisions` / `restore_workspace_document_revision`                              | History              |
| `workspace_document_jira_create` / `workspace_document_jira_link`                                                                      | Doc → Jira           |
| `patch_discovery_stakeholders` / `patch_engagement_phase` / `resend_stakeholder_link`                                                  | Stakeholders / phase |
| `ingest_confluence_page` / `ingest_granola_note` / `ingest_hub_meetings` / `list_granola_notes` / `list_confluence_spaces`             | Ingest               |
| `generate_prd` / `get_prd` / `update_prd` / `prd_chat` / `regenerate_prd`                                                              | PRD                  |
| `sync_prd_from_discovery` / `list_prd_revisions` / `restore_prd_revision`                                                              | PRD sync             |
| `generate_kickoff_presentation` / `get_kickoff_presentation` / `list_kickoff_presentations` / `export_kickoff_presentation`            | Kickoff              |
| `generate_persona_insights` / `refresh_persona_smart_fields`                                                                           | Personas             |
| `resolve_capture_context`                                                                                                              | Capture context      |

## Plan

| Tool                                                                                                                          | Use                                             |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `list_epics` / `create_epic` / `update_epic` / `delete_epic`                                                                  | Epics                                           |
| `create_story` / `update_story` / `delete_story`                                                                              | Stories                                         |
| `epic_story_chat`                                                                                                             | Backlog AI assist                               |
| `get_backlog_suggestions` / `apply_backlog_suggestion`                                                                        | Suggestions from discovery                      |
| `bulk_create_jira_issues` / `get_jira_tickets` / `get_jira_ticket_context` / `list_jira_projects` / `suggest_jira_from_figma` | Jira                                            |
| `create_release`                                                                                                              | New line (`startDate` + `releaseDate` required) |
| `update_release` / `update_release_status`                                                                                    | Metadata / status — both need **`reason`**      |
| `activate_release`                                                                                                            | Make release active — requires **`reason`**     |
| `get_release_scope` / `set_release_scope`                                                                                     | Scope items                                     |
| `get_release_feature_suggestions` / `release_suggestion_repo_scan`                                                            | Feature ideas                                   |
| `get_release_changelog` / `regenerate_review_summary`                                                                         | Audit / review                                  |

## Build — first revision / seed / implement / migrate

| Tool                                                     | Use                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seed_release_from_prior`                                | Empty active → last tag (`mode: baseline_copy` \| `agent` + `promptText`). Needs a prior tagged revision                                                                                                                                                                                                                                                       |
| `start_first_revision_from_prompt`                       | Empty active **and no prior tag** (greenfield): Cursor agent builds R1 from `promptText`. Poll `get_cursor_agent`                                                                                                                                                                                                                                              |
| `create_empty_react_revision`                            | Empty active **and no prior tag**: publish a minimal Vite React app as R1 (sync; returns `version`, `workflowId`)                                                                                                                                                                                                                                              |
| `start_scope_implement`                                  | Prefer `execution: sequential`, `target: platform`, `items[].sortOrder`                                                                                                                                                                                                                                                                                        |
| `get_scope_implement_active` / `get_scope_implement_run` | Poll implement                                                                                                                                                                                                                                                                                                                                                 |
| `clarify_scope_implement`                                | Unblock implement                                                                                                                                                                                                                                                                                                                                              |
| `cancel_scope_implement`                                 | Cancel (`confirm`)                                                                                                                                                                                                                                                                                                                                             |
| `revert_release_to_baseline`                             | Revert (`confirm`)                                                                                                                                                                                                                                                                                                                                             |
| `migrate_frontend`                                       | **Build Frontend App** — same as UI. Tool preflights `get_cursor_github_readiness` (blocks with invite/access guidance if not ready; **no** browser confirm waits on the server). Optional `projectVersionId`, `userPrompt`. Returns `agentId` (often `readonly_migrate_*`). Poll `get_cursor_agent` until terminal (`MIGRATE_PLATFORM_SYNC_FAILED` = failed). |
| `start_migrate_frontend_agent`                           | Do **not** use for Build Frontend App. Internal/legacy multi-repo Cursor agent only.                                                                                                                                                                                                                                                                           |
| `list_versions` / `activate_version` / `switch_version`  | Revisions                                                                                                                                                                                                                                                                                                                                                      |

## Build — agents (generic / Cursor)

| Tool                                                                                     | Use                                           |
| ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| `spawn_dev_agent` / `agent_followup` / `get_agent_status` / `stop_agent`                 | Project dev agents — **not** Backend Code tab |
| `create_cursor_agent` / `cursor_agent_followup` / `get_cursor_agent`                     | Cursor cloud agents                           |
| `stop_cursor_agent` / `stop_and_revert_cursor_agent` / `merge_cursor_agent_to_launchpad` | Cursor lifecycle                              |
| `start_scratch_agent` / `stop_scratch_agent`                                             | Scratch                                       |

## Build — preview / Client Link share

| Tool                                                                        | Use                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `start_preview` / `get_preview_status` / `restart_preview` / `stop_preview` | Preview lifecycle                                                                                                                                                                          |
| `get_preview_manifest` / `update_preview_manifest`                          | `.launchpad/preview.json` (root, framework, package manager, dev command, port/host, health). Update pins it (`source: agent`); restarts preview unless `restart=false`                    |
| `redetect_preview_manifest`                                                 | Discard pinned manifest and auto-detect again (`confirm`)                                                                                                                                  |
| `get_preview_env` / `update_preview_env`                                    | Preview env vars (write-only secrets; returns `hasValue`/`valueHint`). Restarts preview when running                                                                                       |
| `share_client_link_preview`                                                 | Keep preview alive for the client share window (default 24h); notifies team                                                                                                                |
| `create_preview_direct_link`                                                | Signed 30-day direct preview URL on its own subdomain with feedback widget. **ECS only** (409 otherwise; check `get_preview_status.directLinkAvailable`). Also shares unless `share=false` |
| `list_preview_screens` / `delete_preview_screen`                            | Full-page screenshots queued for the Figma plugin (delete needs `confirm`)                                                                                                                 |
| `export_launchpad_zip`                                                      | Export platform zip                                                                                                                                                                        |

## Build — backend code / architecture / infra

All three project chats share the same family:
`<prefix>_get_session`, `<prefix>_send_message` (**`prompt`**, optional `mode`),
`<prefix>_list_queue`, `<prefix>_steer_queued_message`,
`<prefix>_reorder_queue`, `<prefix>_cancel_queued_message`, `<prefix>_archive`,
`<prefix>_list_archived_threads`, `<prefix>_get_archived_thread`.
`<prefix>_stop` exists for `backend_code_chat` and `infra_chat` only (no `cloud_debug_chat_stop`).

| Prefix              | Chat                                                 | Extras                                                                                        |
| ------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `backend_code_chat` | Backend Code (development repo)                      | `backend_code_chat_build_plan` / `backend_code_chat_clear_pending_plan` (Plan mode)           |
| `infra_chat`        | Infra analysis agent (**not** `infra_analysis_chat`) | `infra_chat_confirm_change` / `infra_chat_reject_change` (proposed IaC change by `messageId`) |
| `cloud_debug_chat`  | Cloud debug agent                                    | `cloud_debug_chat_readiness` before first send                                                |

| Tool                                                                                                     | Use                               |
| -------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `generate_understand_graph` / `sync_understand_graph` / `get_understand_status` / `get_understand_graph` | Architecture graph                |
| `get_understand_diff_overlay` / `get_understand_file_content` / `get_domain_graph`                       | Graph reads                       |
| `run_infra_analysis` / `get_infra_analysis_latest` / `get_infra_analysis_result`                         | Infra analysis pipeline           |
| `get_dev_repo_tree` / `get_dev_repo_file` / `get_dev_repo_commits` / `get_dev_repo_changed_files`        | Dev repo browse                   |
| `fail_stuck_dev_repo_git_ops`                                                                            | Admin stuck git locks (`confirm`) |

## Build — cloud / env / deploy / CI/CD

| Tool                                                                                                                        | Use                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `get_deploy_map` / `patch_deploy_map` / `prepare_deploy_map` / `export_deploy_map`                                          | Deploy map                                                                                                             |
| `run_environment_scan`                                                                                                      | Env scan                                                                                                               |
| `backend_cloud_deploy_preflight`                                                                                            | Preflight                                                                                                              |
| `start_backend_cloud_deploy` / `get_backend_cloud_deploy_latest` / `get_backend_cloud_deploy_run`                           | Cloud deploy poll                                                                                                      |
| `cancel_backend_cloud_deploy`                                                                                               | Cancel                                                                                                                 |
| `get_project_cicd`                                                                                                          | CI/CD status; poll while `pending_setup` / `pending_connection`                                                        |
| `enable_project_cicd`                                                                                                       | Detect + adopt existing GitHub/AWS pipeline, or returns `needsCreate` / `needsChoice` (creates nothing)                |
| `attach_project_cicd`                                                                                                       | Pick `provider` when both GitHub and AWS pipelines detected                                                            |
| `create_project_cicd`                                                                                                       | Create GitHub Actions or CodePipeline (`provider`, optional `branch`) **after user confirms**; poll `get_project_cicd` |
| `sync_project_cicd_secrets`                                                                                                 | Copy deploy-map env (`environmentId`) into pipeline secret (LaunchPad-created pipelines only)                          |
| `run_project_cicd`                                                                                                          | Trigger pipeline; poll `get_backend_cloud_deploy_run` with returned `runId`                                            |
| `disable_project_cicd`                                                                                                      | Turn off; removes LaunchPad-created pipeline + secrets (`confirm`)                                                     |
| `get_platform_deploy_mode` / `prepare_platform_deploy_mode` / `resume_platform_deploy_mode` / `cancel_platform_deploy_mode` | Platform deploy mode                                                                                                   |
| `list_app_deployments`                                                                                                      | Deployments list                                                                                                       |

## Validate — QA

| Tool                                                                                                                                                  | Use                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `get_qa_config` / `update_qa_config` / `resolve_qa_config` / `get_qa_context` / `get_qa_auth_hints`                                                   | QA setup                                                                                                |
| `list_qa_projects` / `list_qa_topics` / `create_qa_topic` / `update_qa_topic`                                                                         | Topics                                                                                                  |
| `list_qa_chats` / `create_qa_chat` / `get_qa_chat` / `update_qa_chat` / `delete_qa_chat`                                                              | Chats                                                                                                   |
| `send_qa_chat_message` / `get_qa_message` / `retry_qa_generation`                                                                                     | QA agent                                                                                                |
| `fix_qa_failed_tests`                                                                                                                                 | Heal failed Playwright tests in place (`messageId`, `confirm`; optional `runEnvironment`, `userPrompt`) |
| `list_qa_reports` / `get_qa_report` / `move_qa_report_to_feedback`                                                                                    | Reports                                                                                                 |
| `get_qa_visual_testing_readiness` / `fetch_qa_visual_design`                                                                                          | Figma visual compare setup                                                                              |
| `list_qa_visual_compare_runs` / `get_qa_visual_compare_run`                                                                                           | Visual compare runs (presigned artifacts)                                                               |
| `move_visual_run_to_feedback`                                                                                                                         | Failed visual run → `VISUAL_TEST` feedback                                                              |
| `start_visual_fix_with_ai` / `get_visual_run_fix_status`                                                                                              | Fix with AI for a visual run (`repoPath`, `sourceBranch`; opens PR)                                     |
| `start_qa_test_import` / `get_qa_import_job_status` / `get_qa_import_status` / `stop_qa_test_import` / `list_qa_import_jobs`                          | Playwright import (ZIP must already be in S3 — upload is out of MCP scope)                              |
| `start_qa_tests_export` / `get_qa_tests_export_status`                                                                                                | Workspace ZIP export (prefer over legacy `download_qa_tests`)                                           |
| `get_qa_export_pr_options` / `start_qa_export_pr` / `get_qa_export_pr_status` / `get_qa_export_pr_state`                                              | Push `launchpad-qa/` to GitHub as a PR                                                                  |
| `sync_qa_workspace`                                                                                                                                   | Full Playwright workspace listing for desktop sync                                                      |
| `get_qa_analytics_overview` / `get_qa_analytics_users` / `get_qa_analytics_executions` / `get_qa_analytics_dashboard` / `get_qa_analytics_test_cases` | QA App analytics (not agent analytics)                                                                  |
| `get_admin_qa_analytics_portfolio` / `get_admin_qa_analytics_project` / `ingest_qa_analytics_events`                                                  | Admin QA analytics / desktop ingest                                                                     |

## Validate — feedback / Sentry / comments / Client Link verify

| Tool                                                                                                                               | Use                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_feedback` / `list_all_feedback` / `get_feedback` / `update_feedback` / `delete_feedback`                                     | Feedback (**UUID** ids)                                                                                                                                                                       |
| `start_feedback_ai_fix` / `get_feedback_ai_fix_status` / `clarify_feedback_ai_fix`                                                 | AI fix + poll                                                                                                                                                                                 |
| `start_feedback_ai_fix_batch` / `cancel_feedback_ai_fix`                                                                           | Batch / cancel                                                                                                                                                                                |
| `approve_feedback`                                                                                                                 | Approve → Jira when configured                                                                                                                                                                |
| `list_feedback_jira_labels` / `list_feedback_jira_priorities`                                                                      | Jira meta                                                                                                                                                                                     |
| `install_feedback_snippet`                                                                                                         | Snippet                                                                                                                                                                                       |
| `get_sentry_integration` / `list_sentry_projects`                                                                                  | Sentry link status / pickable org projects                                                                                                                                                    |
| `set_sentry_integration`                                                                                                           | Link 1–20 `sentryProjectSlugs` (full list; omitted slugs unlink). Imports up to 50 unresolved issues each as `SENTRY` feedback; `autoFixEnabled` opens PRs for new issues (never auto-merges) |
| `import_sentry_issues`                                                                                                             | Idempotent re-import of unresolved issues as feedback (no auto-fix)                                                                                                                           |
| `delete_sentry_integration`                                                                                                        | Unlink all Sentry projects (`confirm`)                                                                                                                                                        |
| `list_preview_comments` / `create_preview_comment` / `update_preview_comment` / `delete_preview_comment` / `reply_preview_comment` | Preview comments                                                                                                                                                                              |
| `run_client_link_verify` / `get_client_link_verify_status`                                                                         | Host clean install + build of the Client Link tree (1–10 min); `failed` includes `failedCommand` + log tail                                                                                   |

## Validate — security review / deploy monitors

| Tool                                                                | Use                                                            |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| `get_security_review_settings` / `update_security_review_settings`  | Enable / team rules / `pinnedPlaybookModes`                    |
| `run_security_review`                                               | Manually review a PR (`repoFullName`, `prNumber`)              |
| `list_security_review_findings` / `dismiss_security_review_finding` | Findings (filter by `prNumber`)                                |
| `set_deploy_monitor_enabled`                                        | Toggle post-deploy monitoring                                  |
| `list_deploy_monitors` / `get_deploy_monitor`                       | Monitor runs (`healthy` \| `regression` \| `inconclusive`)     |
| `spawn_deploy_regression_fix_agent`                                 | Cursor agent drafts revert/fix PR for a regression (`confirm`) |

## Ship / release lifecycle

| Tool                                       | Use                                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `lock_release`                             | Lock active (`confirm`). Dev implement → `skipLockAgentOperations: true`. Optional `userPrompt` |
| `get_release_lock_status`                  | Poll when backend agent used                                                                    |
| `get_release_lock_schema_alignment_report` | Lock agent schema alignment (development repos)                                                 |
| `seed_release_from_prior`                  | Seed next empty active from last tag                                                            |
| `get_release_changelog`                    | Audit                                                                                           |

## Onboarding / project create

| Tool                                                                     | Use                                                                          |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `init_onboarding` / `start_onboarding_migrate` / `enhance_prompt`        | Onboard methods                                                              |
| `create_onboarding_managed_prompt` / `enhance_onboarding_managed_prompt` | Onboarding prompts                                                           |
| `check_slug_availability` / `create_project`                             | Slug check, then create (`name` 3–100 chars; optional `description`, `slug`) |
| `delete_project`                                                         | Delete (`confirm`)                                                           |
| `update_journey_tour`                                                    | Tour completed/skipped                                                       |

## Client link

| Tool                                                                                                                             | Use                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_client_link`                                                                                                                | **Stakeholder Client Link** — `{origin}/projects/{slug}` (e.g. `https://launchpad.yorkdevs.link/projects/patriot-pay`). Not preview host:port. |
| `get_public_project` / `ensure_public_preview` / `get_public_preview_status` / `get_public_preview_logs` / `stop_public_preview` | Public preview                                                                                                                                 |
| `get_client_link_messages` / `get_client_link_agent_status` / `get_client_link_summary` / `refresh_client_link_build`            | Status                                                                                                                                         |
| `steer_client_link_queued_message`                                                                                               | Inject a queued stakeholder message into the live turn (`slug`, `releaseId`, `messageId`, `clientEmail`)                                       |
| `resend_stakeholder_link`                                                                                                        | Resend (when allowed)                                                                                                                          |

## Integrations

| Tool                                                                                                         | Use                                             |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `get_integrations_status` / `get_cursor_status` / `list_creator_connections`                                 | Status                                          |
| `get_github_connect_url` / `get_bitbucket_connect_url` / `get_jira_connect_url` / `get_figma_connect_url`    | OAuth start — returns a URL **the human** opens |
| `list_github_repos` / `list_github_branches` / `validate_github_branch`                                      | GitHub                                          |
| `list_bitbucket_repos` / `list_bitbucket_branches` / `validate_bitbucket_branch`                             | Bitbucket                                       |
| `sync_cursor_github` (project) / `sync_cursor_github_pat` / `set_cursor_pat`                                 | Cursor ↔ GitHub token                           |
| `set_figma_pat` / `set_granola_api_key`                                                                      | Tokens                                          |
| `disconnect_github` / `disconnect_bitbucket` / `disconnect_jira` / `disconnect_figma` / `disconnect_granola` | Disconnect (`confirm`; never auto)              |

## Jobs / automations

| Tool                                                                                                   | Use               |
| ------------------------------------------------------------------------------------------------------ | ----------------- |
| `list_jobs` / `list_project_jobs` / `get_job` / `create_job` / `update_job` / `delete_job` / `run_job` | Jobs              |
| `list_job_runs` / `delete_job_run`                                                                     | Runs              |
| `get_automation_documents` / `get_automation_repos`                                                    | Automation meta   |
| `validate_job_project_branch`                                                                          | Branch validation |

## Cursor rules / skills / prompts / models

| Tool                                                                                                                                                                                                                                                                             | Use                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `list_workspace_cursor_rules` / `list_workspace_cursor_skills` / `list_workspace_custom_rules` / `list_workspace_custom_skills`                                                                                                                                                  | Workspace catalogs                     |
| `list_project_cursor_rules_catalog` / `list_project_custom_cursor_rules` / `create_project_custom_cursor_rule` / `import_project_cursor_rules`                                                                                                                                   | Project rules                          |
| `list_project_cursor_skills_catalog` / `list_project_custom_cursor_skills` / `create_project_custom_cursor_skill` / `import_project_cursor_skills`                                                                                                                               | Project skills                         |
| `create_project_managed_prompt` / `get_project_managed_prompt` / `update_project_managed_prompt` / `enhance_project_managed_prompt` / `preview_project_managed_prompt`                                                                                                           | Project prompts                        |
| `list_managed_prompts` / `get_managed_prompt` / `get_managed_prompt_by_key` / `create_managed_prompt` / `update_managed_prompt` / `delete_managed_prompt` / `duplicate_managed_prompt` / `preview_managed_prompt` / `enhance_managed_prompt` / `invalidate_managed_prompt_cache` | Admin global prompts                   |
| `get_prompt_config` / `update_prompt_config` / `list_prompt_config_options` / `list_project_prompt_config_options` / `list_system_prompt_bases`                                                                                                                                  | Prompt config                          |
| `get_platform_model_router` / `update_platform_model_router` / `get_project_model_router` / `update_project_model_router` / `list_project_model_router_overrides`                                                                                                                | Model router                           |
| `list_agent_analytics_runs` / `get_agent_analytics_run` / `stop_agent_analytics_run`                                                                                                                                                                                             | Agent analytics (stop needs `confirm`) |
| `list_cost_analytics`                                                                                                                                                                                                                                                            | Cost analytics                         |

## Admin analytics

| Tool                                                                 | Use                                    |
| -------------------------------------------------------------------- | -------------------------------------- |
| `get_platform_analytics_overview` / `get_platform_feature_adoption`  | Platform KPIs / feature usage          |
| `list_platform_analytics_users` / `get_platform_analytics_user`      | Users                                  |
| `list_platform_analytics_projects` / `list_platform_activity`        | Projects / cross-project activity feed |
| `get_project_client_link_voice` / `update_project_client_link_voice` | Client Link voice mode                 |

## Auth / MCP keys

| Tool                                                              | Use      |
| ----------------------------------------------------------------- | -------- |
| `create_mcp_api_key` / `list_mcp_api_keys` / `revoke_mcp_api_key` | MCP keys |

## Monitor matrix (start → poll)

| Start                                             | Poll                                                                                                                                 | On success next                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `seed_release_from_prior`                         | `list_versions`                                                                                                                      | implement / preview                                                |
| `start_first_revision_from_prompt`                | `get_cursor_agent` (+ `list_versions`)                                                                                               | preview / scope                                                    |
| `start_scope_implement`                           | `get_scope_implement_active`, `get_scope_implement_run`, `list_versions`                                                             | `start_preview` (development: `get_scope_schema_alignment_report`) |
| `migrate_frontend`                                | `get_cursor_agent` (+ list_versions); treat `MIGRATE_PLATFORM_SYNC_FAILED` as terminal fail. Preflight GitHub readiness is built in. | re-preview / compare                                               |
| `start_preview` / `restart_preview`               | `get_preview_status`                                                                                                                 | QA / fidelity / approve                                            |
| `run_client_link_verify`                          | `get_client_link_verify_status`                                                                                                      | fix build failure or continue                                      |
| `lock_release`                                    | `get_release_lock_status`                                                                                                            | `list_releases` → seed                                             |
| `start_feedback_ai_fix`                           | `get_feedback_ai_fix_status`                                                                                                         | `approve_feedback` / preview                                       |
| `start_visual_fix_with_ai`                        | `get_visual_run_fix_status`                                                                                                          | re-run visual compare                                              |
| `send_qa_chat_message` / `fix_qa_failed_tests`    | `get_qa_message`, `retry_qa_generation`                                                                                              | reports → feedback                                                 |
| `start_qa_test_import`                            | `get_qa_import_job_status`                                                                                                           | run QA                                                             |
| `start_qa_tests_export` / `start_qa_export_pr`    | `get_qa_tests_export_status` / `get_qa_export_pr_status`                                                                             | share URL / PR                                                     |
| `create_cursor_agent` / `spawn_dev_agent`         | `get_cursor_agent` / `get_agent_status`                                                                                              | merge / preview if FE                                              |
| `backend_code_chat_send_message`                  | `backend_code_chat_get_session`                                                                                                      | verify / understand                                                |
| `infra_chat_send_message`                         | `infra_chat_get_session`                                                                                                             | confirm/reject change                                              |
| `cloud_debug_chat_send_message`                   | `cloud_debug_chat_get_session`                                                                                                       | fix / redeploy                                                     |
| `start_backend_cloud_deploy` / `run_project_cicd` | `get_backend_cloud_deploy_latest` / `get_backend_cloud_deploy_run`                                                                   | `list_deploy_monitors` / smoke                                     |
| `create_project_cicd` / `enable_project_cicd`     | `get_project_cicd`                                                                                                                   | sync secrets → run                                                 |
| `run_infra_analysis`                              | `get_infra_analysis_latest`                                                                                                          | diagram / suggestions                                              |
| `generate_understand_graph`                       | `get_understand_status`                                                                                                              | architecture review                                                |
| `refresh_project_memory`                          | `get_project_memory` (`knowledgeRefresh.status`)                                                                                     | continue                                                           |

Cursor agent `model` is always server-resolved; do not pass `model` on `create_cursor_agent`.
