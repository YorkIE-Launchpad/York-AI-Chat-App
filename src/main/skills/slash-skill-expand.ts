/**
 * Expand Claude-style `/skill-name` (and pi `/skill:name`) prompts into a full
 * `<skill>` block before history/preamble is prepended. Also expands `@skill-name`
 * mentions anywhere in the prompt (prepends skill body, keeps the user text).
 */
import * as fs from 'fs';
import * as path from 'path';
import { stripFrontmatter } from '@mariozechner/pi-coding-agent';

const SLASH_SKILL_RE = /^\/(?:skill:)?([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i;
/** `@skill-name` mentions (not email-like: requires a word boundary after). */
const AT_SKILL_MENTION_RE = /(^|[\s([{])@([a-z0-9][a-z0-9-]*)\b/gi;

export interface ExpandableSkillRef {
  name: string;
  filePath: string;
  baseDir: string;
}

/**
 * Discover SKILL.md entries under the given skill root directories
 * (same layout pi's DefaultResourceLoader expects).
 */
export function discoverSkillsFromPaths(skillPaths: string[]): ExpandableSkillRef[] {
  const byName = new Map<string, ExpandableSkillRef>();

  for (const root of skillPaths) {
    if (!root || !fs.existsSync(root)) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const entryPath = path.join(root, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = fs.statSync(entryPath).isDirectory();
        } catch {
          continue;
        }
      }
      if (!isDirectory) continue;

      const skillMdPath = path.join(entryPath, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;

      let name = entry.name;
      try {
        const content = fs.readFileSync(skillMdPath, 'utf-8');
        const frontMatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        const frontMatter = frontMatterMatch ? frontMatterMatch[1] : '';
        const nameMatch = frontMatter.match(/name:\s*["']?([^"'\r\n]+)["']?/);
        if (nameMatch?.[1]) {
          name = nameMatch[1].trim();
        }
      } catch {
        // keep directory name
      }

      byName.set(name.toLowerCase(), {
        name,
        filePath: skillMdPath,
        baseDir: entryPath,
      });
    }
  }

  return Array.from(byName.values());
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
 * If `prompt` is a slash skill invoke that matches a known skill, expand it to
 * a `<skill>` block (plus optional args). Otherwise return the original prompt.
 */
export function expandSlashSkillPrompt(
  prompt: string,
  skills: ExpandableSkillRef[]
): { expanded: boolean; text: string; skillName?: string } {
  const trimmed = prompt.trim();
  const match = trimmed.match(SLASH_SKILL_RE);
  if (!match) {
    return { expanded: false, text: prompt };
  }

  const skillName = match[1];
  const args = (match[2] ?? '').trim();
  const skill = skills.find((s) => s.name.toLowerCase() === skillName.toLowerCase());
  if (!skill) {
    return { expanded: false, text: prompt };
  }

  const skillBlock = buildSkillBlock(skill);
  if (!skillBlock) {
    return { expanded: false, text: prompt };
  }
  const text = args ? `${skillBlock}\n\n${args}` : skillBlock;
  return { expanded: true, text, skillName: skill.name };
}

/**
 * Expand `@skill-name` mentions: prepend full skill body blocks for each unique
 * matching mention so mid-sentence skill references load reliably.
 */
export function expandAtSkillMentions(
  prompt: string,
  skills: ExpandableSkillRef[]
): { expanded: boolean; text: string; skillNames: string[] } {
  if (!prompt || skills.length === 0) {
    return { expanded: false, text: prompt, skillNames: [] };
  }

  const names = new Set<string>();
  AT_SKILL_MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AT_SKILL_MENTION_RE.exec(prompt)) !== null) {
    names.add(match[2].toLowerCase());
  }
  if (names.size === 0) {
    return { expanded: false, text: prompt, skillNames: [] };
  }

  const blocks: string[] = [];
  const skillNames: string[] = [];
  for (const name of names) {
    const skill = skills.find((s) => s.name.toLowerCase() === name);
    if (!skill) continue;
    const block = buildSkillBlock(skill);
    if (!block) continue;
    if (prompt.includes(`<skill name="${skill.name}"`)) continue;
    blocks.push(block);
    skillNames.push(skill.name);
  }

  if (blocks.length === 0) {
    return { expanded: false, text: prompt, skillNames: [] };
  }

  return {
    expanded: true,
    text: `${blocks.join('\n\n')}\n\n${prompt}`,
    skillNames,
  };
}
