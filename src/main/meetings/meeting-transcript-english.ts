import { runPiAiOneShot } from '../agent/sdk-one-shot';
import { isAuthenticated } from '../auth/session';
import { configStore } from '../config/config-store';
import { resolveYorkLlmOneShotConfig } from '../config/york-llm-api';
import { logWarn } from '../utils/logger';

/** Devanagari (Hindi etc.) */
const DEVANAGARI_RE = /[\u0900-\u097F]/;
/** Gujarati */
const GUJARATI_RE = /[\u0A80-\u0AFF]/;

const TRANSLATE_SYSTEM =
  'Translate the user message into English. Preserve names, product terms, and numbers. Output English only — no commentary, quotes, or labels.';

/**
 * True when text contains Hindi (Devanagari) or Gujarati script and should be
 * translated into English for stored meeting transcripts.
 */
export function needsEnglishTranslation(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return DEVANAGARI_RE.test(trimmed) || GUJARATI_RE.test(trimmed);
}

/**
 * Return English transcript text. Latin/English passes through; Hindi/Gujarati
 * script is translated via York LLM.
 */
export async function normalizeTranscriptToEnglish(text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return '';
  let needsTranslate = needsEnglishTranslation(trimmed);
  if (!needsTranslate) {
    try {
      const { jevNeedsEnglishTranslation } = await import('../jev/permissions-jev');
      const jev = await jevNeedsEnglishTranslation(trimmed);
      if (jev != null) needsTranslate = jev;
    } catch {
      // Heuristic stands.
    }
  }
  if (!needsTranslate) {
    return trimmed;
  }
  if (!isAuthenticated()) {
    logWarn('[Meetings] Skipping HI/GU→EN translate — not authenticated');
    return trimmed;
  }

  try {
    const config = await resolveYorkLlmOneShotConfig(configStore.getAll());
    const result = await runPiAiOneShot(trimmed, TRANSLATE_SYSTEM, config, {
      temperature: 0,
      maxTokens: Math.min(2000, Math.max(256, trimmed.length * 3)),
    });
    const translated = result.text?.trim();
    if (translated) {
      return translated;
    }
  } catch (error) {
    logWarn('[Meetings] HI/GU→EN translate failed; keeping original', error);
  }
  return trimmed;
}
