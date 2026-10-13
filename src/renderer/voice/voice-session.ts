import { OPENAI_REALTIME_CALLS_URL } from '../../shared/meetings/realtime-transcription-events';
import type { VoiceActionResult } from '../../shared/voice-control';

export type VoiceSessionStatus =
  | 'connecting'
  | 'listening'
  | 'hearing'
  | 'thinking'
  | 'acting'
  | 'speaking'
  | 'error'
  | 'ended';

export type VoiceEndReason = 'idle' | 'user' | 'stop-command' | 'error';

export interface VoiceSessionCallbacks {
  onStatus: (status: VoiceSessionStatus) => void;
  onUserTranscript: (text: string) => void;
  onAssistantText: (text: string) => void;
  onAction: (summary: string, result: VoiceActionResult) => void;
  onError: (message: string) => void;
  onEnded: (reason: VoiceEndReason) => void;
}

interface RealtimeEvent {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  error?: { message?: string };
}

async function waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve) => {
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    window.setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }, 3000);
  });
}

function playReadyChime(): void {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.28);
    gain.connect(ctx.destination);
    [660, 880].forEach((frequency, index) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      osc.connect(gain);
      osc.start(ctx.currentTime + index * 0.09);
      osc.stop(ctx.currentTime + 0.3);
    });
    window.setTimeout(() => void ctx.close().catch(() => undefined), 500);
  } catch {
    // A missing chime is not worth failing the session over.
  }
}

/**
 * One hands-free voice session: mic → OpenAI Realtime over WebRTC, model tool
 * calls bridged to the main process, and an idle timer that ends the session
 * after `followUpSeconds` without speech.
 */
export class VoiceRealtimeSession {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private micStream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private idleTimer: number | null = null;
  private ended = false;
  private userSpeaking = false;
  private responseInFlight = false;
  private assistantSpeaking = false;
  private pendingCalls: Promise<void>[] = [];
  private responseHadCalls = false;
  private stopRequested = false;
  private userTranscript = new Map<string, string>();
  private assistantText = '';

  constructor(
    private readonly followUpMs: number,
    private readonly callbacks: VoiceSessionCallbacks
  ) {}

  async start(): Promise<void> {
    this.callbacks.onStatus('connecting');
    try {
      const api = window.electronAPI.voice;
      const [{ clientSecret }, mic] = await Promise.all([
        api.createSession(),
        navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }),
      ]);
      this.micStream = mic;
      if (this.ended) {
        this.releaseMedia();
        return;
      }

      const pc = new RTCPeerConnection();
      this.peer = pc;
      for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);

      const audio = new Audio();
      audio.autoplay = true;
      this.audioEl = audio;
      pc.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? null;
      };

      const channel = pc.createDataChannel('oai-events');
      this.channel = channel;
      channel.onmessage = (message) => {
        if (typeof message.data === 'string') this.handleEvent(message.data);
      };
      channel.onopen = () => {
        playReadyChime();
        this.callbacks.onStatus('listening');
        this.scheduleIdle();
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') this.fail('Lost connection to the voice model.');
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error('Failed to create WebRTC offer');

      const response = await fetch(OPENAI_REALTIME_CALLS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${clientSecret}`, 'Content-Type': 'application/sdp' },
        body: sdp,
      });
      if (!response.ok) {
        throw new Error((await response.text()) || `Realtime call failed (${response.status})`);
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  end(reason: VoiceEndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.clearIdle();
    this.releaseMedia();
    this.callbacks.onStatus(reason === 'error' ? 'error' : 'ended');
    this.callbacks.onEnded(reason);
  }

  private fail(message: string): void {
    if (this.ended) return;
    console.warn('[Voice] Session failed', message);
    this.callbacks.onError(message);
    this.end('error');
  }

  private releaseMedia(): void {
    this.channel = null;
    try {
      this.peer?.close();
    } catch {
      // ignore
    }
    this.peer = null;
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = null;
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.srcObject = null;
      this.audioEl = null;
    }
  }

  private sendRealtimeEvent(event: Record<string, unknown>): void {
    const channel = this.channel;
    if (!channel || channel.readyState !== 'open') return;
    channel.send(JSON.stringify(event));
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Restart the follow-up window once nobody is speaking and no response is running. */
  private scheduleIdle(): void {
    this.clearIdle();
    if (this.ended || this.userSpeaking || this.responseInFlight || this.assistantSpeaking) return;
    this.idleTimer = window.setTimeout(() => this.end('idle'), this.followUpMs);
  }

  private settleStatus(): void {
    if (this.ended) return;
    if (this.userSpeaking) this.callbacks.onStatus('hearing');
    else if (this.assistantSpeaking) this.callbacks.onStatus('speaking');
    else if (this.responseInFlight) this.callbacks.onStatus('thinking');
    else this.callbacks.onStatus('listening');
    this.scheduleIdle();
  }

  private handleEvent(raw: string): void {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw) as RealtimeEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        this.userSpeaking = true;
        this.settleStatus();
        break;
      case 'input_audio_buffer.speech_stopped':
        this.userSpeaking = false;
        this.responseInFlight = true;
        this.settleStatus();
        break;
      case 'conversation.item.input_audio_transcription.delta': {
        const id = event.item_id ?? 'current';
        const next = (this.userTranscript.get(id) ?? '') + (event.delta ?? '');
        this.userTranscript.set(id, next);
        this.callbacks.onUserTranscript(next);
        break;
      }
      case 'conversation.item.input_audio_transcription.completed':
        if (event.item_id) this.userTranscript.delete(event.item_id);
        if (event.transcript) this.callbacks.onUserTranscript(event.transcript.trim());
        break;
      case 'response.created':
        this.responseInFlight = true;
        this.responseHadCalls = false;
        this.assistantText = '';
        this.settleStatus();
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta':
        this.assistantText += event.delta ?? '';
        this.callbacks.onAssistantText(this.assistantText);
        break;
      case 'output_audio_buffer.started':
        this.assistantSpeaking = true;
        this.settleStatus();
        break;
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.assistantSpeaking = false;
        this.settleStatus();
        if (this.stopRequested) this.end('stop-command');
        break;
      case 'response.function_call_arguments.done':
        this.responseHadCalls = true;
        this.pendingCalls.push(this.runCall(event));
        break;
      case 'response.done':
        void this.finishResponse();
        break;
      case 'error':
        if (event.error?.message) this.callbacks.onError(event.error.message);
        break;
      default:
        break;
    }
  }

  private async runCall(event: RealtimeEvent): Promise<void> {
    const name = event.name ?? '';
    let args: unknown = {};
    try {
      args = event.arguments ? JSON.parse(event.arguments) : {};
    } catch {
      args = {};
    }
    if (name === 'stop_listening') this.stopRequested = true;
    this.callbacks.onStatus('acting');
    const result =
      name === 'stop_listening'
        ? { ok: true, message: 'Stopping.' }
        : await window.electronAPI.voice.runAction(name, args).catch(
            (error: unknown): VoiceActionResult => ({
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            })
          );
    this.callbacks.onAction(name, result);
    this.sendRealtimeEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: event.call_id,
        output: JSON.stringify(result),
      },
    });
  }

  private async finishResponse(): Promise<void> {
    const calls = this.pendingCalls;
    this.pendingCalls = [];
    await Promise.allSettled(calls);
    if (this.ended) return;
    if (this.stopRequested) {
      // Let a spoken goodbye finish; output_audio_buffer.stopped ends the session.
      if (!this.assistantSpeaking) this.end('stop-command');
      return;
    }
    if (this.responseHadCalls) {
      this.responseHadCalls = false;
      this.sendRealtimeEvent({ type: 'response.create' });
      return;
    }
    this.responseInFlight = false;
    this.settleStatus();
  }
}
