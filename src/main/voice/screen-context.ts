/**
 * Screen-aware voice helpers (macOS): capture the display the user is working
 * on, real pointer clicks / scrolls, and the `write` draft-and-paste action.
 * The multi-step `do_on_screen` loop lives in `screen-agent.ts`.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { nativeImage, screen, systemPreferences } from 'electron';
import type { ScreenSnapImage, ScreenSnapTarget } from '../../shared/screen-snap';
import type { VoiceActionResult, VoiceDraftUpdate } from '../../shared/voice-control';
import { getFrontmostTarget, type RunOsascript } from '../snap/front-app';
import { pasteText } from '../snap/paste-into-app';
import { SNAP_WRITE_SYSTEM_PROMPT } from '../snap/screen-snap';
import { logWarn } from '../utils/logger';

const SCREENCAPTURE_PATH = '/usr/sbin/screencapture';
const OSASCRIPT_PATH = '/usr/bin/osascript';
/** Vision models point most accurately on images near this size (Claude downscales larger ones). */
export const LOCATE_MAX_EDGE = 1280;
const DRAFT_MAX_EDGE = 1600;
const JPEG_QUALITY = 85;

export interface ScreenFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VoiceScreenshot {
  image: ScreenSnapImage;
  /** Global screen points covered by the image. */
  frame: ScreenFrame;
  target: ScreenSnapTarget | null;
}

/** One-shot vision call: returns the model's full text reply. */
export type VisionAsk = (
  prompt: string,
  systemPrompt: string,
  image: ScreenSnapImage,
  maxTokens: number,
  /** Receives the accumulated reply so far. */
  onDelta?: (text: string) => void
) => Promise<string>;

export interface VoiceScreenDeps {
  ask: VisionAsk;
  capture?: (maxEdge: number) => Promise<VoiceScreenshot>;
  click?: (x: number, y: number) => Promise<void>;
  scroll?: (x: number, y: number, direction: 'up' | 'down') => Promise<void>;
  /** Presses a chord like "enter" or "cmd+a"; throws on keys it cannot parse. */
  pressKeys?: (keys: string) => Promise<void>;
  /** True for chords that close, quit, or delete regardless of what the model thinks. */
  isDangerousKeys?: (keys: string) => boolean;
  pasteText?: (text: string) => Promise<{ success: boolean; reason?: string }>;
  isScreenGranted?: () => boolean;
  isTrusted?: (prompt: boolean) => boolean;
  /** Recent turns in this voice session, oldest first. */
  getHistory?: () => string[];
  /** Short "Clicking Project menu…" updates for the overlay. */
  onProgress?: (text: string) => void;
  /** Streams the `write` draft to the overlay card. */
  onDraft?: (update: VoiceDraftUpdate) => void;
  sleep?: (ms: number) => Promise<void>;
}

const SCREEN_PERMISSION_MESSAGE =
  'Screen Recording permission is off. Ask the user to allow York GrowthOS in System Settings, Privacy & Security, Screen Recording.';
const ACCESSIBILITY_MESSAGE =
  'Accessibility permission is off. Ask the user to allow York GrowthOS in System Settings, Privacy & Security, Accessibility.';

/** Image pixel -> global screen point. */
export function imagePointToScreen(
  point: { x: number; y: number },
  image: Pick<ScreenSnapImage, 'width' | 'height'>,
  frame: ScreenFrame
): { x: number; y: number } {
  return {
    x: Math.round(frame.x + (point.x * frame.width) / image.width),
    y: Math.round(frame.y + (point.y * frame.height) / image.height),
  };
}

function encodeForModel(png: Buffer, maxEdge: number): ScreenSnapImage | null {
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) return null;
  const size = image.getSize();
  const longest = Math.max(size.width, size.height);
  const resized =
    longest > maxEdge
      ? image.resize(
          size.width >= size.height
            ? { width: maxEdge, quality: 'best' }
            : { height: maxEdge, quality: 'best' }
        )
      : image;
  const out = resized.getSize();
  return {
    base64: resized.toJPEG(JPEG_QUALITY).toString('base64'),
    mediaType: 'image/jpeg',
    width: out.width,
    height: out.height,
  };
}

function execFileAsync(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout))
    );
  });
}

/** Whole display holding the frontmost window (or the pointer), so the Dock and menu bar are clickable too. */
export async function captureVoiceScreenshot(
  maxEdge: number,
  getTarget: () => Promise<ScreenSnapTarget | null> = () => getFrontmostTarget()
): Promise<VoiceScreenshot> {
  const target = await getTarget().catch(() => null);
  const display = target?.bounds
    ? screen.getDisplayMatching(target.bounds)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const frame: ScreenFrame = { ...display.bounds };
  const tmpPath = join(os.tmpdir(), `growthos-voice-${Date.now()}.png`);
  try {
    await execFileAsync(
      SCREENCAPTURE_PATH,
      ['-x', '-R', `${frame.x},${frame.y},${frame.width},${frame.height}`, tmpPath],
      8000
    );
    const image = fs.existsSync(tmpPath) ? encodeForModel(fs.readFileSync(tmpPath), maxEdge) : null;
    if (!image) throw new Error('Screen capture returned no image.');
    return { image, frame, target };
  } finally {
    fs.rm(tmpPath, { force: true }, () => undefined);
  }
}

/** Real pointer move + left click (CoreGraphics), so hover states and web pages react like a user click. */
const CLICK_JXA = [
  'ObjC.import("CoreGraphics");',
  'function run(argv) {',
  '  const p = { x: Number(argv[0]), y: Number(argv[1]) };',
  '  const post = (type) => $.CGEventPost(0, $.CGEventCreateMouseEvent(null, type, p, 0));',
  '  post(5); delay(0.08); post(1); delay(0.04); post(2);',
  '}',
].join('\n');

const runJxa: RunOsascript = (args) => execFileAsync(OSASCRIPT_PATH, args, 4000);

export function clickAtPoint(x: number, y: number, run: RunOsascript = runJxa): Promise<string> {
  return run(['-l', 'JavaScript', '-e', CLICK_JXA, String(Math.round(x)), String(Math.round(y))]);
}

/** Moves the pointer over the area (wheel events go to what is under the pointer), then scrolls. */
const SCROLL_JXA = [
  'ObjC.import("CoreGraphics");',
  'function run(argv) {',
  '  const p = { x: Number(argv[0]), y: Number(argv[1]) };',
  '  $.CGEventPost(0, $.CGEventCreateMouseEvent(null, 5, p, 0));',
  '  delay(0.05);',
  '  $.CGEventPost(0, $.CGEventCreateScrollWheelEvent(null, 1, 1, Number(argv[2])));',
  '}',
].join('\n');

export const SCROLL_LINES = 8;

export function scrollAtPoint(
  x: number,
  y: number,
  direction: 'up' | 'down',
  run: RunOsascript = runJxa
): Promise<string> {
  const lines = direction === 'down' ? -SCROLL_LINES : SCROLL_LINES;
  return run([
    '-l',
    'JavaScript',
    '-e',
    SCROLL_JXA,
    String(Math.round(x)),
    String(Math.round(y)),
    String(lines),
  ]);
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function screenPermissionBlock(deps: VoiceScreenDeps): VoiceActionResult | null {
  const screenGranted =
    deps.isScreenGranted ?? (() => systemPreferences.getMediaAccessStatus('screen') === 'granted');
  if (!screenGranted()) return { ok: false, message: SCREEN_PERMISSION_MESSAGE };
  const isTrusted =
    deps.isTrusted ?? ((prompt: boolean) => systemPreferences.isTrustedAccessibilityClient(prompt));
  if (!isTrusted(true)) return { ok: false, message: ACCESSIBILITY_MESSAGE };
  return null;
}

/** Recent spoken turns and actions, oldest first, for resolving "this" / "that one". */
export function formatHistory(history: string[] | undefined): string {
  return history && history.length > 0 ? history.join('\n') : '(none)';
}

const DRAFT_PREVIEW_CHARS = 160;

export async function voiceWrite(
  rawArgs: Record<string, unknown>,
  deps: VoiceScreenDeps
): Promise<VoiceActionResult> {
  const instruction = str(rawArgs.instruction);
  if (!instruction) return { ok: false, message: 'Say what to write.' };
  const blocked = screenPermissionBlock(deps);
  if (blocked) return blocked;

  const shot = await (deps.capture ?? ((edge: number) => captureVoiceScreenshot(edge)))(
    DRAFT_MAX_EDGE
  );
  const where = shot.target
    ? ` It will be pasted into the focused text box in ${shot.target.name}.`
    : '';
  const history = deps.getHistory?.() ?? [];
  const context =
    history.length > 0
      ? `\n\nEarlier in this voice session (use it to resolve references):\n${formatHistory(history)}`
      : '';
  const emit = (phase: VoiceDraftUpdate['phase'], text: string, note?: string) =>
    deps.onDraft?.({ phase, instruction, text, note });

  emit('drafting', '');
  let streamed = '';
  let draft: string;
  try {
    draft = (
      await deps.ask(
        `${instruction}${where}${context}`,
        SNAP_WRITE_SYSTEM_PROMPT,
        shot.image,
        1500,
        (text) => {
          streamed = text;
          emit('drafting', streamed);
        }
      )
    ).trim();
  } catch (error) {
    emit('failed', streamed, 'Drafting failed.');
    throw error;
  }
  if (!draft) {
    emit('failed', '', 'The model returned an empty draft.');
    return { ok: false, message: 'The model returned an empty draft.' };
  }

  const pasted = await (deps.pasteText ?? ((text: string) => pasteText(text)))(draft);
  if (!pasted.success) {
    logWarn('[Voice] Draft paste failed', pasted.reason);
    const message =
      pasted.reason === 'accessibility'
        ? ACCESSIBILITY_MESSAGE
        : 'Could not paste the draft. It is on the clipboard.';
    emit(
      'failed',
      draft,
      pasted.reason === 'accessibility'
        ? 'Allow Accessibility for York GrowthOS to paste. Copied to the clipboard.'
        : 'Could not paste. Copied to the clipboard.'
    );
    return { ok: false, message };
  }
  const preview =
    draft.length > DRAFT_PREVIEW_CHARS ? `${draft.slice(0, DRAFT_PREVIEW_CHARS)}…` : draft;
  const noField = shot.target && !shot.target.focusedField;
  emit(
    'pasted',
    draft,
    noField
      ? 'No text box looked focused. If nothing appeared, click the box and use Copy.'
      : undefined
  );
  return {
    ok: true,
    message: noField
      ? `Pasted the draft, but no text box looked focused; if nothing appeared, click the box and paste. Draft: ${preview}`
      : `Pasted the draft (not sent): ${preview}`,
  };
}
