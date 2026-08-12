/**
 * Natural-language skill injection: when the user asks for LaunchPad delivery
 * work without a `/skill:…` slash, inject the full skill body so weaker models
 * cannot skip loading it.
 *
 * In Project workspace division, injection is mandatory on every turn (not only
 * when NL delivery intent matches).
 */
import * as fs from 'fs';
import { stripFrontmatter } from '@mariozechner/pi-coding-agent';
import type { ExpandableSkillRef } from './slash-skill-expand';

export const LAUNCHPAD_SKILL_NAME = 'rnd-launchpad-mcp-sdlc';
export const YORK_OS_SKILL_NAME = 'york-os';

const LAUNCHPAD_SKILL_BLOCK_RE = new RegExp(`<skill\\s+name=["']${LAUNCHPAD_SKILL_NAME}["']`, 'i');
const YORK_OS_SKILL_BLOCK_RE = new RegExp(`<skill\\s+name=["']${YORK_OS_SKILL_NAME}["']`, 'i');

export type LaunchPadSkillExpandOptions = {
  /**
   * When true (Project workspace), always inject the skill body if available,
   * regardless of natural-language delivery intent.
   */
  force?: boolean;
};

/**
 * LaunchPad implement / preview / release delivery intent.
 * Tuned for asks like "Implement NFL games with FC4 format on preview".
 * Ignores leading skill blocks when the prompt was already expanded.
 */
export function isLaunchPadDeliveryIntent(prompt: string): boolean {
  let text = (prompt || '').trim();
  if (!text) return false;

  // Strip already-injected skill body so re-checks still see delivery intent.
  if (LAUNCHPAD_SKILL_BLOCK_RE.test(text)) {
    const closed = text.lastIndexOf('</skill>');
    if (closed !== -1) {
      text = text.slice(closed + '</skill>'.length).trim();
    }
  }
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

function hasLaunchPadSkillBlock(prompt: string): boolean {
  return LAUNCHPAD_SKILL_BLOCK_RE.test(prompt || '');
}

function buildSkillBlock(skill: ExpandableSkillRef): string | null {
  try {
    const content = fs.readFileSync(skill.filePath, 'utf-8');
    const body = stripFrontmatter(content).trim();
    return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  } catch {
    return null;
  }
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
): { expanded: boolean; text: string; skillName?: string; reason?: 'force' | 'intent' } {
  if (hasLaunchPadSkillBlock(prompt)) {
    return { expanded: false, text: prompt };
  }

  const force = options?.force === true;
  if (!force && !isLaunchPadDeliveryIntent(prompt)) {
    return { expanded: false, text: prompt };
  }

  const skill = skills.find((s) => s.name.toLowerCase() === LAUNCHPAD_SKILL_NAME.toLowerCase());
  if (!skill) {
    return { expanded: false, text: prompt };
  }

  const skillBlock = buildSkillBlock(skill);
  if (!skillBlock) {
    return { expanded: false, text: prompt };
  }

  return {
    expanded: true,
    text: `${skillBlock}\n\n${prompt}`,
    skillName: skill.name,
    reason: force ? 'force' : 'intent',
  };
}

function stripLeadingSkillBlock(prompt: string, blockRe: RegExp): string {
  let text = (prompt || '').trim();
  if (!text || !blockRe.test(text)) {
    return text;
  }
  const closed = text.lastIndexOf('</skill>');
  if (closed !== -1) {
    text = text.slice(closed + '</skill>'.length).trim();
  }
  return text;
}

function hasYorkOsSkillBlock(prompt: string): boolean {
  return YORK_OS_SKILL_BLOCK_RE.test(prompt || '');
}

/**
 * Confluence / wiki document creation intent.
 * Tuned for asks like "Create a Confluence page about resource performance issues".
 */
export function isConfluenceDocumentIntent(prompt: string): boolean {
  const text = stripLeadingSkillBlock(prompt, YORK_OS_SKILL_BLOCK_RE);
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

/**
 * Prepend the full york-os skill block when the prompt looks like Confluence/wiki
 * document work. No-ops when the skill block is already present or unavailable.
 */
export function expandYorkOsSkillIntent(
  prompt: string,
  skills: ExpandableSkillRef[]
): { expanded: boolean; text: string; skillName?: string } {
  if (hasYorkOsSkillBlock(prompt)) {
    return { expanded: false, text: prompt };
  }

  if (!isConfluenceDocumentIntent(prompt)) {
    return { expanded: false, text: prompt };
  }

  const skill = skills.find((s) => s.name.toLowerCase() === YORK_OS_SKILL_NAME.toLowerCase());
  if (!skill) {
    return { expanded: false, text: prompt };
  }

  const skillBlock = buildSkillBlock(skill);
  if (!skillBlock) {
    return { expanded: false, text: prompt };
  }

  return {
    expanded: true,
    text: `${skillBlock}\n\n${prompt}`,
    skillName: skill.name,
  };
}
