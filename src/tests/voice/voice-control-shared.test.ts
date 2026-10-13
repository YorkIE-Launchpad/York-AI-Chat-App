import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VOICE_CONTROL,
  normalizeVoiceControlConfig,
  parseVoiceDeepLink,
} from '../../shared/voice-control';

describe('parseVoiceDeepLink', () => {
  it.each([
    ['york://voice', 'start'],
    ['york://voice/', 'start'],
    ['york://voice/start', 'start'],
    ['york://voice/stop', 'stop'],
    ['york://voice/toggle', 'toggle'],
    ['york://voice?action=toggle', 'toggle'],
    ['YORK://Voice/Stop', 'stop'],
  ])('parses %s', (url, action) => {
    expect(parseVoiceDeepLink(url)).toBe(action);
  });

  it.each([
    'york://other',
    'york://voice/delete',
    'yorkgrowthos://voice',
    'https://york.ie/voice',
    'not a url',
    '',
  ])('rejects %s', (url) => {
    expect(parseVoiceDeepLink(url)).toBeNull();
  });
});

describe('normalizeVoiceControlConfig', () => {
  it('fills defaults for missing or malformed input', () => {
    expect(normalizeVoiceControlConfig(undefined)).toEqual(DEFAULT_VOICE_CONTROL);
    expect(normalizeVoiceControlConfig('nope')).toEqual(DEFAULT_VOICE_CONTROL);
  });

  it('clamps follow-up seconds', () => {
    expect(normalizeVoiceControlConfig({ followUpSeconds: 999 }).followUpSeconds).toBe(120);
    expect(normalizeVoiceControlConfig({ followUpSeconds: 1 }).followUpSeconds).toBe(5);
  });

  it('keeps an explicitly disabled hotkey but resets blank ones', () => {
    expect(normalizeVoiceControlConfig({ hotkey: null }).hotkey).toBeNull();
    expect(normalizeVoiceControlConfig({ hotkey: '  ' }).hotkey).toBe(DEFAULT_VOICE_CONTROL.hotkey);
  });

  it('drops settings from the removed wake word', () => {
    expect(
      normalizeVoiceControlConfig({ wakeWordEnabled: true, wakeWordAccessKey: 'abc' })
    ).toEqual(DEFAULT_VOICE_CONTROL);
  });
});
