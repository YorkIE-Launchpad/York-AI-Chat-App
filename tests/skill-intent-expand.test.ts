import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverSkillsFromPaths } from '../src/main/skills/slash-skill-expand';
import {
  LAUNCHPAD_SKILL_NAME,
  expandLaunchPadSkillIntent,
  isLaunchPadDeliveryIntent,
} from '../src/main/skills/skill-intent-expand';

function writeSkill(root: string, name: string, body: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Test skill\n---\n\n${body}\n`,
    'utf-8'
  );
  return dir;
}

describe('isLaunchPadDeliveryIntent', () => {
  it('matches implement on preview / FC format asks', () => {
    expect(
      isLaunchPadDeliveryIntent(
        'Implement NFL games with FC4 format on preview. Show all the team logos on the card'
      )
    ).toBe(true);
    expect(isLaunchPadDeliveryIntent('Implement through launchpad preview')).toBe(true);
    expect(isLaunchPadDeliveryIntent('build the feature on preview')).toBe(true);
  });

  it('matches release delivery verbs', () => {
    expect(isLaunchPadDeliveryIntent('implement the feature on the release')).toBe(true);
    expect(isLaunchPadDeliveryIntent('seed the empty release')).toBe(true);
    expect(isLaunchPadDeliveryIntent('lock the release when done')).toBe(true);
  });

  it('does not match pure Q&A', () => {
    expect(isLaunchPadDeliveryIntent('what is the weather today?')).toBe(false);
    expect(isLaunchPadDeliveryIntent('how does leave policy work?')).toBe(false);
    expect(isLaunchPadDeliveryIntent('send a slack message to jay')).toBe(false);
  });
});

describe('expandLaunchPadSkillIntent', () => {
  it('injects rnd-launchpad-mcp-sdlc for implement/preview asks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'york-lp-skill-'));
    try {
      writeSkill(root, LAUNCHPAD_SKILL_NAME, '# LaunchPad release loop');
      const skills = discoverSkillsFromPaths([root]);
      const user = 'Implement NFL games with FC4 format on preview';
      const result = expandLaunchPadSkillIntent(user, skills);
      expect(result.expanded).toBe(true);
      expect(result.skillName).toBe(LAUNCHPAD_SKILL_NAME);
      expect(result.text).toContain(`<skill name="${LAUNCHPAD_SKILL_NAME}"`);
      expect(result.text).toContain('# LaunchPad release loop');
      expect(result.text).toContain(user);
      expect(result.text).not.toContain('name: rnd-launchpad-mcp-sdlc');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not expand pure Q&A', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'york-lp-skill-'));
    try {
      writeSkill(root, LAUNCHPAD_SKILL_NAME, '# LaunchPad release loop');
      const skills = discoverSkillsFromPaths([root]);
      const result = expandLaunchPadSkillIntent('how does leave policy work?', skills);
      expect(result.expanded).toBe(false);
      expect(result.text).toBe('how does leave policy work?');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not double-inject when skill block already present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'york-lp-skill-'));
    try {
      writeSkill(root, LAUNCHPAD_SKILL_NAME, '# LaunchPad release loop');
      const skills = discoverSkillsFromPaths([root]);
      const first = expandLaunchPadSkillIntent(
        'Implement NFL games with FC4 format on preview',
        skills
      );
      expect(first.expanded).toBe(true);
      const second = expandLaunchPadSkillIntent(first.text, skills);
      expect(second.expanded).toBe(false);
      expect(second.text).toBe(first.text);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves prompt unchanged when skill is missing', () => {
    const user = 'Implement NFL games with FC4 format on preview';
    const result = expandLaunchPadSkillIntent(user, []);
    expect(result.expanded).toBe(false);
    expect(result.text).toBe(user);
  });
});
