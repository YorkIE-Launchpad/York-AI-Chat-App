import { describe, expect, it } from 'vitest';
import {
  formatInterval,
  isLoopSlashInput,
  parseIntervalToken,
  parseLoopCommand,
} from '../../shared/loop/parse';
import {
  MIN_LOOP_INTERVAL_MS,
  buildGoalTickPrompt,
  isGoalCompleteInText,
} from '../../shared/loop/types';

describe('parseIntervalToken', () => {
  it('parses short units', () => {
    expect(parseIntervalToken('30s')?.ms).toBe(MIN_LOOP_INTERVAL_MS);
    expect(parseIntervalToken('5m')?.ms).toBe(5 * 60_000);
    expect(parseIntervalToken('2h')?.ms).toBe(2 * 3_600_000);
    expect(parseIntervalToken('1d')?.ms).toBe(86_400_000);
  });

  it('clamps below minimum to 30s', () => {
    expect(parseIntervalToken('5s')?.ms).toBe(MIN_LOOP_INTERVAL_MS);
  });

  it('accepts word units', () => {
    expect(parseIntervalToken('10 minutes')?.unit).toBe('m');
    expect(parseIntervalToken('1 hour')?.unit).toBe('h');
  });
});

describe('parseLoopCommand', () => {
  it('returns usage for empty or bare /loop', () => {
    expect(parseLoopCommand('')).toEqual({ type: 'usage' });
    expect(parseLoopCommand('/loop')).toEqual({ type: 'usage' });
    expect(parseLoopCommand('/goal')).toEqual({ type: 'usage' });
  });

  it('parses stop', () => {
    expect(parseLoopCommand('/loop stop')).toEqual({ type: 'stop' });
    expect(parseLoopCommand('loop stop')).toEqual({ type: 'stop' });
    expect(parseLoopCommand('/goal stop')).toEqual({ type: 'stop' });
    expect(parseLoopCommand('goal stop')).toEqual({ type: 'stop' });
  });

  it('parses leading interval', () => {
    const result = parseLoopCommand('/loop 5m check deploy');
    expect(result).toMatchObject({
      type: 'loop',
      kind: 'interval',
      prompt: 'check deploy',
    });
    if (result.type === 'loop') {
      expect(result.interval.ms).toBe(5 * 60_000);
      expect(formatInterval(result.interval)).toBe('5m');
    }
  });

  it('parses trailing every clause', () => {
    const result = parseLoopCommand('/loop check deploy every 10 minutes');
    expect(result).toMatchObject({
      type: 'loop',
      prompt: 'check deploy',
    });
    if (result.type === 'loop') {
      expect(result.interval.ms).toBe(10 * 60_000);
    }
  });

  it('requires an interval for /loop — no silent default', () => {
    expect(parseLoopCommand('/loop check status')).toEqual({ type: 'usage' });
  });

  it('defaults /goal interval to 2m when omitted', () => {
    const result = parseLoopCommand('/goal make tests pass');
    expect(result).toMatchObject({
      type: 'goal',
      kind: 'goal',
      goal: 'make tests pass',
    });
    if (result.type === 'goal') {
      expect(result.interval.ms).toBe(2 * 60_000);
      expect(result.maxIterations).toBe(20);
    }
  });

  it('parses /goal with interval', () => {
    const withInterval = parseLoopCommand('/goal 5m make tests pass');
    expect(withInterval).toMatchObject({
      type: 'goal',
      kind: 'goal',
      goal: 'make tests pass',
    });
    if (withInterval.type === 'goal') {
      expect(withInterval.interval.ms).toBe(5 * 60_000);
      expect(withInterval.maxIterations).toBe(20);
    }
  });
});

describe('isLoopSlashInput', () => {
  it('detects loop and goal commands', () => {
    expect(isLoopSlashInput('/loop 5m x')).toBe(true);
    expect(isLoopSlashInput('/goal fix tests')).toBe(true);
    expect(isLoopSlashInput('/meeting')).toBe(false);
  });
});

describe('goal status helpers', () => {
  it('builds tick prompt with markers and type guidance', () => {
    const prompt = buildGoalTickPrompt('ship the feature');
    expect(prompt).toContain('ship the feature');
    expect(prompt).toContain('GOAL_STATUS: complete');
    expect(prompt).toContain('goal-runner');
    expect(prompt).toContain('Auto-detect');
  });

  it('detects complete marker', () => {
    expect(isGoalCompleteInText('Done.\nGOAL_STATUS: complete')).toBe(true);
    expect(isGoalCompleteInText('GOAL_STATUS: in_progress')).toBe(false);
  });
});
