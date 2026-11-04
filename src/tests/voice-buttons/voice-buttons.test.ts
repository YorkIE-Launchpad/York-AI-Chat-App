import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyDictionary,
  applySnippets,
  buildVoiceCleanupMessages,
  defaultVoiceButtonDrafts,
  holdKeyMatches,
  normalizeVoiceButtonsConfig,
  validateVoiceHotkey,
  VOICE_DAILY_UTTERANCE_CAP,
} from '../../shared/voice-buttons';
import { createVoiceButtonStore } from '../../main/voice-buttons/voice-button-store';
import {
  processVoiceUtterance,
  resetVoiceRateLimit,
} from '../../main/voice-buttons/voice-button-service';

describe('voice button transforms', () => {
  it('ships five default presets and keeps the feature off', () => {
    expect(defaultVoiceButtonDrafts()).toHaveLength(5);
    expect(normalizeVoiceButtonsConfig(undefined).enabled).toBe(false);
    expect(normalizeVoiceButtonsConfig({ enabled: true, hotkey: 'Ctrl+Shift+D' }).hotkey).toBe(
      'Control+Shift+D'
    );
  });

  it('applies dictionary spellings and snippet expansions once', () => {
    const text = applySnippets(
      applyDictionary('email kalrav about wispr', [
        { term: 'kalrav', replacement: 'Kalrav' },
        { term: 'wispr', replacement: 'Wispr' },
      ]),
      [{ trigger: 'email Kalrav', expansion: 'Email Kalrav Parsana' }]
    );
    expect(text).toContain('Kalrav Parsana');
    expect(text).toContain('Wispr');
    expect(text.split('Kalrav').length - 1).toBe(1);
  });

  it('rejects reserved hold shortcuts and matches the keyup', () => {
    expect(validateVoiceHotkey('Alt+Space').ok).toBe(false);
    expect(validateVoiceHotkey('Control+Shift+D')).toEqual({
      ok: true,
      hotkey: 'Control+Shift+D',
    });
    expect(holdKeyMatches('Control+Shift+D', 'KeyD')).toBe(true);
    expect(holdKeyMatches('Control+Shift+D', 'KeyF')).toBe(false);
  });

  it('puts the transcript in the cleanup prompt', () => {
    const button = {
      id: '1',
      name: 'Clean',
      icon: 'sparkles' as const,
      mode: 'clean' as const,
      rewritePreset: null,
      instruction: 'Keep it {{tone}}',
      language: 'en',
      tone: 'neutral',
      insertMode: 'insert' as const,
      sortOrder: 0,
    };
    const messages = buildVoiceCleanupMessages({
      button,
      transcript: 'um the launch is friday',
      dictionary: [{ term: 'friday', replacement: 'Friday' }],
    });
    expect(messages.user).toContain('um the launch is friday');
    expect(messages.user).toContain('neutral');
    expect(messages.system).not.toContain('um the launch');
  });
});

describe('voice button store and processing', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    resetVoiceRateLimit();
  });

  afterEach(() => {
    db.close();
  });

  it('seeds defaults per user and does not reseed after delete', () => {
    const store = createVoiceButtonStore(db);
    const first = store.listButtons('user-a');
    expect(first.map((button) => button.name)).toEqual([
      'Clean',
      'Raw',
      'Email',
      'CRM note',
      'Task',
    ]);
    expect(store.listButtons('user-b')).toHaveLength(5);
    store.deleteButton('user-a', first[0].id);
    expect(store.listButtons('user-a')).toHaveLength(4);
    expect(store.listButtons('user-b')).toHaveLength(5);
  });

  it('keeps the transcript when Haiku fails and skips Haiku for raw mode', async () => {
    const store = createVoiceButtonStore(db);
    const buttons = store.listButtons('user-a');
    const clean = buttons.find((button) => button.mode === 'clean');
    const raw = buttons.find((button) => button.mode === 'raw');
    expect(clean && raw).toBeTruthy();

    const failed = await processVoiceUtterance(
      { buttonId: clean!.id, rawText: 'uh the deal closed', audioMs: 1000 },
      {
        userSub: 'user-a',
        store,
        enabled: true,
        historyEnabled: true,
        complete: async () => {
          throw new Error('timeout');
        },
      }
    );
    expect(failed.ok).toBe(true);
    if (failed.ok) {
      expect(failed.degraded).toBe(true);
      expect(failed.output).toContain('deal closed');
    }
    expect(store.listHistory('user-a')).toHaveLength(1);

    const calls: string[] = [];
    const rawResult = await processVoiceUtterance(
      { buttonId: raw!.id, rawText: 'leave this raw', audioMs: 500 },
      {
        userSub: 'user-a',
        store,
        enabled: true,
        historyEnabled: false,
        complete: async (system) => {
          calls.push(system);
          return 'should not be used';
        },
      }
    );
    expect(calls).toHaveLength(0);
    expect(rawResult.ok && rawResult.output).toBe('leave this raw');
    expect(store.listHistory('user-a')).toHaveLength(1);
  });

  it('stops at the daily cap and still returns the transcript', () => {
    const store = createVoiceButtonStore(db);
    for (let i = 0; i < VOICE_DAILY_UTTERANCE_CAP; i += 1) {
      const result = store.tryConsumeUsage('user-a', '2026-11-04', 1000, {
        utterances: VOICE_DAILY_UTTERANCE_CAP,
        audioMs: 60 * 60 * 1000,
      });
      expect(result.allowed).toBe(true);
    }
    const blocked = store.tryConsumeUsage('user-a', '2026-11-04', 1000, {
      utterances: VOICE_DAILY_UTTERANCE_CAP,
      audioMs: 60 * 60 * 1000,
    });
    expect(blocked.allowed).toBe(false);
  });
});
