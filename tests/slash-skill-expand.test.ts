import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  discoverSkillsFromPaths,
  expandSlashSkillPrompt,
} from '../src/main/skills/slash-skill-expand';

function writeSkill(root: string, name: string, body: string, extraFrontmatter = '') {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Test skill\n${extraFrontmatter}---\n\n${body}\n`,
    'utf-8'
  );
  return dir;
}

describe('slash-skill-expand', () => {
  it('discovers skills and expands bare /name and /skill:name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'york-slash-skills-'));
    try {
      writeSkill(root, 'pdf', '# PDF instructions');
      const skills = discoverSkillsFromPaths([root]);
      expect(skills.map((s) => s.name)).toContain('pdf');

      const bare = expandSlashSkillPrompt('/pdf', skills);
      expect(bare.expanded).toBe(true);
      expect(bare.skillName).toBe('pdf');
      expect(bare.text).toContain('<skill name="pdf"');
      expect(bare.text).toContain('# PDF instructions');
      expect(bare.text).not.toContain('name: pdf');

      const withArgs = expandSlashSkillPrompt('/skill:pdf extract tables', skills);
      expect(withArgs.expanded).toBe(true);
      expect(withArgs.text).toContain('# PDF instructions');
      expect(withArgs.text).toContain('extract tables');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves unknown slash commands unchanged', () => {
    const result = expandSlashSkillPrompt('/not-a-skill', []);
    expect(result.expanded).toBe(false);
    expect(result.text).toBe('/not-a-skill');
  });
});
