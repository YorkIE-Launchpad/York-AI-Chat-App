# Frontend tree parity

| Field | Value |
| --- | --- |
| **ok** | true |
| **expectedRoot** | `.` (development-1 repo root) |
| **actualRoot** | `.` |
| **missingPaths** | _(none)_ |

## Notes

The customer product UI is an **Electron + Vite** desktop app rooted at `development-1/` (`src/renderer`, `src/main`, Vite config at repo root). There is **no** separate `frontend/` integration folder. Parity is satisfied at the repo root; backend deliverables live under `backend/` only.
