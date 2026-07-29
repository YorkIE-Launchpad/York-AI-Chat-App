import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULE_MODEL,
  DEFAULT_SCHEDULE_PROVIDER,
  resolveScheduleModel,
} from '../src/main/schedule/scheduled-task-store';
import { OPENROUTER_FREE_ROUTER_ID } from '../src/main/agent/free-model-resolve';

describe('resolveScheduleModel', () => {
  it('defaults to openrouter/free when model and provider are missing', () => {
    expect(resolveScheduleModel(null, null)).toEqual({
      model: OPENROUTER_FREE_ROUTER_ID,
      provider: DEFAULT_SCHEDULE_PROVIDER,
    });
    expect(resolveScheduleModel(undefined, undefined)).toEqual({
      model: DEFAULT_SCHEDULE_MODEL,
      provider: 'openrouter',
    });
    expect(resolveScheduleModel('  ', '')).toEqual({
      model: DEFAULT_SCHEDULE_MODEL,
      provider: DEFAULT_SCHEDULE_PROVIDER,
    });
  });

  it('preserves explicit model and provider', () => {
    expect(resolveScheduleModel('anthropic/claude-sonnet-4-5', 'anthropic')).toEqual({
      model: 'anthropic/claude-sonnet-4-5',
      provider: 'anthropic',
    });
  });
});

describe('scheduled task executeTask lock wiring', () => {
  it('executeScheduledTask starts sessions with locked model from the task', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const content = readFileSync(
      resolve(process.cwd(), 'src/main/schedule/execute-scheduled-task.ts'),
      'utf8'
    );
    expect(content).toContain('lockModel: true');
    expect(content).toContain('model: task.model');
    expect(content).toContain('provider: task.provider');
  });

  it('session-manager skips config model overwrite when modelLocked', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const content = readFileSync(
      resolve(process.cwd(), 'src/main/session/session-manager.ts'),
      'utf8'
    );
    expect(content).toContain('if (!session.modelLocked)');
    expect(content).toContain('lockModel?: boolean');
    expect(content).toContain('modelLocked: lockModel && Boolean(lockedModel)');
  });

  it('agent-runner overlays locked session model onto runtime config', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const content = readFileSync(resolve(process.cwd(), 'src/main/agent/agent-runner.ts'), 'utf8');
    expect(content).toContain('session.modelLocked && session.model?.trim()');
    expect(content).toContain('Using locked session model');
  });
});
