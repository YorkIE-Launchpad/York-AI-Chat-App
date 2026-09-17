# Security audit remediation (Backend Code turn)

Short mapping of findings to fixes and primary files. Electron/main-process items live under repo root `src/main/`; Express API under `backend/src/`.

| ID | Finding | Fix | Primary files |
| --- | --- | --- | --- |
| **H1** | Unsafe ZIP extract (Zip Slip / symlinks) | `safeExtractZip` validates entry paths and symlinks before extract | `src/main/utils/safe-extract-zip.ts`, `session-transfer.ts`, `external-chat-import.ts`, `skills-manager.ts`, `hub-skills-library-service.ts` |
| **H2** | WebSocket auth bypass via open/pairing modes | WS always requires configured gateway token (`timingSafeTokenEqual`) | `src/main/remote/gateway.ts` |
| **H3** | Pairing self-approval via chat echo | Pairing completes only via desktop admin `approvePairing()`; codes not echoed to requester | `src/main/remote/gateway.ts`, `src/main/remote/remote-manager.ts` |
| **H4** | Feishu DM policy widened global gateway auth | Feishu allowlist sync only; revert global open/pairing widened by Feishu DM config | `src/main/remote/remote-manager.ts`, `remote-config-store.ts`, `gateway.ts` (`checkAuthorization` / channel-scoped DM) |
| **H5** | Zoom meeting UUID hijack across users | `claimZoomUuid` binds UUID to session owner `userSub` | `backend/src/zoom-sessions.ts`, `zoom-routes.ts`, tests in `zoom-sessions.test.ts` |
| **M1** | Zoom webhook processing without secret | Fail closed: 503 when `ZOOM_WEBHOOK_SECRET_TOKEN` unset; 401 on bad signature | `backend/src/zoom-routes.ts` |
| **M2** | SSRF on outbound web fetch | `assertPublicHttpUrl` blocks private/metadata targets before fetch | `src/main/tools/ssrf-guard.ts`, `web-fetch.ts` |
| **M3** | Org-key LLM proxy without Hub budget check | `requireOrgKeyBudget` on anthropic/openai/gemini mounts; OpenRouter BYOK exempt | `backend/src/budget-gate.ts`, `backend/src/index.ts` |

**Auth unchanged:** Cognito JWT (`requireCognito`) remains the HTTP API gate; this turn hardens edges (ZIP, WS, pairing, Feishu scope, Zoom UUID, webhooks, SSRF, budget).
