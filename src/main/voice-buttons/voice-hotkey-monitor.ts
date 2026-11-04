/**
 * Spawns the macOS hold/release helper and forwards down/up events.
 * Windows uses Electron globalShortcut as a toggle instead.
 */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { listMacBundledToolsSearchRoots } from '../utils/macos-bundled-tools';
import { log, logWarn } from '../utils/logger';

export type VoiceHotkeyEvent = 'ready' | 'down' | 'up' | 'error';

export function resolveVoiceHotkeyHelperPath(): string | null {
  for (const root of listMacBundledToolsSearchRoots()) {
    const candidate = path.join(root, 'bin', 'york-voice-hotkey');
    if (existsSync(candidate)) return candidate;
  }
  const dev = path.join(process.cwd(), 'native/macos-voice-hotkey/.build/york-voice-hotkey');
  if (existsSync(dev)) return dev;
  return null;
}

export class VoiceHotkeyMonitor {
  private child: ChildProcess | null = null;
  private buffer = '';
  private accelerator: string | null = null;

  constructor(private readonly onEvent: (type: VoiceHotkeyEvent, message?: string) => void) {}

  get isRunning(): boolean {
    return Boolean(this.child && !this.child.killed);
  }

  start(accelerator: string): boolean {
    this.stop();
    if (process.platform !== 'darwin') return false;
    const helper = resolveVoiceHotkeyHelperPath();
    if (!helper) {
      this.onEvent('error', 'Hold-key helper is missing. Run npm run build:voice-hotkey.');
      return false;
    }
    let child: ChildProcess;
    try {
      this.accelerator = accelerator;
      child = spawn(helper, ['--accelerator', accelerator], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
    } catch (error) {
      logWarn('[VoiceButtons] Failed to spawn hold-key helper', error);
      this.onEvent('error', 'Could not start the hold-key helper.');
      return false;
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.consume(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      logWarn('[VoiceButtons] hold-key helper stderr', chunk.toString('utf8').trim());
    });
    child.on('exit', (code) => {
      log('[VoiceButtons] hold-key helper exited', code, this.accelerator);
      this.child = null;
      if (code && code !== 0) {
        this.onEvent('error', 'Hold-key helper stopped. Check Accessibility permission.');
      }
    });
    return true;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.buffer = '';
    this.accelerator = null;
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as { type?: string; message?: string };
        if (
          parsed.type === 'ready' ||
          parsed.type === 'down' ||
          parsed.type === 'up' ||
          parsed.type === 'error'
        ) {
          this.onEvent(parsed.type, parsed.message);
        }
      } catch {
        logWarn('[VoiceButtons] Bad hold-key helper line', line);
      }
    }
  }
}
