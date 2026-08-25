/**
 * Natural-language skill injection: when the user asks for LaunchPad, company OS,
 * HTML artifacts, or goal loops without a `/skill:…` slash, inject the skill body
 * (plus one matching reference file for york-os) so weaker models cannot skip loading it.
 *
 * In Project workspace division, LaunchPad injection can be forced on every turn.
 */
import * as fs from 'fs';
import * as path from 'path';
import { stripFrontmatter } from '@mariozechner/pi-coding-agent';
import type { ExpandableSkillRef } from './slash-skill-expand';

export const LAUNCHPAD_SKILL_NAME = 'rnd-launchpad-mcp-sdlc';
export const YORK_OS_SKILL_NAME = 'york-os';
export const HTML_ARTIFACT_SKILL_NAME = 'html-artifact';
export const GOAL_RUNNER_SKILL_NAME = 'goal-runner';

const LAUNCHPAD_SKILL_BLOCK_RE = new RegExp(`<skill\\s+name=["']${LAUNCHPAD_SKILL_NAME}["']`, 'i');
const YORK_OS_SKILL_BLOCK_RE = new RegExp(`<skill\\s+name=["']${YORK_OS_SKILL_NAME}["']`, 'i');
const HTML_ARTIFACT_SKILL_BLOCK_RE = new RegExp(
  `<skill\\s+name=["']${HTML_ARTIFACT_SKILL_NAME}["']`,
  'i'
);
const GOAL_RUNNER_SKILL_BLOCK_RE = new RegExp(
  `<skill\\s+name=["']${GOAL_RUNNER_SKILL_NAME}["']`,
  'i'
);

const SKILL_BLOCK_RE = /<skill\s+name=["'][^"']+["'][\s\S]*?<\/skill>/gi;
const REFERENCE_CHAR_CAP = 12_000;

export type LaunchPadSkillExpandOptions = {
  /**
   * When true (Project workspace), always inject the skill body if available,
   * regardless of natural-language delivery intent.
   */
  force?: boolean;
};

export type SkillIntentExpandResult = {
  expanded: boolean;
  text: string;
  /** Skill XML block only (no user prompt). */
  block?: string;
  skillName?: string;
  reason?: 'force' | 'intent';
  reference?: YorkOsReferenceKind | null;
};

export type YorkOsReferenceKind =
  | 'meeting-prep'
  | 'work-brief'
  | 'client-status'
  | 'project-status'
  | 'confluence'
  | 'core';

const YORK_OS_REFERENCE_FILE: Record<
  Exclude<YorkOsReferenceKind, 'confluence' | 'core'>,
  string
> = {
  'meeting-prep': 'references/meeting-prep.md',
  'work-brief': 'references/work-brief.md',
  'client-status': 'references/client-status.md',
  'project-status': 'references/project-status.md',
};

function stripSkillBlocks(prompt: string): string {
  return (prompt || '').replace(SKILL_BLOCK_RE, '').trim();
}

/**
 * LaunchPad implement / preview / release delivery intent.
 * Tuned for asks like "Implement NFL games with FC4 format on preview".
 * Ignores leading skill blocks when the prompt was already expanded.
 */
export function isLaunchPadDeliveryIntent(prompt: string): boolean {
  const text = stripSkillBlocks(prompt);
  if (!text) return false;

  if (/\blaunch\s*pad\b|\blaunchpad\b/i.test(text)) return true;

  if (
    /\b(start_preview|start_scope_implement|seed_release|lock_release|set_release_scope)\b/i.test(
      text
    )
  ) {
    return true;
  }

  // FC format cards (e.g. FC4) often appear in FanCrypto-style preview asks.
  if (/\bfc\d+\b/i.test(text) && /\b(implement|preview|format|games?|logos?)\b/i.test(text)) {
    return true;
  }

  if (/\b(implement|build)\b/i.test(text) && /\bpreview\b/i.test(text)) return true;

  if (
    /\b(implement|ship|seed|lock|scope)\b/i.test(text) &&
    /\b(release|revision|version|feature|bug|qa)\b/i.test(text)
  ) {
    return true;
  }

  if (/\bon\s+preview\b/i.test(text) && /\b(implement|add|show|build|fix|games?)\b/i.test(text)) {
    return true;
  }

  return false;
}

function hasSkillBlock(prompt: string, blockRe: RegExp): boolean {
  return blockRe.test(prompt || '');
}

function findSkill(skills: ExpandableSkillRef[], name: string): ExpandableSkillRef | undefined {
  return skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
}

function readTextIfSafe(baseDir: string, relativePath: string): string | null {
  const resolvedBase = path.resolve(baseDir);
  const resolvedFile = path.resolve(baseDir, relativePath);
  if (resolvedFile !== resolvedBase && !resolvedFile.startsWith(resolvedBase + path.sep)) {
    return null;
  }
  try {
    if (!fs.existsSync(resolvedFile)) return null;
    const raw = fs.readFileSync(resolvedFile, 'utf-8');
    const body = stripFrontmatter(raw).trim();
    if (!body) return null;
    if (body.length <= REFERENCE_CHAR_CAP) return body;
    return `${body.slice(0, REFERENCE_CHAR_CAP).trim()}\n\n…[truncated]`;
  } catch {
    return null;
  }
}

function buildSkillBlock(skill: ExpandableSkillRef, extraMarkdown?: string | null): string | null {
  const body = readTextIfSafe(skill.baseDir, path.basename(skill.filePath));
  if (!body) {
    try {
      const content = fs.readFileSync(skill.filePath, 'utf-8');
      const fallback = stripFrontmatter(content).trim();
      if (!fallback) return null;
      const extra = extraMarkdown?.trim()
        ? `\n\n${extraMarkdown.trim()}`
        : '';
      return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${fallback}${extra}\n</skill>`;
    } catch {
      return null;
    }
  }
  const extra = extraMarkdown?.trim() ? `\n\n${extraMarkdown.trim()}` : '';
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}. Read other files under that directory only if needed.\n\n${body}${extra}\n</skill>`;
}

function wrapExpanded(
  prompt: string,
  skill: ExpandableSkillRef,
  extraMarkdown?: string | null,
  extras?: Partial<SkillIntentExpandResult>
): SkillIntentExpandResult {
  const block = buildSkillBlock(skill, extraMarkdown);
  if (!block) {
    return { expanded: false, text: prompt };
  }
  return {
    expanded: true,
    text: `${block}\n\n${prompt}`,
    block,
    skillName: skill.name,
    reason: 'intent',
    ...extras,
  };
}

/**
 * Prepend the full LaunchPad skill block when appropriate.
 *
 * - Always (if skill available) when `options.force` is true — Project workspace.
 * - Otherwise when the prompt looks like LaunchPad delivery work.
 * No-ops when the skill block is already present or the skill is unavailable.
 */
export function expandLaunchPadSkillIntent(
  prompt: string,
  skills: ExpandableSkillRef[],
  options?: LaunchPadSkillExpandOptions
): SkillIntentExpandResult {
  if (hasSkillBlock(prompt, LAUNCHPAD_SKILL_BLOCK_RE)) {
    return { expanded: false, text: prompt };
  }

  const force = options?.force === true;
  if (!force && !isLaunchPadDeliveryIntent(prompt)) {
    return { expanded: false, text: prompt };
  }

  const skill = findSkill(skills, LAUNCHPAD_SKILL_NAME);
  if (!skill) {
    return { expanded: false, text: prompt };
  }

  const result = wrapExpanded(prompt, skill);
  if (result.expanded) {
    result.reason = force ? 'force' : 'intent';
  }
  return result;
}

/**
 * Confluence / wiki document creation intent.
 * Tuned for asks like "Create a Confluence page about resource performance issues".
 */
export function isConfluenceDocumentIntent(prompt: string): boolean {
  const text = stripSkillBlocks(prompt);
  if (!text) return false;

  if (/\bconfluence\b/i.test(text)) return true;
  if (/\bwiki\s+page\b/i.test(text)) return true;
  if (/\batlassian\s+page\b/i.test(text)) return true;
  if (/\bcreate\b[\s\S]{0,80}\bpage\b[\s\S]{0,80}\bconfluence\b/i.test(text)) return true;
  if (/\bdocument\b[\s\S]{0,80}\bconfluence\b/i.test(text)) return true;
  if (/\bconfluence\b[\s\S]{0,80}\bpage\b/i.test(text)) return true;
  if (/\bwiki\b/i.test(text) && /\b(create|write|publish|document)\b/i.test(text)) return true;

  return false;
}

function isVisualCreateAsk(text: string): boolean {
  return (
    /\b(create|make|build|write|draft|design)\b/i.test(text) &&
    /\b(presentation|deck|slides?|one[-\s]?pager|landing\s+page|dashboard\s+mock|handout|report\s+page|microsite|interactive\s+(handout|explainer))\b/i.test(
      text
    )
  );
}

/**
 * Classify company-OS asks so we inject york-os plus at most one playbook file.
 * Returns null when the prompt is not a company/work ask.
 */
export function classifyYorkOsIntent(prompt: string): YorkOsReferenceKind | null {
  const text = stripSkillBlocks(prompt);
  if (!text) return null;

  if (isConfluenceDocumentIntent(text)) return 'confluence';

  // Visual HTML artifacts are not york-os (unless Confluence, already handled).
  if (isVisualCreateAsk(text) && !/\b(confluence|atlassian|wiki)\b/i.test(text)) {
    return null;
  }

  if (
    /\b(prep(are)?|agenda)\b/i.test(text) &&
    /\b(meeting|meetings|week|today|tomorrow|calendar)\b/i.test(text)
  ) {
    return 'meeting-prep';
  }
  if (/\bprep(are)?\s+(for|my|this)\b/i.test(text) && /\bmeeting/i.test(text)) {
    return 'meeting-prep';
  }

  if (
    /\b(client\s+status|update on (the\s+)?client|how is (the\s+)?client|status of (the\s+)?client)\b/i.test(
      text
    )
  ) {
    return 'client-status';
  }

  if (
    /\b(project\s+status|how is (the\s+)?project|update on (the\s+)?project|status of (the\s+)?project)\b/i.test(
      text
    )
  ) {
    return 'project-status';
  }

  if (
    /\b(catch me up|brief me|what'?s going on|open loops?|what did i promise|follow-?ups?|commitments?|action items?)\b/i.test(
      text
    )
  ) {
    return 'work-brief';
  }

  if (
    /\b(who('?s| is) out|on leave|wfh|work from home|timesheet|staffing|allocation|org chart|list_employees|search_organization)\b/i.test(
      text
    )
  ) {
    return 'core';
  }

  if (/\bleave policy\b/i.test(text) || /\b(hub|people|hr|employee)\b/i.test(text)) {
    return 'core';
  }

  if (
    /\b(schedule|book|set up|set a)\b/i.test(text) &&
    /\b(meeting|invite|calendar)\b/i.test(text)
  ) {
    return 'core';
  }

  if (
    /\b(slack|gmail|google calendar|calendar invite|jira|confluence|drive)\b/i.test(text) &&
    /\b(search|send|post|email|message|schedule|status|find|what)\b/i.test(text)
  ) {
    return 'core';
  }

  return null;
}

export function isYorkOsCompanyIntent(prompt: string): boolean {
  return classifyYorkOsIntent(prompt) != null;
}

function yorkOsReferenceMarkdown(
  skill: ExpandableSkillRef,
  kind: YorkOsReferenceKind
): string | null {
  if (kind === 'confluence' || kind === 'core') return null;
  const relative = YORK_OS_REFERENCE_FILE[kind];
  const body = readTextIfSafe(skill.baseDir, relative);
  if (!body) return null;
  return `## Loaded playbook: ${relative}\nFollow this for this turn. Do not load the rest of the skill tree unless needed.\n\n${body}`;
}

/**
 * Prepend york-os (and at most one matching reference playbook) for company/work asks.
 */
export function expandYorkOsSkillIntent(
  prompt: string,
  skills: ExpandableSkillRef[]
): SkillIntentExpandResult {
  if (hasSkillBlock(prompt, YORK_OS_SKILL_BLOCK_RE)) {
    return { expanded: false, text: prompt };
  }

  const kind = classifyYorkOsIntent(prompt);
  if (!kind) {
    return { expanded: false, text: prompt };
  }

  const skill = findSkill(skills, YORK_OS_SKILL_NAME);
  if (!skill) {
    return { expanded: false, text: prompt };
  }

  return wrapExpanded(prompt, skill, yorkOsReferenceMarkdown(skill, kind), { reference: kind });
}

export function isHtmlArtifactIntent(prompt: string): boolean {
  const text = stripSkillBlocks(prompt);
  if (!text) return false;
  if (/\b(pptx|docx|xlsx|pdf|powerpoint|ms\s*word|excel)\b/i.test(text)) return false;
  if (isConfluenceDocumentIntent(text)) return false;
  return isVisualCreateAsk(text);
}

export function expandHtmlArtifactSkillIntent(
  prompt: string,
  skills: ExpandableSkillRef[]
): SkillIntentExpandResult {
  if (hasSkillBlock(prompt, HTML_ARTIFACT_SKILL_BLOCK_RE)) {
    return { expanded: false, text: prompt };
  }
  if (!isHtmlArtifactIntent(prompt)) {
    return { expanded: false, text: prompt };
  }
  const skill = findSkill(skills, HTML_ARTIFACT_SKILL_NAME);
  if (!skill) {
    return { expanded: false, text: prompt };
  }
  return wrapExpanded(prompt, skill);
}

export function isGoalRunnerIntent(prompt: string): boolean {
  const text = stripSkillBlocks(prompt);
  if (!text) return false;
  if (/\bGOAL_STATUS\b/.test(text)) return true;
  if (/\bcontinue working toward (this |the )?goal\b/i.test(text)) return true;
  if (/\bkeep going until done\b/i.test(text)) return true;
  if (/\bfinish (this |the )?goal\b/i.test(text)) return true;
  if (/\bmake tests pass\b/i.test(text)) return true;
  if (/\bship (this |the |a )?fix\b/i.test(text)) return true;
  if (/^\/goal\b/i.test(text)) return true;
  return false;
}

export function expandGoalRunnerSkillIntent(
  prompt: string,
  skills: ExpandableSkillRef[]
): SkillIntentExpandResult {
  if (hasSkillBlock(prompt, GOAL_RUNNER_SKILL_BLOCK_RE)) {
    return { expanded: false, text: prompt };
  }
  if (!isGoalRunnerIntent(prompt)) {
    return { expanded: false, text: prompt };
  }
  const skill = findSkill(skills, GOAL_RUNNER_SKILL_NAME);
  if (!skill) {
    return { expanded: false, text: prompt };
  }
  return wrapExpanded(prompt, skill);
}
