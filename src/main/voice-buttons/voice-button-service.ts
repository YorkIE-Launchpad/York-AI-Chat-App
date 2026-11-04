/**
 * Turn a transcript into finished text using the active voice button.
 * Haiku is injected so tests can run without the model client.
 */
import {
  applyDictionary,
  applySnippets,
  buildVoiceCleanupMessages,
  VOICE_DAILY_AUDIO_CAP_MS,
  VOICE_DAILY_UTTERANCE_CAP,
  VOICE_RATE_LIMIT,
  VOICE_RATE_WINDOW_MS,
  voiceUsageDay,
  type VoiceProcessResult,
} from '../../shared/voice-buttons';
import type { VoiceButtonStore } from './voice-button-store';

const rateHits = new Map<string, number[]>();

export function resetVoiceRateLimit(): void {
  rateHits.clear();
}

export function takeVoiceRateLimit(
  userSub: string,
  now: number,
  limit = VOICE_RATE_LIMIT,
  windowMs = VOICE_RATE_WINDOW_MS
): boolean {
  const recent = (rateHits.get(userSub) ?? []).filter((stamp) => now - stamp < windowMs);
  if (recent.length >= limit) {
    rateHits.set(userSub, recent);
    return false;
  }
  recent.push(now);
  rateHits.set(userSub, recent);
  return true;
}

export async function processVoiceUtterance(
  input: { buttonId: string; rawText: string; audioMs: number },
  deps: {
    userSub: string;
    store: VoiceButtonStore;
    enabled: boolean;
    historyEnabled: boolean;
    now?: Date;
    complete: (system: string, user: string) => Promise<string>;
  }
): Promise<VoiceProcessResult> {
  const raw = (input.rawText || '').trim().slice(0, 20_000);
  if (!deps.enabled) {
    return {
      ok: false,
      code: 'disabled',
      message: 'Voice buttons are turned off.',
      raw,
    };
  }
  if (!raw) {
    return {
      ok: false,
      code: 'empty',
      message: 'No speech was captured.',
      raw: '',
    };
  }

  const button = deps.store.getButton(deps.userSub, input.buttonId);
  if (!button) {
    return {
      ok: false,
      code: 'not_found',
      message: 'That voice button is no longer available.',
      raw,
    };
  }

  const now = deps.now ?? new Date();
  if (!takeVoiceRateLimit(deps.userSub, now.getTime())) {
    return {
      ok: false,
      code: 'rate',
      message: 'Too many dictations in a short time. Wait a moment and try again.',
      raw,
    };
  }

  const usage = deps.store.tryConsumeUsage(deps.userSub, voiceUsageDay(now), input.audioMs || 0, {
    utterances: VOICE_DAILY_UTTERANCE_CAP,
    audioMs: VOICE_DAILY_AUDIO_CAP_MS,
  });
  if (!usage.allowed) {
    return {
      ok: false,
      code: 'quota',
      message: 'Daily voice limit reached. Your transcript is kept so you can copy it.',
      raw,
    };
  }

  const dictionary = deps.store.listDictionary(deps.userSub);
  const snippets = deps.store.listSnippets(deps.userSub);
  const substituted = applySnippets(applyDictionary(raw, dictionary), snippets);

  let output = substituted;
  let degraded = false;
  if (button.mode !== 'raw') {
    try {
      const messages = buildVoiceCleanupMessages({
        button,
        transcript: substituted,
        dictionary,
      });
      const cleaned = (await deps.complete(messages.system, messages.user)).trim();
      if (!cleaned) {
        degraded = true;
      } else {
        output = cleaned;
      }
    } catch {
      degraded = true;
      output = substituted;
    }
  }

  let historyId: string | null = null;
  if (deps.historyEnabled) {
    historyId = deps.store.addHistory({
      userSub: deps.userSub,
      buttonId: button.id,
      buttonName: button.name,
      rawText: raw,
      outputText: output,
      degraded,
      createdAt: now.getTime(),
    });
  }

  return {
    ok: true,
    raw,
    output,
    degraded,
    insertMode: button.insertMode,
    historyId,
    buttonName: button.name,
  };
}
