import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverSkillsFromPaths } from '../src/main/skills/slash-skill-expand';
import {
  GOAL_RUNNER_SKILL_NAME,
  HTML_ARTIFACT_SKILL_NAME,
  LAUNCHPAD_SKILL_NAME,
  YORK_OS_SKILL_NAME,
  classifyYorkOsIntent,
  expandGoalRunnerSkillIntent,
  expandHtmlArtifactSkillIntent,
  expandLaunchPadSkillIntent,
  expandYorkOsSkillIntent,
  isConfluenceDocumentIntent,
  isGoalRunnerIntent,
  isHtmlArtifactIntent,
  isLaunchPadDeliveryIntent,
  isYorkOsCompanyIntent,
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

  it('treats implement on preview as delivery (not backend opt-in)', () => {
    expect(isLaunchPadDeliveryIntent('Implement NFL games with FC4 format on preview')).toBe(true);
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

  it('force-injects in Project workspace even without delivery intent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'york-lp-skill-'));
    try {
      writeSkill(root, LAUNCHPAD_SKILL_NAME, '# LaunchPad release loop');
      const skills = discoverSkillsFromPaths([root]);
      const user = 'status of staffing this week?';
      const result = expandLaunchPadSkillIntent(user, skills, { force: true });
      expect(result.expanded).toBe(true);
      expect(result.reason).toBe('force');
      expect(result.skillName).toBe(LAUNCHPAD_SKILL_NAME);
      expect(result.text).toContain(`<skill name="${LAUNCHPAD_SKILL_NAME}"`);
      expect(result.text).toContain(user);
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

describe('isConfluenceDocumentIntent', () => {
  it('matches explicit Confluence page creation asks', () => {
    expect(
      isConfluenceDocumentIntent(
        'Create a Confluence page about resource performance issues'
      )
    ).toBe(true);
    expect(isConfluenceDocumentIntent('Publish this as a wiki page in Confluence')).toBe(true);
    expect(isConfluenceDocumentIntent('Write an Atlassian page for the onboarding process')).toBe(
      true
    );
  });

  it('matches wiki create/document verbs', () => {
    expect(isConfluenceDocumentIntent('Create a wiki page for the HR policy')).toBe(true);
    expect(isConfluenceDocumentIntent('Document this process in Confluence')).toBe(true);
  });

    it('does not match unrelated asks', () => {
    expect(isConfluenceDocumentIntent('Create a one-pager for the client update')).toBe(false);
    expect(isConfluenceDocumentIntent('what is the weather today?')).toBe(false);
    expect(isConfluenceDocumentIntent('Document this process')).toBe(false);
  });
});

describe('expandYorkOsSkillIntent', () => {
  it('injects york-os for Confluence document asks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'york-yos-skill-'));
    try {
      writeSkill(root, YORK_OS_SKILL_NAME, '# York OS router');
      const skills = discoverSkillsFromPaths([root]);
      const user = 'Create a Confluence page about resource performance issues';
      const result = expandYorkOsSkillIntent(user, skills);
      expect(result.expanded).toBe(true);
      expect(result.skillName).toBe(YORK_OS_SKILL_NAME);
      expect(result.text).toContain(`<skill name="${YORK_OS_SKILL_NAME}"`);
      expect(result.text).toContain('# York OS router');
      expect(result.text).toContain(user);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('injects york-os for leave policy and other company asks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'york-yos-skill-'));
    try {
      writeSkill(root, YORK_OS_SKILL_NAME, '# York OS router');
      const skills = discoverSkillsFromPaths([root]);
      const result = expandYorkOsSkillIntent('how does leave policy work?', skills);
      expect(result.expanded).toBe(true);
      expect(result.reference).toBe('core');
      expect(result.text).toContain('# York OS router');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not expand pure non-company Q&A', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'york-yos-skill-'));
    try {
      writeSkill(root, YORK_OS_SKILL_NAME, '# York OS router');
      const skills = discoverSkillsFromPaths([root]);
      const result = expandYorkOsSkillIntent('what is the weather today?', skills);
      expect(result.expanded).toBe(false);
      expect(result.text).toBe('what is the weather today?');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not double-inject when skill block already present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'york-yos-skill-'));
    try {
      writeSkill(root, YORK_OS_SKILL_NAME, '# York OS router');
      const skills = discoverSkillsFromPaths([root]);
      const first = expandYorkOsSkillIntent(
        'Create a Confluence page about resource performance issues',
        skills
      );
      expect(first.expanded).toBe(true);
      const second = expandYorkOsSkillIntent(first.text, skills);
      expect(second.expanded).toBe(false);
      expect(second.text).toBe(first.text);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('leaves prompt unchanged when skill is missing', () => {
    const user = 'Create a Confluence page about resource performance issues';
    const result = expandYorkOsSkillIntent(user, []);
    expect(result.expanded).toBe(false);
    expect(result.text).toBe(user);
  });

  it('injects meeting-prep playbook for agenda asks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'york-yos-skill-'));
    try {
      const dir = writeSkill(root, YORK_OS_SKILL_NAME, '# York OS router');
      fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'references', 'meeting-prep.md'),
        '# Meeting prep playbook\nFan out Calendar then Slack.',
        'utf-8'
      );
      const skills = discoverSkillsFromPaths([root]);
      const user = 'Prep my meetings this week';
      const result = expandYorkOsSkillIntent(user, skills);
      expect(result.expanded).toBe(true);
      expect(result.reference).toBe('meeting-prep');
      expect(result.block).toContain('# Meeting prep playbook');
      expect(result.block).toContain('# York OS router');
      expect(result.text).toContain(user);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('classifyYorkOsIntent', () => {
  it('routes company asks to the matching playbook', () => {
    expect(classifyYorkOsIntent('Prep my meetings this week')).toBe('meeting-prep');
    expect(classifyYorkOsIntent('Catch me up on Jay')).toBe('work-brief');
    expect(classifyYorkOsIntent('What did I promise Jay?')).toBe('work-brief');
    expect(classifyYorkOsIntent('Client status for Acme')).toBe('client-status');
    expect(classifyYorkOsIntent('How is project Coachmetrix')).toBe('project-status');
    expect(classifyYorkOsIntent("Who's out this week")).toBe('core');
    expect(isYorkOsCompanyIntent('send a slack message to jay')).toBe(true);
  });

  it('does not steal visual HTML artifact asks', () => {
    expect(classifyYorkOsIntent('Create a one-pager for the client update')).toBeNull();
    expect(isYorkOsCompanyIntent('Create a presentation about Q3')).toBe(false);
  });
});

describe('html-artifact intent', () => {
  it('matches visual create asks and skips Office/Confluence', () => {
    expect(isHtmlArtifactIntent('Create a one-pager for the client update')).toBe(true);
    expect(isHtmlArtifactIntent('Make a deck for the kickoff')).toBe(true);
    expect(isHtmlArtifactIntent('Create a pptx for the kickoff')).toBe(false);
    expect(isHtmlArtifactIntent('Create a Confluence page about onboarding')).toBe(false);
  });

  it('injects html-artifact skill body', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'york-html-skill-'));
    try {
      writeSkill(root, HTML_ARTIFACT_SKILL_NAME, '# HTML artifacts');
      const skills = discoverSkillsFromPaths([root]);
      const user = 'Create a one-pager for the client update';
      const result = expandHtmlArtifactSkillIntent(user, skills);
      expect(result.expanded).toBe(true);
      expect(result.skillName).toBe(HTML_ARTIFACT_SKILL_NAME);
      expect(result.text).toContain('# HTML artifacts');
      expect(result.text).toContain(user);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('goal-runner intent', () => {
  it('matches goal ticks and keep-going asks', () => {
    expect(isGoalRunnerIntent('Continue working toward this goal')).toBe(true);
    expect(isGoalRunnerIntent('GOAL_STATUS: in_progress')).toBe(true);
    expect(isGoalRunnerIntent('keep going until done')).toBe(true);
    expect(isGoalRunnerIntent('what is the weather today?')).toBe(false);
  });

  it('injects goal-runner skill body', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'york-goal-skill-'));
    try {
      writeSkill(root, GOAL_RUNNER_SKILL_NAME, '# Goal runner');
      const skills = discoverSkillsFromPaths([root]);
      const user = 'Continue working toward this goal';
      const result = expandGoalRunnerSkillIntent(user, skills);
      expect(result.expanded).toBe(true);
      expect(result.skillName).toBe(GOAL_RUNNER_SKILL_NAME);
      expect(result.text).toContain('# Goal runner');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
