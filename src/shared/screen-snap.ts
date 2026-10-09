/**
 * Screen Snap: capture a screen region from anywhere (global shortcut) and start
 * a new GrowthOS chat with the image. Shared between main and renderer.
 */

export const DEFAULT_SCREEN_SNAP_SHORTCUT = 'CommandOrControl+Shift+G';
export const ASK_GROWTHOS_SHORTCUT = 'CommandOrControl+Shift+Space';

export type ScreenSnapMediaType = 'image/png' | 'image/jpeg';

export interface ScreenSnapImage {
  base64: string;
  mediaType: ScreenSnapMediaType;
  width: number;
  height: number;
}

export type ScreenSnapMode = 'chat' | 'write';

/** App the user was in when they pressed the shortcut ("Write into field" target). */
export interface ScreenSnapTarget {
  bundleId: string;
  name: string;
  pid: number;
  /** Front window bounds in global screen points (needs Accessibility). */
  bounds?: { x: number; y: number; width: number; height: number };
}

/** Sent to the composer on `snap:image`. */
export interface ScreenSnapComposerState {
  image: ScreenSnapImage;
  mode: ScreenSnapMode;
  /** Display name of the write target; null when there is nothing to write into. */
  targetAppName: string | null;
}

export interface ScreenSnapGenerateRequest {
  instruction: string;
  image: ScreenSnapImage;
}

export type ScreenSnapGenerateResult =
  | { success: true; text: string }
  | { success: false; error: string; cancelled?: boolean };

export type ScreenSnapInsertResult =
  | { success: true }
  | { success: false; reason: 'accessibility' | 'target_unavailable' | 'no_target' | 'failed' };

export interface ScreenSnapSubmitPayload {
  text: string;
  image: ScreenSnapImage;
}

export type ScreenSnapChatResult =
  | { success: true; sessionId: string }
  | { success: false; error: string };

export type ScreenSnapLayout = 'compose' | 'chat-active';

/** Session events mirrored to the panel for its in-place chat (subset of ServerEvent). */
export const SNAP_FORWARDED_EVENT_TYPES = [
  'stream.message',
  'stream.messageUpdate',
  'stream.partial',
  'session.status',
  'trace.step',
  'trace.update',
  'permission.request',
  'permission.dismiss',
  'question.request',
  'question.dismiss',
] as const;

export type ScreenSnapForwardedEventType = (typeof SNAP_FORWARDED_EVENT_TYPES)[number];

export interface ScreenSnapSessionEvent {
  type: ScreenSnapForwardedEventType;
  payload: { sessionId: string; [key: string]: unknown };
}

export type ScreenSnapShortcutResult =
  | { success: true; shortcut: string | null }
  | { success: false; reason: 'invalid' | 'conflict' | 'reserved'; shortcut: string | null };

const MODIFIER_ALIASES: Record<string, string> = {
  command: 'Command',
  cmd: 'Command',
  super: 'Command',
  meta: 'Command',
  commandorcontrol: 'Command',
  cmdorctrl: 'Command',
  control: 'Control',
  ctrl: 'Control',
  option: 'Option',
  alt: 'Option',
  altgr: 'Option',
  shift: 'Shift',
};

const MODIFIER_ORDER = ['Control', 'Option', 'Shift', 'Command'];

/** macOS screenshot combos (Cmd+Shift+3/4/5/6, optionally with Control). */
const RESERVED_MAC_KEYS = new Set(['3', '4', '5', '6']);

interface ParsedAccelerator {
  modifiers: string[];
  key: string;
}

/**
 * Parse an Electron accelerator into canonical macOS modifiers + key.
 * `CommandOrControl` collapses to `Command` (this feature is macOS-only).
 */
export function parseAccelerator(accelerator: string): ParsedAccelerator | null {
  const parts = accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const modifiers = new Set<string>();
  let key: string | null = null;
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    if (key !== null) return null;
    key = part.length === 1 ? part.toUpperCase() : part;
  }
  if (!key || modifiers.size === 0) return null;

  return {
    modifiers: MODIFIER_ORDER.filter((m) => modifiers.has(m)),
    key,
  };
}

/** Canonical string used to compare two accelerators for equality. */
export function canonicalAccelerator(accelerator: string): string | null {
  const parsed = parseAccelerator(accelerator);
  return parsed ? [...parsed.modifiers, parsed.key].join('+') : null;
}

/**
 * Validate a user-chosen Screen Snap accelerator.
 * Shift alone is not enough: Shift+letter would hijack normal typing.
 */
export function validateScreenSnapAccelerator(
  accelerator: string
): { ok: true } | { ok: false; reason: 'invalid' | 'reserved' } {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return { ok: false, reason: 'invalid' };
  if (!parsed.modifiers.some((m) => m !== 'Shift')) return { ok: false, reason: 'invalid' };

  const canonical = [...parsed.modifiers, parsed.key].join('+');
  if (canonical === canonicalAccelerator(ASK_GROWTHOS_SHORTCUT)) {
    return { ok: false, reason: 'reserved' };
  }
  const isScreenshotCombo =
    parsed.modifiers.includes('Command') &&
    parsed.modifiers.includes('Shift') &&
    !parsed.modifiers.includes('Option') &&
    RESERVED_MAC_KEYS.has(parsed.key);
  if (isScreenshotCombo) return { ok: false, reason: 'reserved' };

  return { ok: true };
}
