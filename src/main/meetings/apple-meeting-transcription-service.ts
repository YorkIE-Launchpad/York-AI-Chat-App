import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);
import { resolveMeetingSttProviderFromEnv } from '../../shared/meetings/meeting-stt-provider';
import type { MeetingSttProviderConfig } from '../../shared/meetings/meeting-stt-config';
import { DICTATION_APPLE_SESSION_ID } from '../dictation/dictation-apple-sink';
import { listMacBundledToolsSearchRoots } from '../utils/macos-bundled-tools';
import { log, logWarn } from '../utils/logger';

export type AppleTranscriptionErrorListener = (message: string) => void;

let dictationAppleErrorListener: AppleTranscriptionErrorListener | null = null;

export function setDictationAppleErrorListener(listener: AppleTranscriptionErrorListener | null): void {
  dictationAppleErrorListener = listener;
}

export interface AppleTranscriptionReadiness {
  ready: boolean;
  reason?: string;
}

export interface MeetingRealtimeTranscriptSink {
  appendRealtimeTranscriptPreview(payload: {
    meetingId: string;
    itemId?: string;
    partialText: string;
  }): Promise<{ accepted: boolean }>;
  appendRealtimeSegment(payload: {
    meetingId: string;
    text: string;
    itemId?: string;
    startedAt?: number;
    endedAt?: number;
  }): Promise<{ accepted: boolean; text?: string }>;
}

export type AppleHelperEvent =
  | { type: 'ready' }
  | { type: 'partial'; itemId: string; text: string }
  | { type: 'final'; itemId: string; text: string }
  | { type: 'error'; message: string };

const itemStartedAt = new Map<string, number>();
const finalizedItemIds = new Set<string>();

export function parseAppleHelperEventLine(line: string): AppleHelperEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  if (type === 'ready') {
    return { type: 'ready' };
  }
  if (type === 'error') {
    const message = typeof record.message === 'string' ? record.message : 'Unknown error';
    return { type: 'error', message };
  }
  if (type === 'partial' || type === 'final') {
    const text = typeof record.text === 'string' ? record.text : '';
    const itemId =
      typeof record.itemId === 'string' && record.itemId.trim()
        ? record.itemId.trim()
        : `apple-${Date.now()}`;
    if (!text.trim()) {
      return null;
    }
    return type === 'partial'
      ? { type: 'partial', itemId, text }
      : { type: 'final', itemId, text };
  }
  return null;
}

export function isMacOs26OrNewer(): boolean {
  if (process.platform !== 'darwin') {
    return false;
  }
  const version =
    typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '';
  const major = Number.parseInt(version.split('.')[0] || '0', 10);
  return Number.isFinite(major) && major >= 26;
}

const SPEECH_HELPER_APP_BUNDLE_NAMES = ['York GrowthOS.app', 'MeetingSpeechTranscriber.app'];

function bundledSpeechTranscriberExecutable(bundleName: string): string {
  return path.join(bundleName, 'Contents', 'MacOS', 'meeting-speech-transcriber');
}

/** Prefer the signed .app executable (TCC + Speech Recognition). */
export function resolveMeetingSpeechTranscriberPath(): string | null {
  if (process.platform !== 'darwin') {
    return null;
  }
  const candidates: string[] = [];

  const pushBundledCandidates = (toolsRoot: string) => {
    for (const bundleName of SPEECH_HELPER_APP_BUNDLE_NAMES) {
      candidates.push(path.join(toolsRoot, bundledSpeechTranscriberExecutable(bundleName)));
    }
    candidates.push(path.join(toolsRoot, 'bin', 'meeting-speech-transcriber'));
  };

  const projectRootGuesses = [
    path.join(__dirname, '../../../resources/tools'),
    path.join(process.cwd(), 'resources/tools'),
  ];
  for (const toolsRoot of listMacBundledToolsSearchRoots(projectRootGuesses)) {
    pushBundledCandidates(toolsRoot);
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // continue
    }
  }
  return null;
}

export function resolveMeetingSpeechTranscriberAppBundle(): string | null {
  const executable = resolveMeetingSpeechTranscriberPath();
  if (!executable) {
    return null;
  }
  const macOsDir = path.dirname(executable);
  if (path.basename(macOsDir) !== 'MacOS') {
    return null;
  }
  const appRoot = path.dirname(path.dirname(macOsDir));
  if (!appRoot.endsWith('.app')) {
    return null;
  }
  return appRoot;
}

export function checkAppleTranscriptionReadiness(): AppleTranscriptionReadiness {
  if (process.platform !== 'darwin') {
    return {
      ready: false,
      reason: 'On-device Apple transcription is only available on macOS.',
    };
  }
  if (!isMacOs26OrNewer()) {
    return {
      ready: false,
      reason: 'On-device Apple transcription requires macOS 26 or later.',
    };
  }
  if (!resolveMeetingSpeechTranscriberPath()) {
    return {
      ready: false,
      reason: 'Meeting speech transcriber helper is not installed.',
    };
  }
  return { ready: true };
}

export function getMeetingSttProviderConfig(): MeetingSttProviderConfig {
  const requested = resolveMeetingSttProviderFromEnv();
  const appleSupported =
    process.platform === 'darwin' &&
    isMacOs26OrNewer() &&
    Boolean(resolveMeetingSpeechTranscriberPath());
  return {
    requested,
    platform: process.platform,
    appleSupported,
  };
}

export class AppleMeetingTranscriptionService {
  /** One-shot Speech Recognition prompt (optional; live sessions authorize in the helper). */
  async requestSpeechAccess(): Promise<void> {
    await this.requestSpeechAuthorizationIfNeeded();
  }

  private async requestSpeechAuthorizationIfNeeded(): Promise<void> {
    const appBundle = resolveMeetingSpeechTranscriberAppBundle();
    const helperPath = resolveMeetingSpeechTranscriberPath();
    if (!helperPath) {
      return;
    }
    try {
      if (appBundle) {
        // Launch as a real .app so macOS loads Info.plist and shows the Speech Recognition prompt.
        await execFileAsync(
          'open',
          ['-g', '-j', '-W', '-n', appBundle, '--args', '--authorize-only'],
          { timeout: 120_000, maxBuffer: 256_000 }
        );
        return;
      }
      await execFileAsync(helperPath, ['--authorize-only'], {
        timeout: 120_000,
        maxBuffer: 256_000,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Speech recognition authorization failed';
      throw new Error(message);
    }
  }

  private helperSocket: net.Socket | null = null;
  private helperSocketPath: string | null = null;
  private meetingId: string | null = null;
  private sink: MeetingRealtimeTranscriptSink | null = null;
  private stdoutBuffer = '';
  private ready = false;
  private startPromise: Promise<void> | null = null;
  private pendingStartFinish: ((error?: Error) => void) | null = null;
  private lastHelperError: string | null = null;
  private helperDataHandler: ((chunk: Buffer) => void) | null = null;

  isRunning(): boolean {
    return Boolean(this.helperSocket && this.meetingId);
  }

  /** macOS TCC requires launching the helper via `open` (not direct spawn) for Speech APIs. */
  private async connectHelperViaAppBundle(): Promise<net.Socket> {
    const appBundle = resolveMeetingSpeechTranscriberAppBundle();
    if (!appBundle) {
      throw new Error(
        'York GrowthOS speech helper is missing. Run npm run build:speech-transcriber.'
      );
    }

    const socketPath = path.join(
      os.tmpdir(),
      `york-speech-${crypto.randomBytes(8).toString('hex')}.sock`
    );
    this.helperSocketPath = socketPath;

    return await new Promise<net.Socket>((resolve, reject) => {
      const server = net.createServer((socket) => {
        clearTimeout(timeout);
        server.close();
        try {
          fs.unlinkSync(socketPath);
        } catch {
          // ignore
        }
        resolve(socket);
      });

      const fail = (error: Error) => {
        server.close();
        try {
          fs.unlinkSync(socketPath);
        } catch {
          // ignore
        }
        reject(error);
      };

      const timeout = setTimeout(() => {
        fail(new Error('Apple transcription helper did not connect'));
      }, 120_000);

      server.once('error', (error) => {
        clearTimeout(timeout);
        fail(error);
      });

      server.listen(socketPath, async () => {
        try {
          // -g -j: background agent (pairs with LSUIElement — no Dock icon).
          await execFileAsync(
            'open',
            ['-g', '-j', '-n', appBundle, '--args', '--socket', socketPath],
            { timeout: 15_000 }
          );
        } catch (error) {
          clearTimeout(timeout);
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  async start(meetingId: string, sink: MeetingRealtimeTranscriptSink): Promise<void> {
    if (this.helperSocket && this.meetingId === meetingId && this.ready) {
      return;
    }
    await this.stop();

    const readiness = checkAppleTranscriptionReadiness();
    if (!readiness.ready) {
      throw new Error(readiness.reason || 'Apple transcription is not available');
    }

    if (!resolveMeetingSpeechTranscriberPath()) {
      throw new Error('Meeting speech transcriber helper is not installed.');
    }

    this.meetingId = meetingId;
    this.sink = sink;
    this.ready = false;
    this.lastHelperError = null;
    itemStartedAt.clear();
    finalizedItemIds.clear();

    const socket = await this.connectHelperViaAppBundle();
    this.helperSocket = socket;

    socket.on('error', (error) => {
      logWarn('[Meetings] Apple STT helper socket error', error);
    });

    socket.on('close', () => {
      this.helperSocket = null;
      this.ready = false;
    });

    this.helperDataHandler = (chunk: Buffer) => {
      void this.handleStdout(chunk.toString('utf8'));
    };
    socket.on('data', this.helperDataHandler);

    this.startPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.pendingStartFinish = null;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      this.pendingStartFinish = finish;

      const timeout = setTimeout(() => {
        finish(
          new Error(
            this.lastHelperError || 'Apple transcription helper did not become ready in time'
          )
        );
      }, 120_000);

      socket.once('close', () => {
        if (!this.ready && !settled) {
          finish(
            new Error(
              this.lastHelperError || 'Apple transcription helper closed before ready'
            )
          );
        }
      });
    });

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
      this.pendingStartFinish = null;
    }
    log(`[Meetings] Apple on-device transcription started for ${meetingId}`);
  }

  pushPcm(pcm16: Buffer): void {
    const socket = this.helperSocket;
    if (!socket?.writable || !this.ready) {
      return;
    }
    const header = Buffer.alloc(4);
    header.writeUInt32LE(pcm16.length, 0);
    try {
      socket.write(Buffer.concat([header, pcm16]));
    } catch (error) {
      logWarn('[Meetings] Failed to write PCM to Apple STT helper', error);
    }
  }

  async stop(): Promise<void> {
    const socket = this.helperSocket;
    const socketPath = this.helperSocketPath;
    this.helperSocket = null;
    this.helperSocketPath = null;
    this.meetingId = null;
    this.sink = null;
    this.ready = false;
    this.stdoutBuffer = '';
    itemStartedAt.clear();
    finalizedItemIds.clear();

    if (!socket) {
      return;
    }

    if (this.helperDataHandler) {
      socket.off('data', this.helperDataHandler);
      this.helperDataHandler = null;
    }

    try {
      socket.end();
    } catch {
      // ignore
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        resolve();
      }, 2000);
      socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    if (socketPath) {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // ignore
      }
    }
  }

  private async handleStdout(chunk: string): Promise<void> {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      await this.handleEventLine(line);
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  private async handleEventLine(line: string): Promise<void> {
    const event = parseAppleHelperEventLine(line);
    if (!event) {
      return;
    }

    const meetingId = this.meetingId;
    const sink = this.sink;
    if (!meetingId || !sink) {
      return;
    }

    if (event.type === 'ready') {
      this.ready = true;
      if (this.pendingStartFinish) {
        this.pendingStartFinish();
      }
      return;
    }

    if (event.type === 'error') {
      this.lastHelperError = event.message;
      logWarn('[Meetings] Apple STT helper error', event.message);
      if (!this.ready && this.pendingStartFinish) {
        this.pendingStartFinish(new Error(event.message));
      }
      if (meetingId === DICTATION_APPLE_SESSION_ID) {
        dictationAppleErrorListener?.(event.message);
      }
      return;
    }

    if (event.type === 'partial') {
      if (!itemStartedAt.has(event.itemId)) {
        itemStartedAt.set(event.itemId, Date.now());
      }
      await sink.appendRealtimeTranscriptPreview({
        meetingId,
        itemId: event.itemId,
        partialText: event.text,
      });
      return;
    }

    if (finalizedItemIds.has(event.itemId)) {
      return;
    }
    finalizedItemIds.add(event.itemId);

    const startedAt = itemStartedAt.get(event.itemId) ?? Date.now() - 1500;
    itemStartedAt.delete(event.itemId);
    await sink.appendRealtimeSegment({
      meetingId,
      text: event.text,
      itemId: event.itemId,
      startedAt,
      endedAt: Date.now(),
    });
  }
}

export const appleMeetingTranscriptionService = new AppleMeetingTranscriptionService();
