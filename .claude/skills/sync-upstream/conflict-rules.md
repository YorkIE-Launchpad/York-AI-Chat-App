# Upstream sync conflict rules

Use these rules when `/sync-upstream` hits merge conflicts. Do **not** default to always-ours or always-theirs.

Decision order per conflicted file:

1. Classify the conflict (York productization vs shared platform vs both).
2. Prefer the matching rule below.
3. Prefer **combine** when both sides have valuable changes.
4. If still ambiguous, stop and ask the user.

## Prefer York

Keep York when the conflict is about York productization or York-only integrations:

| Area                  | Paths / signals                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branding & packaging  | York IE / VECOS naming, logos, icons, `electron-builder.yml`, `scripts/patch-electron-macos-branding.js`, `resources/**`, website branding (`website/**` brand copy/assets) |
| Auth & backend        | `backend/**`, `src/main/auth/**`, `src/shared/auth-*.ts`, `src/shared/backend-config.ts`, Cognito / Hub OAuth flows                                                         |
| Hub / LaunchPad       | Hub MCP, LaunchPad MCP, Hub Skills Library wiring                                                                                                                           |
| York-only skills/docs | `.claude/skills/launchpad-mcp-sdlc/**`                                                                                                                                      |

Also prefer York for York-only config in root files when the hunk is branding or York service wiring (e.g. `dev:backend`, package `name`/`homepage` pointing at york.ie).

## Prefer upstream

Take upstream when the conflict is about shared platform behavior:

- Bugfixes in shared agent / runtime / MCP plumbing that do **not** remove York hooks
- New upstream files or features with no York equivalent
- Dependency and lockfile updates: take upstream structure, then re-apply York `package.json` additions if dropped (e.g. `backend` scripts, York-specific deps)
- Generic CI / docs improvements unrelated to York branding

## Combine both

When possible, merge intent from both sides:

- Upstream bugfix inside a York-touched file → keep York API / branding / auth wiring; apply the upstream logic fix
- Upstream new feature + York rename → take the feature; re-apply York naming
- Shared file with York auth hooks + upstream refactor → keep the refactor; re-attach York hooks at the new call sites

## Never

- Do not auto-delete York-only directories (`backend/`, Hub/LaunchPad skill trees) just because upstream lacks them
- Do not use `git checkout --ours` / `--theirs` for the whole tree
- Do not drop York Cognito/Hub auth to restore upstream “bring your own API key” defaults without asking
- Do not reintroduce Chinese-only localization or Open Cowork branding that York deliberately removed, unless the user asks

## Quick path hints

```
York-leaning:
  backend/**
  src/main/auth/**
  src/shared/auth-*.ts
  src/shared/backend-config.ts
  scripts/patch-electron-macos-branding.js
  resources/**
  .claude/skills/launchpad-mcp-sdlc/**

Upstream-leaning (unless hunk is York branding/auth):
  src/main/agent/**          # prefer combine: keep York MCP/budget hooks + upstream fixes
  src/main/mcp/**            # prefer combine: keep Hub/LaunchPad paths + upstream fixes
  src/main/claude/**
  src/renderer/**            # prefer combine for UI; York for brand strings/assets
  .github/workflows/**       # upstream unless York-specific workflow exists
  package-lock.json          # upstream base, then restore York package.json extras
```

## Recording decisions

In the final sync report, list each conflicted file with one of:

- `york` — kept York side
- `upstream` — took upstream side
- `combined` — merged both
- `asked` — deferred to user
