# Expected output

All Gtm-Launchpad tools return a `WorkflowChatToolResult` envelope. Read `ok` and `data` before summarizing to the user.

```ts
{
  ok: boolean
  flowId?: string
  pendingGate?: object
  data: unknown
}
```

## Preview (mutation without `confirm: true`)

Gated tools and every `configure_*` return this instead of mutating:

```json
{
  "ok": true,
  "data": {
    "status": "preview",
    "toolName": "create_workflow",
    "message": "This action needs approval. Retry with confirm: true.",
    "toolInput": {
      "displayName": "LinkedIn weekly",
      "projectId": "…",
      "clientId": "…"
    }
  }
}
```

`set_workflow_status` with `ENABLED` uses the same shape (`message` mentions enabling). Show the preview, wait for the user, then retry with `confirm: true`.

If the executor still sees a chat approval gate:

```json
{
  "ok": false,
  "data": { "error": "Retry with confirm: true to run this action." }
}
```

## Success

`ok: true`. Workflow mutations usually include `flowId`. `data` is tool-specific:

| Kind | Typical `data` |
|------|----------------|
| Lists | Array or `{ data, cursor }` page |
| One record | Object (workflow, run, connection, prompt, user) |
| Create/import | New `flowId` / row id / entry id |
| `run_workflow` | Run id in `QUEUED` or `RUNNING` — poll `get_last_run` |
| `get_step_config` / `list_connections` | Auth secrets omitted |
| `list_variables` | Values for secrets omitted |
| `get_oauth_authorization_url` | URL for the user to open |
| `get_piece_schema` | Compact actions/triggers/required props |
| `get_piece_property_options` | Allowed enum options for one field |

## Errors (plain language)

| Symptom | Meaning |
|---------|---------|
| `401` / invalid key | Re-auth (`mcp_auth`) or regenerate `lp_mcp_…` |
| `projectId is required` | Pass `clientId` and/or `projectId` |
| `That tool is not recognized` | Hidden by RBAC, designer-only, or not on this server — refresh definitions |
| `That tool is not available over MCP` | Chat-only `ap_show_*` — do not call |
| HTML / `<!doctype` | Client hit the SPA, not `/api/mcp` |

Do not invent success. Quote ids and statuses from `data`.
