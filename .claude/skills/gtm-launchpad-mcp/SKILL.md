---
name: gtm-launchpad-mcp
description: Operate GTM Launchpad via the Gtm-Launchpad MCP namespace. Use when listing or editing workflows, pieces, connections, content calendar, brand profile, users, skill library, or audit logs; when the user mentions MCP, clientId, projectId, confirm, configure_*, or GTM Launchpad tools.
---

# GTM Launchpad MCP

Cursor skill for the **Gtm-Launchpad** MCP server. The skill does not register tools — the MCP connection does. This file teaches **when** to call them, **in what order**, and **how to read results**.

MCP namespace: `project-0-GTM-Launchpad-Gtm-Launchpad` (server name `Gtm-Launchpad`).

Do **not** use the **Launchpad** namespace (`project-0-GTM-Launchpad-Launchpad`) — that is the product platform (projects, PRDs, QA), not client workflows.

## Load live tools first

RBAC and the piece allowlist hide tools. Never assume a frozen list.

1. If calls fail with auth errors, invoke `mcp_auth` on this namespace.
2. Inspect schemas with `GetDynamicTools` (`namespace: project-0-GTM-Launchpad-Gtm-Launchpad`).
3. Optional HTTP catalog: `GET /api/mcp/workflow-tools/definitions`.
4. Invoke with `CallDynamicTool` using that namespace. Do not guess `pieceName` vs `piece`, dropdown values, `flowId`, or `authConnectionExternalId`.

Full inventory: [references/tools-catalog.md](references/tools-catalog.md)  
`configure_*`: [references/configure-pieces.md](references/configure-pieces.md)  
Envelopes: [references/expected-output.md](references/expected-output.md)

## MCP client config

Cursor `.cursor/mcp.json` (or Settings → MCP). URL **must** include `/api/mcp`.

```json
{
  "mcpServers": {
    "Gtm-Launchpad": {
      "url": "http://localhost:5000/api/mcp"
    }
  }
}
```

Prod: `https://gtm-launchpad.yorkdevs.link/api/mcp`. OAuth is recommended (browser consent at `/mcp-authorize`). API-key mode adds `"headers": { "Authorization": "Bearer lp_mcp_…" }` — create the key in Account → MCP API Keys.

Stdio: `GTM_LAUNCHPAD_API_BASE` + `GTM_MCP_API_KEY`. Details: `mcp-server/README.md`.

## Protocol

| Rule | Detail |
|------|--------|
| Session first | `list_accessible_clients` or `resolve_workspace` — keep `clientId` + `projectId` |
| Workspace calls | Pass **`clientId`** (preferred) and/or **`projectId`** every time — agency MCP has no account swap |
| Mutations | First call without `confirm` → preview. After the user approves, retry with `confirm: true` |
| Enable | `set_workflow_status` with `ENABLED` + `confirm: true` is always gated |
| Piece steps | `get_piece_schema` → `get_piece_property_options` → `list_connections` → `configure_*` / `create_step` |
| After success | State what changed and include `flowId`. Never say enabled unless status is `ENABLED` |

## Decision tree

```
User wants GTM Launchpad work
├─ MCP unauthenticated? → mcp_auth
├─ Know clientId? NO → list_accessible_clients OR resolve_workspace
├─ Pass clientId (and projectId) on every later workspace tool
├─ Workflows
│  ├─ Know flow id? NO → list_workflows / describe_workflow
│  ├─ Need stepName? → list_flow_steps → get_step_config
│  ├─ Create?
│  │  ├─ Client Admin → list_templates → create_workflow_from_template OR duplicate_workflow
│  │  └─ Designer → import_* channel OR create_workflow
│  ├─ Add piece step? → get_piece_schema → get_piece_property_options → list_connections → configure_<piece>
│  ├─ Patch fields? → update_step_config (confirm: true)
│  ├─ Remove step? → delete_step (confirm: true)
│  ├─ Enable? → set_workflow_status(ENABLED, confirm: true)
│  └─ Test? → run_workflow (confirm) → poll get_last_run
├─ Calendar / brand / prompts / users / audit → tools-catalog.md
└─ Tool missing? → refresh GetDynamicTools (RBAC or not shipped)
```

## Examples

**LinkedIn draft**

1. `list_accessible_clients` (or `resolve_workspace`) → note `clientId` + `projectId`
2. `import_linkedin_workflow` with `clientId`, `projectId`, `displayName`, `confirm: true`
3. Keep returned `flowId`

**Facebook Pages step**

1. `get_piece_schema` with `piece: "facebook-pages"`
2. `list_connections` with `pieceName: "facebook-pages"`
3. `configure_facebook_pages` with `mode`, `flowId`, `authConnectionExternalId`, `confirm: true`

## Anti-patterns

- Workspace tools without `clientId` or `projectId`
- Skipping `get_piece_schema` before `configure_*`
- Guessing dropdown values instead of `get_piece_property_options`
- Inventing `flowId` or `authConnectionExternalId`
- Calling `ap_show_*` or `/api/v1/chat/*`
- Claiming enabled without `set_workflow_status` → `ENABLED`
- Dumping every tool schema into chat — inspect MCP, then call
- Using the Launchpad **platform** MCP for client workflow CRUD
