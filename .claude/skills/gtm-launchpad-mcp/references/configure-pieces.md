# configure_* pieces

Dynamic tools match the `DEPLOY_ENV` piece allowlist. Inspect live names with `GetDynamicTools` before calling.

Call **`get_piece_schema` first** (`piece` = short name or `@activepieces/piece-…`). For dropdowns and dependent fields, call **`get_piece_property_options`**. For OAuth pieces, **`list_connections`** then pass `authConnectionExternalId` — never invent it.

Requires `confirm: true` to apply. Without it, expect the preview envelope in [expected-output.md](expected-output.md).

## Shared input

Required: `projectId` (and/or `clientId`), `flowId`, `mode`.

| `mode` | Also required |
|--------|----------------|
| `add` | `parentStep` |
| `update` | `stepName` |
| `replace_trigger` | `triggerName` |

Optional: `actionName`, `input` (merged into step fields), `authConnectionExternalId`.

Success: `{ ok: true, flowId, data }` with the updated step. Failure: missing required props, unknown connection, or piece not allowlisted.

## Tool → piece

| MCP tool | Piece |
|----------|--------|
| `configure_manual_trigger` | manual-trigger |
| `configure_schedule` | schedule |
| `configure_webhook` | webhook |
| `configure_http` | http |
| `configure_delay` | delay |
| `configure_approval` | approval |
| `configure_store` | store |
| `configure_data_mapper` | data-mapper |
| `configure_date_helper` | date-helper |
| `configure_csv` | csv |
| `configure_forms` | forms |
| `configure_subflows` | subflows |
| `configure_content_calendar` | content-calendar |
| `configure_ai` | ai |
| `configure_openai` | openai |
| `configure_claude` | claude |
| `configure_google_gemini` | google-gemini |
| `configure_linkedin` | linkedin |
| `configure_facebook_pages` | facebook-pages |
| `configure_facebook_leads` | facebook-leads |
| `configure_instagram_business` | instagram-business |
| `configure_twitter` | twitter |
| `configure_youtube` | youtube |
| `configure_pinterest` | pinterest |
| `configure_bluesky` | bluesky |
| `configure_buffer` | buffer |
| `configure_hootsuite` | hootsuite |
| `configure_typefully` | typefully |
| `configure_gmail` | gmail |
| `configure_google_sheets` | google-sheets |
| `configure_google_calendar` | google-calendar |
| `configure_mailchimp` | mailchimp |
| `configure_mailgun` | mailgun |
| `configure_sendgrid` | sendgrid |
| `configure_activecampaign` | activecampaign |
| `configure_klaviyo` | klaviyo |
| `configure_constant_contact` | constant-contact |
| `configure_beehiiv` | beehiiv |
| `configure_getresponse` | getresponse |
| `configure_hubspot` | hubspot |
| `configure_salesforce` | salesforce |
| `configure_apollo` | apollo |
| `configure_lemlist` | lemlist |
| `configure_airtable` | airtable |
| `configure_notion` | notion |
| `configure_slack` | slack |
| `configure_discord` | discord |
| `configure_microsoft_teams` | microsoft-teams |
| `configure_microsoft_outlook` | microsoft-outlook |
| `configure_telegram_bot` | telegram-bot |
| `configure_whatsapp` | whatsapp |
| `configure_calendly` | calendly |
| `configure_stripe` | stripe |
| `configure_shopify` | shopify |
| `configure_webflow` | webflow |
| `configure_wordpress` | wordpress |

Generic alternative: `create_step` with `piece` + `actionName` + `parentStep` (also confirm-gated). Prefer `configure_*` when the named tool exists.
