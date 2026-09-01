import {
  OPENAI_REALTIME_CALLS_URL,
  parseRealtimeTranscriptionEvent,
} from '../../shared/meetings/realtime-transcription-events';

export type MeetingRealtimeStatus = 'idle' | 'connecting' | 'streaming' | 'error';

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
  private meetingId: string | null = null;
  private cancelled = false;
  private itemStartedAt = new Map<string, number>();
  private itemPartialText = new Map<string, string>();
  private status: MeetingRealtimeStatus = 'idle';

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
    this.cleanupPeer();
    this.meetingId = null;
    this.itemStartedAt.clear();
    this.itemPartialText.clear();
    this.status = 'idle';
  }

  private cleanupPeer(): void {
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

    await window.electronAPI.meetings.appendRealtimeSegment({
      meetingId,
      text: parsed.transcript,
      itemId,
      startedAt,
      endedAt,
    });
  }
}
