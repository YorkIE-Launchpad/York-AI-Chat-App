# Continuous LaunchPad SDLC agent

Design for an agent that **never idle-waits** when tools can advance state:
Discover → Plan → Build → Validate → Ship → next release → repeat, with rewinds.

Use with goal ticks (`goal-runner`) or long single turns. Always re-sense reality
via MCP; prior chat is hints only.

---

## 1. State vector

Compute this every tick **from tools** before acting.

```
projectId
releaseId_active          ← list_releases (status=active)
releaseIds_locked         ← list
revision_latest           ← list_versions (for active)
revision_live             ← isActive / live flag
scope_items               ← get_release_scope
implement_run             ← get_scope_implement_active
preview_status            ← get_preview_status
lock_status               ← get_release_lock_status (if recently locked)
feedback_open             ← list_feedback (open/unfixed)
qa_reports_recent         ← list_qa_reports
integrations              ← get_integrations_status / get_cursor_status
memory_hint               ← get_project_memory (optional)
RESUME_*                  ← last durable line from thread
goal_criteria             ← user/automation goal text
```

Emit compact status:

```
PHASE: …
RELEASE: releaseId=42 status=active name=1.0.3
REVISION: R4 live=R4
NEXT_ACTION: start_scope_implement
```

---

## 2. Phase state machine

```
                    ┌──────────────┐
         ┌─────────►│  DISCOVER    │◄──────── re-capture if facts missing
         │          └──────┬───────┘
         │                 │ handoff_ready
         │                 ▼
         │          ┌──────────────┐
         │   ◄──────│    PLAN      │◄──────── expand scope / new epic
         │          └──────┬───────┘
         │                 │ active + scope (or seed next)
         │                 ▼
         │          ┌──────────────┐
  QA fail │   ┌─────│    BUILD     │◄─────── fix bugs / more stories
  feedback│   │     └──────┬───────┘
         │    │            │ build_done_for_goal
         │    │            ▼
         │    │     ┌──────────────┐
         └────┴─────│  VALIDATE    │
                    └──────┬───────┘
                           │ green_or_accepted_residual
                           ▼
                    ┌──────────────┐
                    │    SHIP      │  lock + wait + list + seed
                    └──────┬───────┘
                           │
                           └──► PLAN/BUILD on NEW active (forever)
```

Phases are **soft** for navigation and **hard** for product gates:

| Soft | Hard |
| ---- | ---- |
| Progress badges, tour order | No Client Link chat / implement without **active + ≥1 revision** |
| May jump stages | Locked release accepts **no** new revisions |
| May skip Discover if facts known | Destructive tools need `confirm: true` |

---

## 3. Decision procedure (every tick)

### Step A — Resume first

If thread has `RESUME: … step=poll_* next=TOOL`:

1. Call `TOOL` / related poll tools.
2. If still running → poll budget → either keep polling or re-park with updated `RESUME:`.
3. If terminal success → jump to Step C with that completion.
4. If terminal failure → recovery matrix (§6) → do not re-seed whole journey.

### Step B — Preflight freshness

If no projectId, auth failed, or releases never listed this session → preflight again.

### Step C — Pick NEXT_ACTION

Evaluate in order; take the **first true** rule.

| Prio | Condition | NEXT_ACTION | Primary tools |
| ---- | --------- | ----------- | ------------- |
| 0 | Auth failure | `blocked_auth` | stop |
| 1 | RESUME poll unfinished | `poll_job` | status tools from matrix |
| 2 | Zero projects / wrong project | `resolve_project` | `list_project_names` |
| 3 | Goal needs discovery AND capture/profiles empty | `discover_intake` | discovery tools |
| 4 | Feature goal AND no epics/stories covering it | `plan_backlog` | backlog + suggestions |
| 5 | No release **active** | `ensure_active_release` | create/activate (reason) |
| 6 | Active has **0** revisions | `seed_baseline` | `seed_release_from_prior` |
| 7 | Active scope items pending implement | `implement_scope` | `start_scope_implement` |
| 8 | Implement running | `poll_implement` | implement status |
| 9 | New Rn but preview not ready | `start_or_fix_preview` | preview tools |
| 10 | Goal is visual parity / fidelity residual | `fidelity_loop` | migrate / platform implement + screenshots |
| 11 | Open feedback bugs and goal is quality | `fix_feedback` | feedback AI fix |
| 12 | Goal includes QA and no recent green run | `run_qa` | QA chat/reports |
| 13 | QA failed items open | `qa_to_feedback_or_fix` | move / fix |
| 14 | Backend architecture in goal + code ready | `backend_or_architecture` | backend chat / understand / infra |
| 15 | Cloud deploy in goal + env ready | `cloud_deploy` | deploy map + cloud deploy |
| 16 | Ship criteria met (or goal says lock when ready) | `ship_lock` | lock + poll |
| 17 | Just locked / next active empty | `seed_next_cycle` | list + seed |
| 18 | Idle with remaining goal work | `expand_scope_or_plan` | suggestions / new stories |
| 19 | Goal fully evidenced | `complete` | GOAL_STATUS complete |

### Step D — Act + poll

Execute NEXT_ACTION with required fields (see pitfalls). After any **start**, poll.

### Step E — Verify + write durable state

Update mental model; write PHASE / NEXT_ACTION / RESUME / GOAL_STATUS.

---

## 4. Phase recipes

### 4.1 Discover — sense and deepen product memory

**Enter when:** greenfield, user said discover, or Plan keeps inventing unknowns.

**Loop:**

1. `get_client_details` / discovery summary if available.
2. Intake: `add_discovery_note`, website `scrape_client_website` / `enrich_client_details`, meetings/granola ingest when connected.
3. `discovery_chat` / `generate_discovery_summary` / `patch_discovery_summary`.
4. Docs/PRD as needed: `generate_prd`, `generate_workspace_document`, `workspace_document_chat`, `sync_prd_from_discovery`.
5. Handoff when: enough context to write epic/stories without fiction **or** goal only required capture notes.

**Do not:** start implement without Plan/release readiness for ship goals.

**Suggested tool chain:**

```
get_client_details → enrich/scrape if empty → add_discovery_note (goal paste)
→ generate_discovery_summary → generate_prd (if missing) → PHASE plan
```

### 4.2 Plan — backlog + one active release + scope

**Enter when:** Discover handoff or mid-product feature request.

**Loop:**

1. `get_backlog_suggestions` → `apply_backlog_suggestion` / create epic+stories.
2. `list_releases` — if none active: `create_release` or `activate_release` + **reason**.
3. Prefer **one** active; leave others draft/locked/skip.
4. `set_release_scope` with stories/items (max 500, structured).
5. Optional: `get_release_feature_suggestions`, `release_suggestion_repo_scan`.

**Exit to Build when:** active exists and (scope non-empty OR seed+agent work without formal stories per goal).

### 4.3 Build — seed → implement → preview → migrate → optional backend/cloud

**Always gate:** active release + revision (seed if empty).

#### Frontend path (default)

```
seed_baseline (if needed)
→ set_release_scope (if needed)
→ start_scope_implement(target=platform, execution=sequential, sortOrder set)
→ POLL get_scope_implement_* / list_versions  (can be HOURS)
→ start_preview → POLL get_preview_status
→ optional fidelity_loop / migrate_frontend
→ optional client feedback path
```

#### Backend path (only if goal/user names Backend Code / development)

```
backend_code_chat_get_session
→ backend_code_chat_send_message(prompt=…, mode=agent)
→ POLL get_session
→ optional generate_understand_graph / run_infra_analysis
```

Lock after development implement uses `skipLockAgentOperations: true`.

#### Cloud path (if in goal)

```
get_deploy_map / prepare_deploy_map / patch_deploy_map
→ run_environment_scan (optional)
→ backend_cloud_deploy_preflight → start_backend_cloud_deploy
→ POLL deploy run
→ optional cloud_debug_chat_* / infra_analysis_chat_*
```

### 4.4 Validate — QA + feedback + rewind

```
get_qa_config / resolve_qa_config
→ create_qa_topic / create_qa_chat if needed
→ send_qa_chat_message → poll get_qa_message / retry_qa_generation
→ list_qa_reports → move_qa_report_to_feedback on fails
→ list_feedback → start_feedback_ai_fix → poll → approve_feedback
→ start_preview / re-QA
```

**Rewind:** open defects with fixable scope → NEXT_ACTION back to Build.

### 4.5 Ship — lock and open next cycle

```
lock_release(confirm=true [, skipLockAgentOperations])
→ get_release_lock_status until locked && !agentActive  (~30 min)
→ list_releases → identify NEW active
→ seed_release_from_prior(mode=baseline_copy) on NEW id
→ NEXT_ACTION implement or plan more work for continuous goals
```

Never implement/seed on locked id.

Continuous product goals rarely `complete` at ship — only when the **user goal**
ends (e.g. “ship 1.2.0 and stop”). Otherwise:

```
GOAL_STATUS: in_progress
NEXT_ACTION: seed_next_cycle | implement_scope | plan_backlog
```

---

## 5. Continuous release generation (24×7)

For goals like “keep shipping improvements”:

1. Maintain a **working backlog** (suggestions + goal-derived stories).
2. Each cycle: slice of stories on active → implement → light QA → lock → seed.
3. Prefer small sequential increments over giant batch all-in-one unless asked.
4. Cap work per cycle (e.g. 1–5 stories) for safer locks.
5. After seed, pick next unfinished scope; if scope empty, generate suggestions
   then apply before idling.
6. Idle only if: no suggestions, no open feedback, goal says “stop when clean”,
   and preview/QA green → then `GOAL_STATUS: complete` or wait for new backlog.

**Never** call complete just because one lock succeeded mid-goal.

---

## 6. Recovery matrix

| Symptom | Action |
| ------- | ------ |
| Agent / conversion not found | Poll `list_versions`, implement active, preview — continue if Rn advanced |
| Implement failed mid-queue | Inspect run; re-run remaining items with sortOrder; don't re-seed |
| Preview stuck / login load | Mock creds; restart_preview; hard retry; capture evidence |
| Seed failed | Retry once; check prior locked baseline exists |
| Lock agent stuck | Keep poll lock status; RESUME poll_lock; do not work locked id |
| Double active (anomaly) | Prefer locking/clarifying; don't create third |
| 401/403 | blocked_auth |
| Budget exceeded | Report spend tools; stop expensive agents |
| Scope empty after lock | Expand plan / suggestions before implementing blank |
| QA timeout | retry_qa_generation |
| Feedback AI fix failed | clarify_feedback_ai_fix or residual note + continue other work |
| Cursor not ready | get_cursor_status / sync; blocked if required |

Retries: **max 2** automatic per action family per cycle, then residual + different tactic or ask.

---

## 7. Poll budgets

| Job class | In-tick preference | Cross-tick park |
| --------- | ------------------ | --------------- |
| Preview start | Always poll to ready | Rare |
| Feedback AI fix | Always poll | Rare |
| Seed | Poll versions until Rn | Rare |
| Lock agent | Poll up to tens of minutes | RESUME poll_lock if needed |
| Scope implement multi-item | Poll long; park if hours + budget | RESUME poll_implement |
| Cloud deploy | Poll to terminal | RESUME poll_deploy |
| Migrate/fidelity | Poll then re-compare in-tick | RESUME poll_migrate |

Poll interval: **5–30s** depending on job; exponential backoff after first minute for long jobs (still keep going).

---

## 8. RESUME schema

```
RESUME: projectId=<int> releaseId=<int> revisionId=<id?> runId=<id?> agentId=<id?> conversionId=<id?> step=<poll_implement|poll_migrate|poll_lock|poll_preview|poll_qa|poll_deploy|poll_feedback|poll_backend|discover|plan|build|validate|ship> next=<mcp_tool_name>
```

Next tick: parse → call `next` → continue state machine (do **not** reset Discover).

---

## 9. Example full night loop (agent narration strip)

1. Sense: active=1.0.4, Rn none → seed baseline → R1  
2. Scope 3 stories → sequential implement → poll 90m → R2 R3  
3. Preview ready → QA chat → 2 fails → feedback AI fix → poll → re-preview  
4. Green → lock → poll 25m → active 1.0.5 empty → seed  
5. New stories from suggestions → implement…  

Status ends each tick with `GOAL_STATUS: in_progress` until goal says stop.

---

## 10. Relationship to other references

| Need | File |
| ---- | ---- |
| Tool names by phase | tool-map.md |
| Exact sequences + JSON samples | workflows.md |
| Release/revision theory | platform-model.md |
| Validation gotchas | pitfalls.md |
