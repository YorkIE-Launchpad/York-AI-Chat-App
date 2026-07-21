# LaunchPad platform model

How the product works — use this before inventing workflows. MCP tools are thin REST adapters over the same rules.

## Release loop (canonical)

```
Identify active
    ↓
No revision? ──seed_release_from_prior(mode=baseline_copy)──┐
    ↓                                                        │
Work (scope / implement / preview / QA) ←────────────────────┘
    ↓
lock_release(confirm=true)
    ↓
Poll get_release_lock_status until locked && !agentActive
(up to ~30 min — keep polling for minutes or longer)
    ↓
list_releases → new active (often empty)
    ↓
seed again → work → lock → …
```

### Operating rules

1. Exactly **one active** release per project. Keep others **draft** (or `locked` / `skip`). Prefer **lock** the current active before starting a new major line — do not juggle multiple actives for normal shipping.
2. If the active has **no revision**, add one from the **last tag**: `seed_release_from_prior` with `mode: "baseline_copy"`. Use `mode: "agent"` + `promptText` only when the user wants AI changes on top of prior.
3. Do all Build/Validate work on that **active** line only.
4. When the cycle is done → **`lock_release`** (`confirm: true`).
5. **Wait** for the lock backend agent if started: poll **`get_release_lock_status`** (not SSE). Locking can take **up to ~30 minutes** — keep polling for many minutes (or longer); do not treat a few failed checks as failure. Proceed when `locked === true` and `agentActive === false` (or `readyForNextCycle`).
6. Platform often auto-creates the **next patch** as **active empty** (e.g. `1.0.0` locked → `1.0.1` active). Seed that new active from last tag, then loop.
7. Never seed/implement on a **locked** release id.

---

## Four phases (10 stages)

| Phase        | Stages                              | Purpose                                        |
| ------------ | ----------------------------------- | ---------------------------------------------- |
| **Discover** | Capture, Profiles, Documents, Brief | Client context, notes, docs, PRD               |
| **Plan**     | Backlog, Releases                   | Epics/stories; release lines and scope         |
| **Build**    | Frontend, Backend, Cloud            | Revisions, implement, migrate, preview, deploy |
| **Validate** | QA                                  | QA chats/reports; feedback loop                |

Cadence inside Plan→Build: ensure active → seed if empty → scope → implement → preview → (Validate) → lock → wait → seed next.

---

## Releases vs revisions

| Concept        | Identity                               | Role                                      |
| -------------- | -------------------------------------- | ----------------------------------------- |
| **Release**    | Semver-style `name` (`1.0.0`, `1.0.1`) | Lifecycle: draft / active / locked / skip |
| **Revision**   | `R1`, `R2`, … (`ProjectVersion`)       | Immutable build history; `gitTag`         |
| **Live build** | One live version project-wide          | Latest revision on the **active** release |

```
Project
  └── Release 1.0.0 (locked after ship)
        ├── R1 … Rn
  └── Release 1.0.1 (active, often starts with ZERO revisions)
        └── seed baseline_copy → R1 → work → …
```

---

## Status meanings

| Status     | Meaning               | Agent rules                                                      |
| ---------- | --------------------- | ---------------------------------------------------------------- |
| **draft**  | Not live              | Activate only when this becomes the work line (after prior lock) |
| **active** | Current live line     | Seed / implement / preview / QA here                             |
| **locked** | Frozen; cannot unlock | No new revisions; switch to next active                          |
| **skip**   | Roadmap placeholder   | Not a seed baseline                                              |

---

## When revisions are created

- `seed_release_from_prior` (`baseline_copy` or `agent`)
- Scope implement / migrate / cursor agents / ZIP upload (UI only for multipart)

**Empty active** (post-lock or new patch): always prefer `baseline_copy` from last tagged prior head.

---

## Version tools

| Tool               | Behavior                                       |
| ------------------ | ---------------------------------------------- |
| `list_versions`    | List revisions                                 |
| `switch_version`   | Temporary preview only — not live              |
| `activate_version` | Make revision live (must be on active release) |

---

## Scope implement

Release must be **active**.

- **Default target:** `platform` — LaunchPad frontend/preview. Do **not** use `development` unless the user explicitly asks for the development repo.
- Prefer **`execution: "sequential"`** (one agent per story, **separate PR each**). All-in-one modes use `execution: "batch"` with `batchMode`: `sequential_agents_shared_pr` (queue + one shared PR / different commits), `parallel_agents_separate_prs` (parallel, separate PRs), or `single_agent_shared_pr` (one combined prompt). Pass `items[].sortOrder` for run order.
- Start → poll `get_scope_implement_active` / `get_scope_implement_run`. Args: `mode` selected\|all, `execution` sequential\|batch, `batchMode` (when batch), `target` platform\|development, `items[].sortOrder`.

**Duration:** multi-item runs can take **hours**. Keep polling for a long time; progress is `done/total`. Do not treat slow progress as failure.

**After implement on development:** when shipping, lock with **`skipLockAgentOperations: true`** (bypass backend lock agent). Platform implement → normal lock (backend agent, poll up to ~30 min).

---

## Lock + wait

`lock_release` may start a backend plan agent (`backendAgentId` / `backendAgentStatus`).

| Situation                              | Lock behavior                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Implement was **`platform`** (default) | Normal lock → poll **`get_release_lock_status`** up to ~30 min                                         |
| Implement was **`development`**        | `lock_release` with **`skipLockAgentOperations: true`** → immediate lock, no backend agent (York team) |

| Tool                      | Use                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `get_release_lock_status` | Poll: `locked`, `lockPending`, `agentActive`, `skipLockAgentOperations`, `readyForNextCycle` |
| Do **not** use            | `GET …/backend-agent/stream` (SSE — excluded from MCP)                                       |

After ready: `list_releases` → find new `active` → seed.

**Migrate frontend** is a separate Build step, not a lock prerequisite.

---

## Create / activate release fields

`create_release` requires `projectId`, `name`, `startDate`, `releaseDate` (`yyyy-MM-dd` or ISO; target ≥ start).

`activate_release` and `update_release_status` require **`reason`** (audit string). `update_release` field patches also need **`reason`**.
