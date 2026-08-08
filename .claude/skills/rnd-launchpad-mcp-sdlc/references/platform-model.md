# LaunchPad platform model

How the product works — use this before inventing workflows. MCP tools are thin
REST adapters over the same rules.

Continuous agent automaton: [continuous-loop.md](continuous-loop.md).

## Release loop (canonical forever-spine)

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
(up to ~30 min — keep polling)
    ↓
list_releases → new active (often empty)
    ↓
seed again → work → lock → …  (continuous agents never “idle complete” mid-goal)
```

### Operating rules

1. Exactly **one active** release per project. Keep others **draft** (or `locked` / `skip`).
2. If active has **no revision**, add one from last tag: `seed_release_from_prior` `mode: "baseline_copy"`.
3. Do all Build/Validate writes on that **active** line only.
4. When cycle done for shipping → **`lock_release`** (`confirm: true`).
5. Wait for lock backend agent when started: poll **`get_release_lock_status`** (not SSE).
6. Platform often auto-creates next **patch active empty** after lock. Seed it, then continue.
7. Never seed/implement on a **locked** release id.

---

## Four phases (10 stages)

| Phase | Stages | Purpose |
| ----- | ------ | ------- |
| **Discover** | Capture, Profiles, Documents, Brief | Client context, notes, docs, PRD |
| **Plan** | Backlog, Releases | Epics/stories; release lines and scope |
| **Build** | Frontend, Backend, Cloud | Revisions, implement, migrate, preview, deploy |
| **Validate** | QA | QA chats/reports; feedback loop (rewinds to Build) |

UI journey maps stages onto URL `section`/`area`. MCP agents do not need URLs —
they use phase + tool map instead.

### Stage completion heuristics (agent sensors)

| Stage | Prefer tools | “Done enough” heuristic |
| ----- | ------------ | ----------------------- |
| Capture | notes, questionnaire, ingest | Materials exist for goal context |
| Profiles | client details / enrich | Non-empty client/product fields |
| Documents / Brief | docs, PRD, summary | Artifact exists or explicit skip |
| Backlog | epics/stories/suggestions | Stories cover current goal increment |
| Releases | list/create/activate/scope | One active + scope for increment |
| Frontend | seed, implement platform, preview, migrate | New Rn + preview ready |
| Backend | backend code chat / understand | Only if goal requires; session progressed |
| Cloud | deploy map + cloud deploy | Only if goal requires; deploy terminal |
| QA | QA chat/reports/feedback | Run evidence or accepted residual |

Cadence inside Plan→Build→Validate→Ship:

```
ensure active → seed if empty → scope → implement → preview → validate → lock → wait → seed next
```

---

## Releases vs revisions

| Concept | Identity | Role |
| ------- | -------- | ---- |
| **Release** | Semver-style `name` (`1.0.0`, `1.0.1`) | Lifecycle: draft / active / locked / skip |
| **Revision** | `R1`, `R2`, … (`ProjectVersion`) | Immutable build history; `gitTag` |
| **Live build** | One live version project-wide | Latest revision on the **active** release |

```
Project
  └── Release 1.0.0 (locked after ship)
        ├── R1 … Rn
  └── Release 1.0.1 (active, often starts with ZERO revisions)
        └── seed baseline_copy → R1 → work → …
```

---

## Status meanings

| Status | Meaning | Agent rules |
| ------ | ------- | ----------- |
| **draft** | Not live | Activate only when this becomes the work line |
| **active** | Current live line | Seed / implement / preview / QA here |
| **locked** | Frozen; cannot unlock | No new revisions; switch to next active |
| **skip** | Roadmap placeholder | Not a seed baseline |

---

## When revisions are created

- `seed_release_from_prior` (`baseline_copy` or `agent`)
- Scope implement / migrate / cursor agents / ZIP upload (UI only for multipart)

**Empty active** (post-lock or new patch): always prefer `baseline_copy` from last tagged prior head.

---

## Version tools

| Tool | Behavior |
| ---- | -------- |
| `list_versions` | List revisions |
| `switch_version` | Temporary preview only — not live |
| `activate_version` | Make revision live (must be on active release) |

---

## Scope implement

Release must be **active**.

- **Default target:** `platform` — LaunchPad frontend/preview.
- Prefer **`execution: "sequential"`** (separate PR per story). Batch modes:
  `sequential_agents_shared_pr`, `parallel_agents_separate_prs`, `single_agent_shared_pr`.
- Pass `items[].sortOrder`. Poll for **hours**. Progress: done/total.

**After implement on development:** lock with **`skipLockAgentOperations: true`**.

**After implement on platform:** normal lock + poll ~30 min.

---

## Lock + wait

`lock_release` may start a backend plan agent.

| Situation | Lock behavior |
| --------- | ------------- |
| Implement was **`platform`** | Normal lock → poll **`get_release_lock_status`** ~30 min |
| Implement was **`development`** | `skipLockAgentOperations: true` — no backend agent |

| Tool | Use |
| ---- | --- |
| `get_release_lock_status` | Poll: `locked`, `lockPending`, `agentActive`, `skipLockAgentOperations`, `readyForNextCycle` |
| Do **not** use | SSE streams (excluded from MCP) |

After ready: `list_releases` → new `active` → seed.

**Migrate frontend** is separate Build work, not a lock prerequisite.

---

## Repos (two ideas)

| Surface | Typical use |
| ------- | ----------- |
| **Platform / Launchpad repo** | Frontend preview, default implement target, migrate target |
| **Development / backend repo** | Backend Code chat, architecture, infra, cloud agents |

Default all UI/preview goals to **platform**.

---

## Create / activate release fields

`create_release` requires `projectId`, `name`, `startDate`, `releaseDate` (`yyyy-MM-dd` or ISO; target ≥ start).

`activate_release` and `update_release_status` require **`reason`**. `update_release` field patches need **`reason`**.

---

## Continuous agent completeness

A continuous SDLC agent treats:

- **Journey phases** as *what work class* to choose.
- **Release loop** as *where artifacts land*.
- **GOAL_STATUS complete** only when the *user goal* is fully evidenced — not after a single lock.
