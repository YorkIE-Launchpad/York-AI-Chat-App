/**
 * IPC for voice buttons. Apple speech start refuses to steal a meeting session.
 */
import { ipcMain, type WebContents } from 'electron';
import {
  createDictationAppleSink,
  VOICE_BUTTONS_APPLE_SESSION_ID,
} from '../dictation/dictation-apple-sink';
import { appleMeetingTranscriptionService } from '../meetings/apple-meeting-transcription-service';
import { ensureAuthenticatedSession } from '../auth/session';
import { getDatabase } from '../db/database';
import { configStore } from '../config/config-store';
import { logWarn } from '../utils/logger';
import {
  normalizeVoiceButtonsConfig,
  sanitizeVoiceButtonDraft,
  type VoiceButtonsConfig,
  type VoiceProcessResult,
} from '../../shared/voice-buttons';
import { createVoiceButtonStore, type VoiceButtonStore } from './voice-button-store';
import { processVoiceUtterance } from './voice-button-service';
import { completeVoiceCleanup } from './voice-cleanup';

let store: VoiceButtonStore | null = null;

function voiceStore(): VoiceButtonStore {
  if (!store) {
    store = createVoiceButtonStore(getDatabase().raw);
  }
  return store;
}

async function requireUserSub(): Promise<string> {
  const session = await ensureAuthenticatedSession();
  if (session.user?.id == null) {
    throw new Error('Sign in to use voice buttons.');
  }
  return String(session.user.id);
}

export function registerVoiceButtonIpc(deps: {
  setCaptureTarget: (contents: WebContents) => void;
  onConfigChanged?: (config: VoiceButtonsConfig) => void;
}): void {
  ipcMain.handle('voiceButtons.getConfig', () => {
    return normalizeVoiceButtonsConfig(configStore.get('voiceButtons'));
  });

  ipcMain.handle('voiceButtons.updateConfig', (_event, partial: Partial<VoiceButtonsConfig>) => {
    const current = normalizeVoiceButtonsConfig(configStore.get('voiceButtons'));
    const next = normalizeVoiceButtonsConfig({ ...current, ...partial });
    configStore.update({ voiceButtons: next });
    deps.onConfigChanged?.(next);
    return next;
  });

  ipcMain.handle('voiceButtons.list', async () => {
    const userSub = await requireUserSub();
    return voiceStore().listButtons(userSub);
  });

  ipcMain.handle('voiceButtons.save', async (_event, draft: unknown) => {
    const userSub = await requireUserSub();
    const clean = sanitizeVoiceButtonDraft(draft);
    if (!clean) throw new Error('Voice button is missing a name or a valid mode.');
    return voiceStore().upsertButton(userSub, clean);
  });

  ipcMain.handle('voiceButtons.delete', async (_event, id: string) => {
    const userSub = await requireUserSub();
    if (typeof id !== 'string' || !id.trim()) throw new Error('Missing voice button id.');
    voiceStore().deleteButton(userSub, id.trim());
    return { success: true };
  });

  ipcMain.handle('voiceButtons.reorder', async (_event, ids: unknown) => {
    const userSub = await requireUserSub();
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw new Error('Reorder expects a list of ids.');
    }
    return voiceStore().reorderButtons(userSub, ids);
  });

  ipcMain.handle('voiceButtons.duplicate', async (_event, id: string) => {
    const userSub = await requireUserSub();
    const copy = voiceStore().duplicateButton(userSub, id);
    if (!copy) throw new Error('Voice button not found.');
    return copy;
  });

  ipcMain.handle('voiceButtons.dictionary.list', async () => {
    const userSub = await requireUserSub();
    return voiceStore().listDictionary(userSub);
  });

  ipcMain.handle('voiceButtons.dictionary.replace', async (_event, entries: unknown) => {
    const userSub = await requireUserSub();
    if (!Array.isArray(entries)) throw new Error('Dictionary expects a list.');
    const clean = entries
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        term: String((entry as { term?: unknown }).term ?? ''),
        replacement: String((entry as { replacement?: unknown }).replacement ?? ''),
      }));
    return voiceStore().replaceDictionary(userSub, clean);
  });

  ipcMain.handle('voiceButtons.snippets.list', async () => {
    const userSub = await requireUserSub();
    return voiceStore().listSnippets(userSub);
  });

  ipcMain.handle('voiceButtons.snippets.replace', async (_event, entries: unknown) => {
    const userSub = await requireUserSub();
    if (!Array.isArray(entries)) throw new Error('Snippets expect a list.');
    const clean = entries
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        trigger: String((entry as { trigger?: unknown }).trigger ?? ''),
        expansion: String((entry as { expansion?: unknown }).expansion ?? ''),
      }));
    return voiceStore().replaceSnippets(userSub, clean);
  });

  ipcMain.handle('voiceButtons.history.list', async () => {
    const userSub = await requireUserSub();
    return voiceStore().listHistory(userSub, 50);
  });

  ipcMain.handle('voiceButtons.history.clear', async () => {
    const userSub = await requireUserSub();
    voiceStore().clearHistory(userSub);
    return { success: true };
  });

  ipcMain.handle(
    'voiceButtons.process',
    async (
      _event,
      payload: { buttonId?: string; rawText?: string; audioMs?: number }
    ): Promise<VoiceProcessResult> => {
      let userSub = '';
      try {
        userSub = await requireUserSub();
      } catch (error) {
        logWarn('[VoiceButtons] process requires sign-in', error);
        return {
          ok: false,
          code: 'unauthorized',
          message: 'Sign in to clean up dictation.',
          raw: typeof payload?.rawText === 'string' ? payload.rawText.trim() : '',
        };
      }
      const config = normalizeVoiceButtonsConfig(configStore.get('voiceButtons'));
      try {
        return await processVoiceUtterance(
          {
            buttonId: typeof payload?.buttonId === 'string' ? payload.buttonId : '',
            rawText: typeof payload?.rawText === 'string' ? payload.rawText : '',
            audioMs: typeof payload?.audioMs === 'number' ? payload.audioMs : 0,
          },
          {
            userSub,
            store: voiceStore(),
            enabled: config.enabled,
            historyEnabled: config.historyEnabled,
            complete: completeVoiceCleanup,
          }
        );
      } catch (error) {
        logWarn('[VoiceButtons] process failed', error);
        return {
          ok: false,
          code: 'failed',
          message: 'Could not finish that dictation. Your transcript is kept.',
          raw: typeof payload?.rawText === 'string' ? payload.rawText.trim() : '',
        };
      }
    }
  );

  ipcMain.handle('voiceButtons.appleStart', async (event) => {
    if (process.platform !== 'darwin') {
      throw new Error('Apple speech recognition is only available on macOS.');
    }
    const active = appleMeetingTranscriptionService.getActiveMeetingId();
    if (active && active !== VOICE_BUTTONS_APPLE_SESSION_ID) {
      throw new Error('Speech recognition is already in use.');
    }
    deps.setCaptureTarget(event.sender);
    const target = event.sender;
    const sink = createDictationAppleSink((channel, payload) => {
      if (!target.isDestroyed()) {
        target.send(channel, payload);
      }
    });
    await appleMeetingTranscriptionService.start(VOICE_BUTTONS_APPLE_SESSION_ID, sink);
    return { success: true };
  });

  ipcMain.handle('voiceButtons.appleStop', async () => {
    if (appleMeetingTranscriptionService.getActiveMeetingId() !== VOICE_BUTTONS_APPLE_SESSION_ID) {
      return { success: true };
    }
    await appleMeetingTranscriptionService.stop();
    return { success: true };
  });
}
