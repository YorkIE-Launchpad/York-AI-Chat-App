# Backend Components Coverage Report

**Mode:** Cloud with server preference + **existing customer infrastructure** (no LaunchPad IaC this turn)  
**uiStack:** `web` · **uiRoot:** `.` · **apiRoot:** `backend/`  
**frontendVerifyCommand:** `npx vite build`

| Component | Application (files) | Infrastructure (IaC resources) |
| --- | --- | --- |
| Auth | Existing Cognito JWT — `backend/src/cognito-auth.ts`, `requireCognito` on protected routes | N/A — existing customer infra |
| Network | Express CORS + public Zoom webhook/OAuth; Cognito on remaining routes (`backend/src/index.ts`) | N/A — existing customer infra |
| Compute | Node Express API (`backend/`); Electron main/renderer at repo root | N/A — existing customer infra |
| Storage | N/A — no new upload/object-storage surface this turn | N/A — no uploads |
| Database | N/A — in-memory Zoom session registry only (unchanged architecture) | N/A — existing customer infra |
| Frontend Hosting | Electron desktop app at `uiRoot: .` | N/A — existing customer infra |

## Security remediation (this turn)

See `security-audit-remediation.md` for H1–H5 / M1–M3 file mapping.

## Verify snapshot

- Preview leftovers: **0**
- Backend lint/build/tests: pass (60 tests)
- `GET /health` 200 · `GET /models` 401 · `POST /zoom/webhooks` 503 (no secret)
- `npx vite build`: pass
