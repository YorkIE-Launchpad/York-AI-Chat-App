# Preview artifact removal report

Integration UI root = development repository root (`development-1/`, `uiRoot: .`). No nested `frontend/` / `Frontend/`.

| File | Action | Reason |
| --- | --- | --- |
| — | none | No `DUMMY:` markers in `src/` |
| — | none | No `MOCK_AUTH` / `SKIP_AUTH` / `USE_MOCK` / `VITE_USE_MOCK` / demo login shortcuts |
| — | none | No demo seed scripts under `backend/` |
| `tests/**`, `src/tests/**` | keep | Vitest fixtures — not preview runtime data |
| `src/renderer/hooks/useIPC.ts` browser stubs | keep | Electron→browser fallback paths, not preview auth/demo DB |

Field shapes for API contracts: unchanged this turn (security remediation only; Cognito + Zoom + LLM proxy contracts already live).

```
Post-cleanup scan: 0 leftover(s)
```
