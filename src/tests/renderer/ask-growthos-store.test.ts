import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../renderer/store';

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});

describe('Ask Growth OS store', () => {
  it('opens and closes the popup', () => {
    expect(useAppStore.getState().askGrowthOSOpen).toBe(false);
    useAppStore.getState().setAskGrowthOSOpen(true);
    expect(useAppStore.getState().askGrowthOSOpen).toBe(true);
    useAppStore.getState().setAskGrowthOSOpen(false);
    expect(useAppStore.getState().askGrowthOSOpen).toBe(false);
  });

  it('toggles the popup', () => {
    useAppStore.getState().toggleAskGrowthOS();
    expect(useAppStore.getState().askGrowthOSOpen).toBe(true);
    useAppStore.getState().toggleAskGrowthOS();
    expect(useAppStore.getState().askGrowthOSOpen).toBe(false);
  });

  it('tracks the bound Ask session id across close', () => {
    useAppStore.getState().setAskGrowthOSOpen(true);
    useAppStore.getState().setAskGrowthOSSessionId('sess-ask-1');
    useAppStore.getState().setAskGrowthOSOpen(false);
    expect(useAppStore.getState().askGrowthOSSessionId).toBe('sess-ask-1');
  });
});
