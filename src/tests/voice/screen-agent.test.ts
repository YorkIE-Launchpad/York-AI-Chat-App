import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  clipboard: {},
  nativeImage: {},
  screen: {},
  systemPreferences: {
    isTrustedAccessibilityClient: vi.fn(() => true),
    getMediaAccessStatus: vi.fn(() => 'granted'),
  },
}));

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { doOnScreen, MAX_AGENT_STEPS, parseAgentStep } from '../../main/voice/screen-agent';
import type { VoiceScreenDeps, VoiceScreenshot } from '../../main/voice/screen-context';

const IMAGE = { base64: 'AAAA', mediaType: 'image/jpeg' as const, width: 1280, height: 800 };
const SHOT: VoiceScreenshot = {
  image: IMAGE,
  frame: { x: 0, y: 0, width: 1728, height: 1080 },
  target: { bundleId: 'com.google.Chrome', name: 'Google Chrome', pid: 7 },
};

function agentDeps(replies: string[], overrides: Partial<VoiceScreenDeps> = {}) {
  const queue = [...replies];
  const ask = vi.fn<VoiceScreenDeps['ask']>(
    async () => queue.shift() ?? '{"action":"fail","reason":"no more replies"}'
  );
  const click = vi.fn(async () => undefined);
  const pasteText = vi.fn(async () => ({ success: true }));
  const pressKeys = vi.fn(async () => undefined);
  const onProgress = vi.fn();
  const deps: VoiceScreenDeps = {
    ask,
    capture: async () => SHOT,
    click,
    pasteText,
    pressKeys,
    onProgress,
    isScreenGranted: () => true,
    isTrusted: () => true,
    sleep: async () => undefined,
    ...overrides,
  };
  return { deps, ask, click, pasteText, pressKeys, onProgress };
}

describe('parseAgentStep', () => {
  it('reads a click wrapped in a code fence', () => {
    expect(
      parseAgentStep(
        '```json\n{"action":"click","x":640,"y":120,"element":"Project dropdown","risky":false}\n```',
        IMAGE
      )
    ).toEqual({ action: 'click', x: 640, y: 120, element: 'Project dropdown', risky: false });
  });

  it('fails on points outside the image, prose, and unknown actions', () => {
    expect(parseAgentStep('{"action":"click","x":5000,"y":10}', IMAGE).action).toBe('fail');
    expect(parseAgentStep('I would click the dropdown', IMAGE).action).toBe('fail');
    expect(parseAgentStep('{"action":"dance"}', IMAGE).action).toBe('fail');
  });

  it('centres a scroll without coordinates', () => {
    expect(parseAgentStep('{"action":"scroll","direction":"up"}', IMAGE)).toEqual({
      action: 'scroll',
      direction: 'up',
      x: 640,
      y: 400,
    });
  });
});

describe('doOnScreen', () => {
  it('opens a dropdown, picks the option, and stops when done', async () => {
    const { deps, click, ask, onProgress } = agentDeps([
      '{"action":"click","x":128,"y":80,"element":"Project dropdown","risky":false}',
      '{"action":"click","x":128,"y":200,"element":"Hub Revamp option","risky":false}',
      '{"action":"done","summary":"Project set to Hub Revamp."}',
    ]);
    const result = await doOnScreen({ goal: 'In the project dropdown, select Hub Revamp' }, deps);

    expect(result).toEqual({ ok: true, message: 'Project set to Hub Revamp.' });
    expect(click.mock.calls).toEqual([
      [173, 108],
      [173, 270],
    ]);
    expect(ask).toHaveBeenCalledTimes(3);
    expect(ask.mock.calls[2][1]).toContain('clicked Hub Revamp option');
    expect(onProgress).toHaveBeenCalledWith('Clicking Project dropdown…');
  });

  it('passes the session history so references resolve', async () => {
    const { deps, ask } = agentDeps(['{"action":"done","summary":"Already there."}'], {
      getHistory: () => ['User: open the Hub project', 'Assistant: Done.'],
    });
    await doOnScreen({ goal: 'Open its settings' }, deps);
    expect(ask.mock.calls[0][1]).toContain('User: open the Hub project');
  });

  it('types into a search box and presses enter without asking', async () => {
    const { deps, pasteText, pressKeys } = agentDeps(
      [
        '{"action":"click","x":600,"y":40,"element":"Search bar","risky":false}',
        '{"action":"type","text":"invoices","element":"Search bar"}',
        '{"action":"key","keys":"enter","risky":false}',
        '{"action":"done","summary":"Searched for invoices."}',
      ],
      { isDangerousKeys: () => false }
    );
    const result = await doOnScreen({ goal: 'Search for invoices' }, deps);
    expect(result.ok).toBe(true);
    expect(pasteText).toHaveBeenCalledWith('invoices');
    expect(pressKeys).toHaveBeenCalledWith('enter');
  });

  it('asks for confirmation before a risky step and continues once confirmed', async () => {
    const send = '{"action":"click","x":10,"y":10,"element":"Send","risky":true}';
    const first = agentDeps([send]);
    const result = await doOnScreen({ goal: 'Send it' }, first.deps);
    expect(result.needsConfirmation).toBe(true);
    expect(result.message).toContain('clicked Send');
    expect(first.click).not.toHaveBeenCalled();

    const second = agentDeps([send, '{"action":"done","summary":"Sent."}']);
    expect(await doOnScreen({ goal: 'Send it', confirmed: true }, second.deps)).toEqual({
      ok: true,
      message: 'Sent.',
    });
    expect(second.click).toHaveBeenCalledTimes(1);
  });

  it('gives up when the same click keeps changing nothing', async () => {
    const same = '{"action":"click","x":300,"y":300,"element":"Filter","risky":false}';
    const { deps, click } = agentDeps([same, same, same, same]);
    const result = await doOnScreen({ goal: 'Open the filter' }, deps);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not changing anything');
    expect(click).toHaveBeenCalledTimes(2);
  });

  it('stops after the step limit', async () => {
    const replies = Array.from(
      { length: MAX_AGENT_STEPS + 2 },
      (_, index) => `{"action":"scroll","direction":"down","x":${index * 20},"y":100}`
    );
    const { deps, ask } = agentDeps(replies, { scroll: vi.fn(async () => undefined) });
    const result = await doOnScreen({ goal: 'Find the archive link' }, deps);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Ran out of steps');
    expect(ask).toHaveBeenCalledTimes(MAX_AGENT_STEPS);
  });

  it('reports the model reason when the goal is not on screen', async () => {
    const { deps } = agentDeps(['{"action":"fail","reason":"There is no project dropdown here."}']);
    const result = await doOnScreen({ goal: 'Change the project' }, deps);
    expect(result).toEqual({ ok: false, message: 'There is no project dropdown here.' });
  });
});
