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

import {
  imagePointToScreen,
  voiceWrite,
  type VoiceScreenDeps,
  type VoiceScreenshot,
} from '../../main/voice/screen-context';

const IMAGE = { base64: 'AAAA', mediaType: 'image/jpeg' as const, width: 1280, height: 800 };
const SHOT: VoiceScreenshot = {
  image: IMAGE,
  frame: { x: 0, y: 0, width: 1728, height: 1080 },
  target: { bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack', pid: 42 },
};

function screenDeps(reply: string, overrides: Partial<VoiceScreenDeps> = {}) {
  const click = vi.fn(async () => undefined);
  const pasteText = vi.fn(async () => ({ success: true }));
  const ask = vi.fn(async () => reply);
  const deps: VoiceScreenDeps = {
    ask,
    capture: async () => SHOT,
    click,
    pasteText,
    isScreenGranted: () => true,
    isTrusted: () => true,
    ...overrides,
  };
  return { deps, click, pasteText, ask };
}

describe('imagePointToScreen', () => {
  it('scales image pixels to screen points and offsets by the display origin', () => {
    expect(
      imagePointToScreen({ x: 640, y: 400 }, IMAGE, { x: -1728, y: 0, width: 1728, height: 1080 })
    ).toEqual({ x: -864, y: 540 });
  });
});

describe('voiceWrite', () => {
  it('stops before capturing without Screen Recording permission', async () => {
    const capture = vi.fn(async () => SHOT);
    const { deps } = screenDeps('{}', { capture, isScreenGranted: () => false });
    const result = await voiceWrite({ instruction: 'anything' }, deps);
    expect(result.message).toContain('Screen Recording');
    expect(capture).not.toHaveBeenCalled();
  });

  it('includes the earlier conversation so references resolve', async () => {
    const { deps, ask } = screenDeps('Thanks Priya!', {
      getHistory: () => ['User: open the chat with Priya', 'Action do_on_screen -> Opened.'],
    });
    await voiceWrite({ instruction: 'thank her' }, deps);
    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining('User: open the chat with Priya'),
      expect.any(String),
      IMAGE,
      expect.any(Number),
      expect.any(Function)
    );
  });

  it('drafts from the screenshot and pastes the draft', async () => {
    const { deps, pasteText, ask } = screenDeps('  Sounds good, see you at 5!  ');
    const result = await voiceWrite({ instruction: 'reply that I can join at 5' }, deps);
    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining('reply that I can join at 5'),
      expect.any(String),
      IMAGE,
      expect.any(Number),
      expect.any(Function)
    );
    expect(pasteText).toHaveBeenCalledWith('Sounds good, see you at 5!');
    expect(result.ok).toBe(true);
  });

  it('streams the draft to the overlay, then marks it pasted', async () => {
    const onDraft = vi.fn();
    const { deps } = screenDeps('', {
      onDraft,
      ask: async (_prompt, _system, _image, _maxTokens, onDelta) => {
        onDelta?.('Sounds');
        onDelta?.('Sounds good');
        return 'Sounds good';
      },
    });
    await voiceWrite({ instruction: 'agree' }, deps);
    expect(onDraft.mock.calls.map(([update]) => [update.phase, update.text])).toEqual([
      ['drafting', ''],
      ['drafting', 'Sounds'],
      ['drafting', 'Sounds good'],
      ['pasted', 'Sounds good'],
    ]);
  });

  it('reports a failed paste', async () => {
    const { deps } = screenDeps('Hello', {
      pasteText: async () => ({ success: false, reason: 'failed' }),
    });
    const result = await voiceWrite({ instruction: 'say hello' }, deps);
    expect(result).toEqual({
      ok: false,
      message: 'Could not paste the draft. It is on the clipboard.',
    });
  });
});
