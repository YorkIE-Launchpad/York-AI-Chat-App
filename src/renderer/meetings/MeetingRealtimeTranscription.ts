import {
  OPENAI_REALTIME_CALLS_URL,
  parseRealtimeTranscriptionEvent,
} from '../../shared/meetings/realtime-transcription-events';

export type MeetingRealtimeStatus = 'idle' | 'connecting' | 'streaming' | 'error';

/** RMS above this counts as speech for client-side turn endpointing. */
const SPEECH_RMS_THRESHOLD = 0.02;
/** Quiet period after speech before committing the audio buffer. */
const SILENCE_HOLD_MS = 900;
/** Force a commit during continuous speech so long turns still finalize. */
const MAX_TURN_MS = 8_000;
const LEVEL_POLL_MS = 100;

async function waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') {
    return;
  }
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

export class MeetingRealtimeTranscription {
  private peer: RTCPeerConnection | null = null;
  private eventsChannel: RTCDataChannel | null = null;
  private meetingId: string | null = null;
  private cancelled = false;
  private itemStartedAt = new Map<string, number>();
  private itemPartialText = new Map<string, string>();
  private status: MeetingRealtimeStatus = 'idle';

  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelTimer: number | null = null;
  private pendingPartial = false;
  private turnStartedAt = 0;
  private lastSpeechAt = 0;
  private commitInFlight = false;

  get currentStatus(): MeetingRealtimeStatus {
    return this.status;
  }

  async start(meetingId: string, stream: MediaStream): Promise<void> {
    if (this.meetingId === meetingId && this.peer) {
      return;
    }
    await this.stop();
    this.meetingId = meetingId;
    this.cancelled = false;
    this.status = 'connecting';

    try {
      const { clientSecret } = await window.electronAPI.meetings.createRealtimeTranscriptionSession();
      if (this.cancelled || this.meetingId !== meetingId) {
        return;
      }
      if (!clientSecret) {
        throw new Error('Missing realtime client secret');
      }

      const pc = new RTCPeerConnection();
      this.peer = pc;

      for (const track of stream.getAudioTracks()) {
        pc.addTrack(track, stream);
      }

      pc.ontrack = () => {
        // Transcription-only — ignore remote audio.
      };

      const events = pc.createDataChannel('oai-events');
      this.eventsChannel = events;
      events.onmessage = (message) => {
        if (typeof message.data !== 'string') {
          return;
        }
        void this.handleRealtimeEvent(meetingId, message.data);
      };

      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === 'failed' ||
          pc.connectionState === 'disconnected' ||
          pc.connectionState === 'closed'
        ) {
          if (this.meetingId === meetingId && !this.cancelled) {
            this.status = pc.connectionState === 'failed' ? 'error' : 'idle';
            this.cleanupPeer();
          }
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGatheringComplete(pc);
      if (this.cancelled || this.meetingId !== meetingId) {
        this.cleanupPeer();
        return;
      }

      const localSdp = pc.localDescription?.sdp;
      if (!localSdp) {
        throw new Error('Failed to create WebRTC offer');
      }

      const sdpResponse = await fetch(OPENAI_REALTIME_CALLS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clientSecret}`,
          'Content-Type': 'application/sdp',
        },
        body: localSdp,
      });

      if (!sdpResponse.ok) {
        const errText = await sdpResponse.text();
        throw new Error(errText || `Realtime call failed (${sdpResponse.status})`);
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      if (this.cancelled || this.meetingId !== meetingId) {
        this.cleanupPeer();
        return;
      }

      this.startSilenceEndpointing(stream);
      this.status = 'streaming';
    } catch (error) {
      this.cleanupPeer();
      this.status = 'error';
      console.warn('[Meetings] Realtime transcription failed', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.cancelled = true;
    if (this.pendingPartial) {
      this.sendCommit();
    }
    this.stopSilenceEndpointing();
    this.cleanupPeer();
    this.meetingId = null;
    this.itemStartedAt.clear();
    this.itemPartialText.clear();
    this.pendingPartial = false;
    this.commitInFlight = false;
    this.status = 'idle';
  }

  private cleanupPeer(): void {
    this.stopSilenceEndpointing();
    this.eventsChannel = null;
    const peer = this.peer;
    this.peer = null;
    if (peer) {
      try {
        peer.close();
      } catch {
        // ignore
      }
    }
  }

  private startSilenceEndpointing(stream: MediaStream): void {
    this.stopSilenceEndpointing();
    try {
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      source.connect(this.analyser);
    } catch (error) {
      console.warn('[Meetings] Silence endpointing unavailable', error);
      return;
    }

    const data = new Uint8Array(this.analyser.fftSize);
    this.levelTimer = window.setInterval(() => {
      if (!this.analyser || this.cancelled) {
        return;
      }
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const centered = (data[i] - 128) / 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / data.length);
      const now = Date.now();

      if (rms >= SPEECH_RMS_THRESHOLD) {
        this.lastSpeechAt = now;
        if (!this.turnStartedAt) {
          this.turnStartedAt = now;
        }
      }

      if (!this.pendingPartial || this.commitInFlight) {
        return;
      }

      const quietFor = now - this.lastSpeechAt;
      const turnAge = this.turnStartedAt ? now - this.turnStartedAt : 0;
      if (quietFor >= SILENCE_HOLD_MS || turnAge >= MAX_TURN_MS) {
        this.sendCommit();
      }
    }, LEVEL_POLL_MS);
  }

  private stopSilenceEndpointing(): void {
    if (this.levelTimer !== null) {
      window.clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    this.analyser = null;
    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
  }

  private sendCommit(): void {
    const channel = this.eventsChannel;
    if (!channel || channel.readyState !== 'open') {
      return;
    }
    if (!this.pendingPartial || this.commitInFlight) {
      return;
    }
    this.commitInFlight = true;
    try {
      channel.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    } catch (error) {
      console.warn('[Meetings] Failed to commit realtime audio buffer', error);
      this.commitInFlight = false;
      return;
    }
    this.pendingPartial = false;
    this.turnStartedAt = 0;
    // Allow another commit shortly even if completed is slow/missing.
    window.setTimeout(() => {
      this.commitInFlight = false;
    }, 500);
  }

  private async handleRealtimeEvent(meetingId: string, raw: string): Promise<void> {
    const parsed = parseRealtimeTranscriptionEvent(raw);
    if (!parsed || this.meetingId !== meetingId) {
      return;
    }

    if (parsed.kind === 'delta') {
      const itemId = parsed.itemId || `partial-${Date.now()}`;
      if (!this.itemStartedAt.has(itemId)) {
        this.itemStartedAt.set(itemId, Date.now());
      }
      const previous = this.itemPartialText.get(itemId) || '';
      const next = previous + parsed.delta;
      this.itemPartialText.set(itemId, next);
      this.pendingPartial = true;
      if (!this.turnStartedAt) {
        this.turnStartedAt = Date.now();
      }
      this.lastSpeechAt = Date.now();
      await window.electronAPI.meetings.appendRealtimeTranscriptPreview({
        meetingId,
        itemId,
        partialText: next,
      });
      return;
    }

    const itemId = parsed.itemId || `item-${Date.now()}`;
    const startedAt = this.itemStartedAt.get(itemId) ?? Date.now() - 2000;
    const endedAt = Date.now();
    this.itemStartedAt.delete(itemId);
    this.itemPartialText.delete(itemId);
    this.commitInFlight = false;
    if (this.itemPartialText.size === 0) {
      this.pendingPartial = false;
      this.turnStartedAt = 0;
    }

    await window.electronAPI.meetings.appendRealtimeSegment({
      meetingId,
      text: parsed.transcript,
      itemId,
      startedAt,
      endedAt,
    });
  }
}
