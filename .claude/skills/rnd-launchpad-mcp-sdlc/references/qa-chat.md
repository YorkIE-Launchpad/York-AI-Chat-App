# GrowthOS / website QA Chat + Mac QA runner

Complete testing from GrowthOS uses LaunchPad MCP. Prefer **website QA Chat**
(`qa_chat_*` / `qa_browser_*`) when browsing the live app, creating tests from a
session, auto-heal, or choosing browser vs headless. Prefer **Mac/module** tools
(`generate_qa_tests` / `run_qa_tests`) for topic→chat workspaces and ZIP imports.

Guide: `get_qa_user_guide` with `section: "qa-chat"` or `"mcp"`.

---

## Decision matrix

| Intent                                                           | Tools                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Browse app, Create tests, browser vs headless, auto-heal in chat | `qa_chat_*` + `qa_browser_*`                                                               |
| Modules, ZIP import, topic workspace, Mac parity                 | `generate_qa_tests` / `run_qa_tests` + `list_qa_topics`                                    |
| “Run tests on project X” without saying QA Chat                  | `list_qa_projects` → `run_qa_tests({ projectId })` → pick module/chat from `needs_input`   |
| Headless login missing                                           | Website Link session **or** `start_qa_login` → `finish_qa_login` → `check_qa_auth_session` |
| Failures → shippable bugs                                        | `move_qa_report_to_feedback` **or** `create_feedback` for a new agent-filed bug → AI fix   |

Do **not** treat Mac `send_qa_chat_message` / `list_qa_chats(topicId)` as the website
QA Chat. Those are a separate topic→message workspace.

---

## Website QA Chat — complete GrowthOS loop

```
qa_chat_workspace(projectId)          # env / persona / URL ids
→ qa_chat_create (or qa_chat_list)
→ qa_browser_set_selection(env, persona, urlName?; confirm=true)
   # or pass selection on qa_chat_send_message / qa_browser_start
→ qa_chat_send_message({ prompt, createTests?: true })
→ POLL qa_chat_get / qa_chat_agent_status every 3–5s until assistant completed|failed
→ if createTests produced specs:
     qa_chat_run_tests({ messageId, mode: headless|browser, autoHeal? })
     → POLL qa_chat_test_run_status until done=true
→ show result table / autoHeal summary as returned (do not rewrite as long prose)
→ failures that are app bugs → create_feedback OR move_qa_report_to_feedback
     → start_feedback_ai_fix → Build rewind → re-run QA
```

### Tool notes

| Tool                                                                                         | Notes                                                                                                |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `qa_chat_send_message`                                                                       | Browse-only by default. `createTests=true` = website “Create tests” (needs env + persona).           |
| `qa_chat_run_tests`                                                                          | `mode=headless` (default, qa-runner) or `browser` (live chat browser). `autoHeal=true` max 3 rounds. |
| `qa_chat_test_run_status`                                                                    | Poll until `done=true`. With autoHeal, `done` stays false until heal loop ends.                      |
| `qa_browser_set_selection`                                                                   | `confirm: true`; restarts browser if env/persona changes.                                            |
| `qa_chat_stop_generation` / `qa_browser_stop` / `qa_chat_delete` / `qa_chat_cancel_test_run` | Destructive — `confirm: true`                                                                        |

### Full Validate from GrowthOS (minimum)

1. Active release + ≥1 revision; preview healthy if UI under test.
2. Run website QA Chat loop above for the goal flows (login, happy path, regressions).
3. Optional: `run_client_link_verify` → poll.
4. Optional visual: `get_qa_visual_testing_readiness` → `list_qa_visual_compare_runs` / `run_qa_visual_test`.
5. Failures → **new** feedback (`create_feedback` or move tools) → AI fix → preview snapshot → **re-QA**.
6. Green → Ship; Deploy only if `get_deploy_map` has environments — see SKILL.md.

---

## Mac / module runner loop

```
get_qa_runner_health
→ generate_qa_tests({ projectId, prompt, topicId|topicName, … })
→ POLL get_qa_generation_status(messageId)
→ check_qa_auth_session if login needed
→ run_qa_tests({ projectId, messageId|topicId|chatId, autoHeal? })
→ POLL get_qa_test_run_status(runId)
→ get_qa_playwright_report_url when available
```

`generate_qa_tests` / `run_qa_tests` may return `needs_input` + `questionsForUser` —
reply to the user with **only** that numbered list (short), then re-call with answers.

`send_qa_chat_message` (Mac) still works but prefer `generate_qa_tests` for module-first flows.

---

## Failures → feedback (new vs same)

| Situation                                       | Action                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| New QA failure / new agent-noticed bug          | `move_qa_report_to_feedback` **or** `create_feedback` → **new** UUID → `start_feedback_ai_fix` |
| Same QA message + same failureIndex             | move returns same UUID (`created: false`) → fix that UUID                                      |
| User asks GrowthOS to fix a **different** issue | Always `create_feedback` — never `update_feedback` on an unrelated old ticket                  |
| Retry same filed bug after COMPLETED/FAILED     | Same UUID: optional `update_feedback` (clearer repro) → `start_feedback_ai_fix`                |

---

## Monitor matrix (QA)

| Start                                          | Poll                                   | Next                                 |
| ---------------------------------------------- | -------------------------------------- | ------------------------------------ |
| `qa_chat_send_message`                         | `qa_chat_get` / `qa_chat_agent_status` | `qa_chat_run_tests` if specs created |
| `qa_chat_run_tests` / `fix_qa_failed_tests`    | `qa_chat_test_run_status`              | feedback / re-QA                     |
| `generate_qa_tests`                            | `get_qa_generation_status`             | `run_qa_tests`                       |
| `run_qa_tests`                                 | `get_qa_test_run_status`               | report / feedback                    |
| `start_qa_test_import`                         | `get_qa_import_job_status`             | run QA                               |
| `start_qa_tests_export` / `start_qa_export_pr` | export / PR status                     | share URL                            |
