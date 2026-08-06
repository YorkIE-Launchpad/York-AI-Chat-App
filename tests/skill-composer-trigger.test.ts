import { describe, expect, it } from 'vitest';
import {
  applySkillTriggerSelection,
  getSkillComposerTrigger,
} from '../src/shared/skill-composer-trigger';

describe('getSkillComposerTrigger', () => {
  it('detects leading slash commands', () => {
    expect(getSkillComposerTrigger('/pd', 3)).toEqual({
      mode: 'slash',
      start: 0,
      end: 3,
      query: 'pd',
    });
  });

  it('closes slash picker after /name space for args', () => {
    expect(getSkillComposerTrigger('/pdf ', 5)).toBeNull();
  });

  it('detects @mentions mid-sentence', () => {
    const value = 'please use @yor';
    expect(getSkillComposerTrigger(value, value.length)).toEqual({
      mode: 'at',
      start: value.lastIndexOf('@'),
      end: value.length,
      query: 'yor',
    });
  });

  it('detects bare @ at cursor', () => {
    expect(getSkillComposerTrigger('@', 1)).toEqual({
      mode: 'at',
      start: 0,
      end: 1,
      query: '',
    });
  });
});

describe('applySkillTriggerSelection', () => {
  it('replaces @query with @skill', () => {
    const value = 'use @pd';
    const trigger = getSkillComposerTrigger(value, value.length)!;
    const result = applySkillTriggerSelection(value, trigger, '@pdf ');
    expect(result.next).toBe('use @pdf ');
    expect(result.cursor).toBe(result.next.length);
  });

  it('replaces slash with /skill', () => {
    const value = '/pd';
    const trigger = getSkillComposerTrigger(value, value.length)!;
    const result = applySkillTriggerSelection(value, trigger, '/pdf ');
    expect(result.next).toBe('/pdf ');
  });
});
