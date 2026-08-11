import OpenAI from 'openai';
import { BACKEND_PROXY_PLACEHOLDER_KEY, getBackendProxyBaseUrl } from '../../shared/backend-config';
import { appVersionHeaders } from '../../shared/client-version';
import { isAuthenticated } from '../auth/session';
import { getClientAppVersion, resolveBackendClientApiKey } from '../config/backend-auth';
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
 * script is translated via the York OpenAI backend proxy.
 */
export async function normalizeTranscriptToEnglish(text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (!needsEnglishTranslation(trimmed)) {
    return trimmed;
  }
  if (!isAuthenticated()) {
    logWarn('[Meetings] Skipping HI/GU→EN translate — not authenticated');
    return trimmed;
  }

  try {
    const baseUrl = getBackendProxyBaseUrl('openai');
    const apiKey = await resolveBackendClientApiKey({
      provider: 'openai',
      apiKey: BACKEND_PROXY_PLACEHOLDER_KEY,
    });
    const client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
      defaultHeaders: appVersionHeaders(getClientAppVersion()),
    });
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: Math.min(2000, Math.max(256, trimmed.length * 3)),
      messages: [
        { role: 'system', content: TRANSLATE_SYSTEM },
        { role: 'user', content: trimmed },
      ],
    });
    const translated = completion.choices[0]?.message?.content?.trim();
    if (translated) {
      return translated;
    }
  } catch (error) {
    logWarn('[Meetings] HI/GU→EN translate failed; keeping original', error);
  }
  return trimmed;
}
