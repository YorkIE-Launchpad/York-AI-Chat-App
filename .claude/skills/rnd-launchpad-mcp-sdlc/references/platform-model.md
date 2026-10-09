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

| Phase        | Stages                              | Purpose                                            |
| ------------ | ----------------------------------- | -------------------------------------------------- |
| **Discover** | Capture, Profiles, Documents, Brief | Client context, notes, docs, PRD                   |
| **Plan**     | Backlog, Releases                   | Epics/stories; release lines and scope             |
| **Build**    | Frontend, Backend, Cloud            | Revisions, implement, migrate, preview, deploy     |
| **Validate** | QA                                  | QA chats/reports; feedback loop (rewinds to Build) |

UI journey maps stages onto URL `section`/`area`. MCP agents do not need URLs —
they use phase + tool map instead.

### Stage completion heuristics (agent sensors)

| Stage             | Prefer tools                                                                  | “Done enough” heuristic                                  |
| ----------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| Capture           | notes, questionnaire, ingest                                                  | Materials exist for goal context                         |
| Profiles          | client details / enrich                                                       | Non-empty client/product fields                          |
| Documents / Brief | docs, PRD, summary                                                            | Artifact exists or explicit skip                         |
| Backlog           | epics/stories/suggestions                                                     | Stories cover current goal increment                     |
| Releases          | list/create/activate/scope                                                    | One active + scope for increment                         |
| Frontend          | seed, implement platform, preview, migrate                                    | New Rn + preview ready                                   |
| Backend           | backend code chat / understand                                                | Only if goal requires; session progressed                |
| Cloud             | deploy map + cloud deploy / CI/CD + deploy monitors                           | Only if goal requires; deploy terminal + monitor verdict |
| QA                | QA chat/reports/feedback, visual compare, Client Link verify, Sentry feedback | Run evidence or accepted residual                        |

Cadence inside Plan→Build→Validate→Ship:

```
ensure active → seed if empty → scope → implement → preview → validate → lock → wait → seed next
```

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

| Status     | Meaning               | Agent rules                                   |
| ---------- | --------------------- | --------------------------------------------- |
| **draft**  | Not live              | Activate only when this becomes the work line |
| **active** | Current live line     | Seed / implement / preview / QA here          |
| **locked** | Frozen; cannot unlock | No new revisions; switch to next active       |
| **skip**   | Roadmap placeholder   | Not a seed baseline                           |

---

## When revisions are created

- `seed_release_from_prior` (`baseline_copy` or `agent`) — needs a prior tagged revision
- `start_first_revision_from_prompt` (Cursor agent) / `create_empty_react_revision` (Vite scaffold) — greenfield, no prior tag
- Scope implement / migrate / cursor agents / ZIP upload (UI only for multipart)

**Empty active** (post-lock or new patch): always prefer `baseline_copy` from last tagged prior head.
**First release ever** (nothing tagged): use the first-revision tools instead of seed.

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

- **Default target:** `platform` — LaunchPad frontend/preview.
- Prefer **`execution: "sequential"`** (separate PR per story). Batch modes:
  `sequential_agents_shared_pr`, `parallel_agents_separate_prs`, `single_agent_shared_pr`.
- Pass `items[].sortOrder`. Poll for **hours**. Progress: done/total.

**After implement on development:** lock with **`skipLockAgentOperations: true`**.

**After implement on platform:** normal lock + poll ~30 min.

---

## Lock + wait

`lock_release` may start a backend plan agent.

| Situation                       | Lock behavior                                            |
| ------------------------------- | -------------------------------------------------------- |
| Implement was **`platform`**    | Normal lock → poll **`get_release_lock_status`** ~30 min |
| Implement was **`development`** | `skipLockAgentOperations: true` — no backend agent       |

| Tool                      | Use                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `get_release_lock_status` | Poll: `locked`, `lockPending`, `agentActive`, `skipLockAgentOperations`, `readyForNextCycle` |
| Do **not** use            | SSE streams (excluded from MCP)                                                              |

After ready: `list_releases` → new `active` → seed.

**Migrate frontend** is separate Build work, not a lock prerequisite.

---

## Repos (two ideas)

| Surface                        | Typical use                                                |
| ------------------------------ | ---------------------------------------------------------- |
| **Platform / Launchpad repo**  | Frontend preview, default implement target, migrate target |
| **Development / backend repo** | Backend Code chat, architecture, infra, cloud agents       |

Default all UI/preview goals to **platform**.

Development repo context (customer-owned):

| Source                              | Tool                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `.launchpad/conventions.md`         | `get_project_conventions` / `validate_project_conventions`                             |
| Existing data model + folder layout | `get_project_schema_inventory` — agents receive the same block; extend existing tables |
| Post-run alignment                  | `get_scope_schema_alignment_report` / `get_release_lock_schema_alignment_report`       |

Preview contract: `.launchpad/preview.json` (`get_preview_manifest` / `update_preview_manifest`);
env vars via `get_preview_env` / `update_preview_env` (secrets write-only).

## Runtime differences

LaunchPad runs on prod AWS ECS and on UAT/local EC2 docker-compose. Some MCP tools
are ECS-only (e.g. `create_preview_direct_link` → 409 elsewhere; check
`get_preview_status.directLinkAvailable`). Fall back to `share_client_link_preview`

- `get_client_link` off ECS.

---

## Create / activate release fields

`create_release` requires `projectId`, `name`, `startDate`, `releaseDate` (`yyyy-MM-dd` or ISO; target ≥ start).

`activate_release` and `update_release_status` require **`reason`**. `update_release` field patches need **`reason`**.

---

## Continuous agent completeness

A continuous SDLC agent treats:

- **Journey phases** as _what work class_ to choose.
- **Release loop** as _where artifacts land_.
- **GOAL_STATUS complete** only when the _user goal_ is fully evidenced — not after a single lock.
