import { describe, it, expect } from 'vitest';
import { nextToolsReadyPollIntervalMs } from '../../renderer/hooks/useToolsReady';

describe('nextToolsReadyPollIntervalMs', () => {
  it('polls faster while tools are not ready', () => {
    expect(nextToolsReadyPollIntervalMs(false)).toBe(1500);
  });

  it('polls slower once tools are ready', () => {
    expect(nextToolsReadyPollIntervalMs(true)).toBe(5000);
  });
});
