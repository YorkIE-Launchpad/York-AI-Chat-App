import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import { BACKEND_PROXY_PLACEHOLDER_KEY, getBackendProxyBaseUrl } from '../../shared/backend-config';
import { isAuthenticated } from '../auth/session';
import { resolveBackendClientApiKey } from '../config/backend-auth';
import type { MeetingTranscriptionModel } from './meeting-types';
import { log, logWarn } from '../utils/logger';

export interface TranscriptionReadiness {
  ready: boolean;
  reason?: string;
  apiKey?: string;
  baseUrl?: string;
}

/** Shared across all meetings so concurrent captures cannot flood the backend. */
const DEFAULT_TRANSCRIPTION_CONCURRENCY = 2;

class TranscriptionRequestQueue {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }
}

const transcriptionQueue = new TranscriptionRequestQueue(DEFAULT_TRANSCRIPTION_CONCURRENCY);

/** Whisper often invents these on silence / noise — drop them. */
const WHISPER_HALLUCINATION_PATTERNS: RegExp[] = [
  /^thank you for watching\.?$/i,
  /^thanks for watching\.?$/i,
  /^thank you\.?$/i,
  /^thanks\.?$/i,
  /^please subscribe\.?$/i,
  /^subscribe\.?$/i,
  /^bye\.?$/i,
  /^goodbye\.?$/i,
  /^you$/i,
  /^\[?\s*(music|applause|silence|blank_audio)\s*\]?$/i,
];

export function sanitizeTranscriptText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }
  if (WHISPER_HALLUCINATION_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return '';
  }
  return trimmed;
}

function resolveTranscriptionReadiness(): TranscriptionReadiness {
  if (!isAuthenticated()) {
    return {
      ready: false,
      reason: 'Sign in to enable meeting transcription through the York backend.',
    };
  }

  return {
    ready: true,
    // Placeholder only — real Cognito JWT is resolved per request.
    apiKey: BACKEND_PROXY_PLACEHOLDER_KEY,
    baseUrl: getBackendProxyBaseUrl('openai'),
  };
}

export class MeetingTranscriptionService {
  getReadiness(): TranscriptionReadiness {
    return resolveTranscriptionReadiness();
  }

  async transcribeChunk(
    buffer: Buffer,
    mimeType: string,
    model: MeetingTranscriptionModel
  ): Promise<string> {
    const readiness = this.getReadiness();
    if (!readiness.ready) {
      throw new Error(readiness.reason || 'Transcription is not configured');
    }

    return transcriptionQueue.run(() => this.transcribeChunkUnqueued(buffer, mimeType, model));
  }

  private async transcribeChunkUnqueued(
    buffer: Buffer,
    mimeType: string,
    model: MeetingTranscriptionModel
  ): Promise<string> {
    const baseUrl = getBackendProxyBaseUrl('openai');
    const apiKey = await resolveBackendClientApiKey({
      provider: 'openai',
      apiKey: BACKEND_PROXY_PLACEHOLDER_KEY,
    });

    const client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
    });

    const safeType = (mimeType || 'audio/webm').split(';')[0].trim() || 'audio/webm';
    const extension = safeType.includes('wav')
      ? 'wav'
      : safeType.includes('mp4') || safeType.includes('m4a')
        ? 'm4a'
        : 'webm';
    const file = await toFile(buffer, `chunk.${extension}`, { type: safeType });

    const tryModel = async (transcriptionModel: MeetingTranscriptionModel) => {
      log(`[Meetings] Transcribing chunk via backend (${transcriptionModel})`);
      const result = await client.audio.transcriptions.create({
        file,
        model: transcriptionModel,
        // Lower temperature reduces Whisper silence hallucinations ("Thank you for watching.").
        temperature: 0,
      });
      return sanitizeTranscriptText((result.text || '').trim());
    };

    try {
      return await tryModel(model);
    } catch (error) {
      if (model !== 'whisper-1') {
        logWarn('[Meetings] Primary transcription model failed, falling back to whisper-1', error);
        return await tryModel('whisper-1');
      }
      throw error;
    }
  }
}
