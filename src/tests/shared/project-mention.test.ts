import { describe, expect, it } from 'vitest';
import {
  extractProjectName,
  mentionsProject,
  withProjectMention,
} from '../../shared/project-mention';

describe('extractProjectName', () => {
  it('reads a project name from nested connector payloads', () => {
    expect(
      extractProjectName({
        issues: [{ fields: { project: { name: 'Coachmetrix' }, summary: 'Login bug' } }],
      })
    ).toBe('Coachmetrix');
    expect(extractProjectName('{"projectName":"Portal"}')).toBe('Portal');
  });

  it('does not invent a project from plain text', () => {
    expect(extractProjectName('Send the deck for Coachmetrix')).toBeNull();
    expect(extractProjectName({ name: 'Release 4' })).toBeNull();
  });
});

describe('withProjectMention', () => {
  it('prefixes a title that does not already name the project', () => {
    expect(withProjectMention('Reply to Priya', 'Coachmetrix')).toBe(
      'Coachmetrix — Reply to Priya'
    );
  });

  it('leaves a title that already names the project', () => {
    expect(withProjectMention('Coachmetrix login bug', 'Coachmetrix')).toBe(
      'Coachmetrix login bug'
    );
    expect(mentionsProject('portal rollout', 'Portal')).toBe(true);
  });
});
