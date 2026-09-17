# Runtime verification

**Mode:** Express (existing Node API under `backend/`)  
**Turn:** Security audit remediation (H1–H5, M1–M3)  
**uiStack:** `web` · **uiRoot:** `.` · **frontendVerifyCommand:** `npx vite build`

## Observed results

| Check | Result |
| --- | --- |
| Backend `npm run build` (`tsc`) | pass |
| Backend `npm run lint` | pass |
| Backend `npm test` | 60 pass |
| Boot + `GET /health` | 200 |
| `GET /models` (no token) | 401 |
| `POST /zoom/webhooks` (no secret) | 503 fail-closed |
| `npx vite build` (repo root) | pass (exit 0) |
| Mock leftover scan (`DUMMY:` / MOCK_* in `src/`) | 0 |

## Auth

Existing Cognito JWT (`requireCognito`) retained. Org-key LLM mounts also run `requireOrgKeyBudget` when `HUB_API_BASE_URL` is set.

## Notes

- Full `npm run build` at repo root is electron-builder packaging; host bundler verify used `npx vite build`.
- Infrastructure / Frontend Hosting: **N/A — existing customer infra** (see `coverage-report.md`).
