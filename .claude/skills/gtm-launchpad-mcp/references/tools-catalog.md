# Tool catalog

Live source of truth: MCP namespace `project-0-GTM-Launchpad-Gtm-Launchpad` and `GET /api/mcp/workflow-tools/definitions`. This file is a grouped map. Confirm each tool exists before calling.

`confirm: yes` = preview without `confirm: true`; retry after user approval. `configure_*` tools: [configure-pieces.md](configure-pieces.md). Envelopes: [expected-output.md](expected-output.md).

Session tools omit `projectId` / `clientId`. Every other tool needs at least one.

## Session

| Tool | Purpose | confirm | Usage | Expected output |
|------|---------|---------|-------|-----------------|
| `mcp_auth` | Authenticate this MCP server | — | Empty args | Auth complete; retry other tools |
| `list_accessible_clients` | List accounts you can access | — | No workspace ids | Clients with `clientId` + `projectId`s |
| `resolve_workspace` | Name/slug → workspace | — | `query`, optional `exact` | One match or ambiguous list |

## Workflows — read

| Tool | Purpose | confirm | Usage | Expected output |
|------|---------|---------|-------|-----------------|
| `list_workflows` | List/search flows | — | optional `name` | Flow list (id, name, status) |
| `get_workflow` | One flow | — | `flowId` | Name, status, version |
| `describe_workflow` | Compact graph | — | `flowId` | Trigger, step names, validity |
| `get_webhook_url` | Public catch-webhook URL | — | `flowId` | URL string |
| `list_flow_steps` | Internal step index | — | `flowId` | `stepName`, piece, action/trigger |
| `get_step_config` | One step input | — | `flowId`, `stepName` | Settings; secrets redacted |
| `list_folders` | Folder tree | — | optional `limit` | Folders |
| `list_pieces` | Allowlisted integrations | — | optional `search` | Piece names |
| `get_piece_schema` | Compact piece schema — call before `configure_*` | — | `piece`, optional `actionName` / `triggerName` | Actions, triggers, required props |
| `get_piece_property_options` | Dropdown / dynamic enums | — | `flowId`, `propertyName`; optional `stepName`, `piece`, `actionName`, `input`, `searchValue` | Allowed values |
| `list_templates` | Published agency templates | — | optional `search` | Template list |
| `get_template` | One template | — | `templateId` | Template payload |

## Workflows — write

| Tool | Purpose | confirm | Usage | Expected output |
|------|---------|---------|-------|-----------------|
| `create_workflow` | Empty draft (designers) | yes | `displayName` | New `flowId` |
| `rename_workflow` | Rename | — | `flowId`, `displayName` | Updated name |
| `set_workflow_status` | Enable/disable | yes if `ENABLED` | `flowId`, `ENABLED` \| `DISABLED` | New status |
| `delete_workflow` | Hard delete (designers) | yes | `flowId` | Deleted |
| `duplicate_workflow` | Copy in workspace | yes | `flowId`, optional `displayName` | New `flowId` |
| `create_workflow_from_template` | Instantiate template | yes | `templateId`, optional `displayName` | New `flowId` |
| `import_webhook_http_workflow` | Webhook → HTTP draft | yes | `displayName`, `url`, optional `method` | Draft `flowId` |
| `import_linkedin_workflow` | LinkedIn starter | yes | `displayName` | Draft `flowId` |
| `import_meta_workflow` | Facebook Pages starter | yes | `displayName` | Draft `flowId` |
| `import_content_calendar_workflow` | Calendar publish slot | yes | `displayName`, optional `channel` (`linkedin`, `meta`, `email`, `blog`, `webflow`, `shopify`, `hubspot`) | Draft `flowId` |
| `update_http_step` | Patch URL/method on simple webhook→HTTP graphs | yes | `flowId`, `url`, optional `method` | Updated step |
| `create_step` | Add piece action after parent | yes | `flowId`, `parentStep`, `piece`, `actionName`; optional `displayName`, `input`, `authConnectionExternalId` | New step |
| `update_step_config` | Merge input / display name (no piece swap) | yes | `flowId`, `stepName`; optional `displayName`, `input`, `authConnectionExternalId` | Updated step |
| `delete_step` | Remove action (not trigger) | yes | `flowId`, `stepName` | Removed |
| `move_workflow` | Change folder | — | `flowId`, `folderId` empty to unfolder | Moved |
| `share_workflow_as_template` | Designer → agency CUSTOM template | yes | `flowId`; optional `name`, `description`, `category`, `versionId` | Template id |
| `update_shared_template` | Snapshot linked template graph | yes | `flowId`; optional `templateId`, `description`, `versionId` | Updated template |
| `share_workflow_to_client` | Copy to another client (disabled) | yes | `flowId`, `targetTenantId`, optional `displayName` | Target `flowId` |
| `delete_template` | Delete agency template | yes | `templateId` | Deleted |

Designer template-category / setup-guide tools may appear in docs but not on this server. If missing after `GetDynamicTools`, they are not available.

## Runs

| Tool | Purpose | confirm | Usage | Expected output |
|------|---------|---------|-------|-----------------|
| `list_workflow_runs` | Run history | — | optional `flowId`, `status`, `limit` | Run list |
| `get_flow_run` | One run | — | `flowRunId` | Steps, status, logs |
| `get_last_run` | Latest for a flow | — | `flowId` | Status + output |
| `run_workflow` | Queue test run | yes | `flowId`, optional `payload` | Immediate `QUEUED`/`RUNNING` id — poll `get_last_run` |
| `retry_flow_run` | Retry failed/stopped | yes | `flowRunId`, optional `strategy` `FROM_FAILED_STEP` \| `ON_LATEST_VERSION` | New run |
| `cancel_flow_run` | Stop paused/queued/running; voids approvals | yes | `flowRunId` | Cancelled |

## Connections & variables

| Tool | Purpose | confirm | Usage | Expected output |
|------|---------|---------|-------|-----------------|
| `list_connections` | App connections | — | optional `pieceName`, `displayName`, `status` | `externalId` for step auth |
| `get_connection` | One connection | — | `connectionExternalId` | Connection (no secrets) |
| `delete_connection` | Remove connection | yes | `connectionExternalId` | Deleted |
| `get_oauth_authorization_url` | Browser OAuth URL | yes | `pieceName`, `redirectUrl`; optional `pieceVersion`, `clientId`, `scopes`, `props` | URL to open |
| `list_variables` | Project variables | — | optional `name`, `limit`, `cursor` | Names; secrets omitted |
| `create_variable` | Create variable | yes | `name`, `value`, optional `metadata` | Variable id |
| `update_variable` | Update value/metadata | yes | `variableId`; `value` and/or `metadata` | Updated |
| `delete_variable` | Delete variable | yes | `variableId` | Deleted |

## Content calendar & brand

| Tool | Purpose | confirm | Usage | Expected output |
|------|---------|---------|-------|-----------------|
| `list_content_calendar_rows` | Campaign rows | — | — | Rows |
| `create_content_calendar_row` | Add row | yes | `campaignName`, `scheduledAt` (ISO); optional `channel`, `campaignType`, `topic` | New row |
| `update_content_calendar_row` | Patch row | yes | `rowId` + fields to change | Updated row |
| `delete_content_calendar_row` | Remove row | yes | `rowId` | Deleted |
| `list_content_calendar_doc_import_runs` | Doc import history | — | optional `page`, `limit`, `status` | Import runs |
| `get_brand_profile` | Read brand profile | — | — | Brand JSON |
| `update_brand_profile` | Patch brand fields | yes | `profile` object | Updated profile |

## Skill library (prompt library)

| Tool | Purpose | confirm | Usage | Expected output |
|------|---------|---------|-------|-----------------|
| `list_prompt_library_entries` | List prompts | — | optional `scope` `LAUNCHPAD` \| `CLIENT`, `search`, `tag`, `limit` | Prompt list |
| `get_prompt_library_entry` | One prompt | — | `entryId` | Full body |
| `create_prompt_library_entry` | Create prompt | yes | `scope`, `title`, `body`, optional `tags` | New entry |
| `update_prompt_library_entry` | Update prompt | yes | `entryId`; optional `title`, `body`, `tags` | Updated |
| `delete_prompt_library_entry` | Delete prompt | yes | `entryId` | Deleted |

## Users & audit

| Tool | Purpose | confirm | Usage | Expected output |
|------|---------|---------|-------|-----------------|
| `list_tenant_users` | Users + pending invites | — | — | User list |
| `invite_tenant_user` | Invite | yes | `email`, `role` `client_admin` \| `contributor` \| `viewer` | Invite |
| `assign_tenant_user_role` | Change role | yes | `userId`, same `role` enum | Updated role |
| `revoke_tenant_user` | Remove user | yes | `userId` | Revoked |
| `set_contributor_assigned_flows` | Contributor flow assignments | yes | `userId`, `flowIds` | Assignments |
| `list_tenant_audit_logs` | Account audit | — | optional `limit` (max 50), `cursor` | Newest first |
| `list_global_audit_logs` | Platform audit (York IE admin) | — | optional `limit`, `cursor` | Global events |

## Never on MCP

- `ap_show_connection_picker`
- `ap_show_questions`
- `ap_show_quick_replies`
- Any `/api/v1/chat/*` wrapper
