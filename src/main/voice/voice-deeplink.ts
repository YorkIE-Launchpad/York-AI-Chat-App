/**
 * `york://voice` deep links (Siri Shortcut "York" opens this URL). Links can
 * arrive before the app is ready, so they queue until a handler is attached.
 */
import { app } from 'electron';
import path from 'path';
import {
  parseVoiceDeepLink,
  VOICE_DEEP_LINK_SCHEME,
  type VoiceDeepLinkAction,
} from '../../shared/voice-control';
import { log } from '../utils/logger';

let pendingAction: VoiceDeepLinkAction | null = null;
let handler: ((action: VoiceDeepLinkAction) => void) | null = null;

export function handleVoiceDeepLinkUrl(raw: string): boolean {
  const action = parseVoiceDeepLink(raw);
  if (!action) return false;
  log('[Voice] Deep link:', action);
  if (handler) handler(action);
  else pendingAction = action;
  return true;
}

/** Attach the handler once the voice controller is ready; flushes a queued link. */
export function setVoiceDeepLinkHandler(next: (action: VoiceDeepLinkAction) => void): void {
  handler = next;
  if (pendingAction) {
    const action = pendingAction;
    pendingAction = null;
    next(action);
  }
}

export function registerVoiceDeepLinkProtocol(): void {
  if (process.platform !== 'darwin') return;
  if (!app.isPackaged && process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(VOICE_DEEP_LINK_SCHEME, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  } else {
    app.setAsDefaultProtocolClient(VOICE_DEEP_LINK_SCHEME);
  }
}

export function installVoiceDeepLinkListeners(): void {
  if (process.platform === 'darwin') {
    app.on('open-url', (event, url) => {
      if (handleVoiceDeepLinkUrl(url)) event.preventDefault();
    });
  }
  app.on('second-instance', (_event, argv) => {
    const urlArg = argv.find((arg) => arg.startsWith(`${VOICE_DEEP_LINK_SCHEME}:`));
    if (urlArg) handleVoiceDeepLinkUrl(urlArg);
  });
}

export function consumeLaunchVoiceDeepLinkArgv(argv: string[]): boolean {
  const urlArg = argv.find((arg) => arg.startsWith(`${VOICE_DEEP_LINK_SCHEME}:`));
  return urlArg ? handleVoiceDeepLinkUrl(urlArg) : false;
}
