/**
 * Shared TypeSafe Jev constants — version pin and confidence thresholds.
 * Thresholds live in code (not prompts) so they can be tuned per consequence.
 */

/** Version-pinned model for production thresholds. */
export const JEV_MODEL = 'jev-1.13.0';

/** Soft alias for experiments only — prefer JEV_MODEL in product paths. */
export const JEV_MODEL_LATEST = 'jev-latest';

/** Act on Matter keep when confidence >= this. */
export const JEV_MATTER_KEEP_CONFIDENCE = 0.55;

/** Notify OS when notify Noul >= this. */
export const JEV_MATTER_NOTIFY_NOUL = 0.7;

/** Treat live question as answerable when Noul >= this. */
export const JEV_LIVE_ANSWERABLE_NOUL = 0.55;

/** Memory context is sufficient when Noul >= this. */
export const JEV_MEMORY_SUFFICIENT_NOUL = 0.6;

/** Watch condition changed when Noul >= this. */
export const JEV_WATCH_CHANGED_NOUL = 0.55;

/** MCP needed when Noul >= this. */
export const JEV_MCP_NEED_NOUL = 0.45;

/** Sensitive write / ask permission when Noul >= this. */
export const JEV_MCP_WRITE_ASK_NOUL = 0.5;

/** Core memory fact is durable when Noul >= this. */
export const JEV_MEMORY_DURABLE_NOUL = 0.65;

/** Incomplete-turn expects tool action when Noul >= this. */
export const JEV_ACTIONABLE_NOUL = 0.5;

/** SuperContext brief-like when Noul >= this. */
export const JEV_BRIEF_INTENT_NOUL = 0.5;

/** Workflow wants approval / notify / user input when Noul >= this. */
export const JEV_WORKFLOW_FLAG_NOUL = 0.55;

/** Ask-user-question should fire when Noul >= this. */
export const JEV_ASK_USER_NOUL = 0.55;

/** Transcript needs English translation when Noul >= this. */
export const JEV_NEEDS_EN_NOUL = 0.55;

export type JevAutoTier = 'fast' | 'balanced' | 'frontier';

export const JEV_MCP_SERVERS = {
  hub: 'York Hub people, leave, timesheets, projects, clients',
  slack: 'Slack messages, channels, threads',
  gmail: 'Gmail search, read, draft, send',
  calendar: 'Google Calendar events and freebusy',
  drive: 'Google Drive files and docs',
  jira: 'Jira issues and projects',
  confluence: 'Confluence pages and search',
  launchpad: 'R&D LaunchPad delivery tools',
  chrome: 'Browser / Chrome automation',
  other: 'Anything outside the listed servers',
} as const;

export type JevMcpServer = keyof typeof JEV_MCP_SERVERS;
