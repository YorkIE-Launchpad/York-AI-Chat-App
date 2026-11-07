import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');

describe('queued message Send now wiring', () => {
  it('exposes session.steer-queued across preload, types, and main handler', () => {
    const preload = readFileSync(join(ROOT, 'src/preload/index.ts'), 'utf8');
    const types = readFileSync(join(ROOT, 'src/renderer/types/index.ts'), 'utf8');
    const main = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8');
    const sessionManager = readFileSync(join(ROOT, 'src/main/session/session-manager.ts'), 'utf8');
    const agentRunner = readFileSync(join(ROOT, 'src/main/agent/agent-runner.ts'), 'utf8');
    const queueList = readFileSync(
      join(ROOT, 'src/renderer/components/MessageQueueList.tsx'),
      'utf8'
    );

    expect(preload).toContain("'session.steer-queued'");
    expect(types).toContain("type: 'session.steer-queued'");
    expect(main).toContain("case 'session.steer-queued':");
    expect(main).toContain('steerQueuedPrompt');
    expect(sessionManager).toContain('steerQueuedPrompt(');
    expect(agentRunner).toContain("deliverAs: 'steer'");
    expect(queueList).toContain('onSendNow');
    expect(queueList).toContain('queueSendNow');
  });
});
