import { describe, it, expect } from 'vitest';
import { createTitleFlowHarness } from './support/session-title-harness';

describe('session title flow', () => {
  it('updates title after first user message when generator succeeds', async () => {
    const harness = createTitleFlowHarness({ generatedTitle: 'Short title' });
    await harness.runFirstMessage('Help me make a PPT');
    expect(harness.updatedTitle).toBe('Short title');
  });

  it('uses a local succinct title when the generator fails', async () => {
    const harness = createTitleFlowHarness({ generatedTitle: null });
    await harness.runFirstMessage('Help me make a PPT');
    expect(harness.updatedTitle).toBe('Make a PPT');
    expect(harness.hasAttempted).toBe(true);
  });

  it('replaces a title that only copies the user message', async () => {
    const harness = createTitleFlowHarness({
      generatedTitle: 'hello check my api key',
    });
    await harness.runFirstMessage('hello check my api key');
    expect(harness.updatedTitle).toBe('Check My API Key');
  });

  it('does not override manual title changes', async () => {
    const harness = createTitleFlowHarness({
      generatedTitle: 'Short title',
      latestTitle: 'Manual title',
    });
    await harness.runFirstMessage('Help me make a PPT');
    expect(harness.updatedTitle).toBe(null);
    expect(harness.hasAttempted).toBe(false);
  });

  it('does not mark attempt when updateTitle returns false (session deleted during generation)', async () => {
    const harness = createTitleFlowHarness({
      generatedTitle: 'Short title',
      updateTitleResult: false,
    });
    await harness.runFirstMessage('Help me make a PPT');
    // updatedTitle is null because updateTitle returned false
    expect(harness.updatedTitle).toBe(null);
    // hasAttempted must be false so next session start can retry
    expect(harness.hasAttempted).toBe(false);
  });
});
