import { MeetingRealtimeTranscription } from './MeetingRealtimeTranscription';

export type MeetingAudioLevelListener = (rms: number) => void;

const realtime = new MeetingRealtimeTranscription();

export class MeetingAudioCapture {
  private micStream: MediaStream | null = null;
  private displayStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meetingId: string | null = null;
  private levelTimer: number | null = null;
  private onLevel: MeetingAudioLevelListener | null = null;
  private latestRms = 0;
  private realtimeActive = false;

  setLevelListener(listener: MeetingAudioLevelListener | null): void {
    this.onLevel = listener;
  }

  get isActive(): boolean {
    return Boolean(this.meetingId);
  }

  get mixedStream(): MediaStream | null {
    return this.destination?.stream ?? null;
  }

  async start(meetingId: string): Promise<void> {
    await this.stop();
    this.meetingId = meetingId;

    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    try {
      this.displayStream = await navigator.mediaDevices.getDisplayMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as MediaTrackConstraints,
        video: true,
      });
      for (const track of this.displayStream.getVideoTracks()) {
        track.stop();
      }
      if (this.displayStream.getAudioTracks().length === 0) {
        for (const track of this.displayStream.getTracks()) {
          track.stop();
        }
        this.displayStream = null;
      }
    } catch (error) {
      console.warn('[Meetings] System audio unavailable; continuing with microphone only', error);
      this.displayStream = null;
    }

    this.audioContext = new AudioContext();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    this.destination = this.audioContext.createMediaStreamDestination();
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 2048;

    const micSource = this.audioContext.createMediaStreamSource(this.micStream);
    micSource.connect(this.destination);
    micSource.connect(this.analyser);

    const systemAudioTracks = this.displayStream?.getAudioTracks() || [];
    if (systemAudioTracks.length > 0) {
      const systemStream = new MediaStream(systemAudioTracks);
      const systemSource = this.audioContext.createMediaStreamSource(systemStream);
      systemSource.connect(this.destination);
      systemSource.connect(this.analyser);
    }

    this.startLevelMeter();
  }

  async startRealtimeTranscription(): Promise<void> {
    const meetingId = this.meetingId;
    const stream = this.mixedStream;
    if (!meetingId || !stream) {
      return;
    }
    if (this.realtimeActive) {
      return;
    }
    this.realtimeActive = true;
    try {
      await realtime.start(meetingId, stream);
    } catch (error) {
      this.realtimeActive = false;
      throw error;
    }
  }

  async stopRealtimeTranscription(): Promise<void> {
    this.realtimeActive = false;
    await realtime.stop();
  }

  async stop(): Promise<void> {
    await this.stopRealtimeTranscription();

    if (this.levelTimer !== null) {
      window.clearInterval(this.levelTimer);
      this.levelTimer = null;
    }

    for (const stream of [this.micStream, this.displayStream]) {
      if (!stream) continue;
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    this.micStream = null;
    this.displayStream = null;

    if (this.audioContext) {
      await this.audioContext.close().catch(() => undefined);
    }
    this.audioContext = null;
    this.destination = null;
    this.analyser = null;
    this.meetingId = null;
    this.latestRms = 0;
    this.onLevel?.(0);
  }

  private startLevelMeter(): void {
    if (!this.analyser) return;
    const data = new Uint8Array(this.analyser.fftSize);
    this.levelTimer = window.setInterval(() => {
      if (!this.analyser) return;
      this.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const centered = (data[i] - 128) / 128;
        sum += centered * centered;
      }
      this.latestRms = Math.sqrt(sum / data.length);
      this.onLevel?.(this.latestRms);
    }, 200);
  }
}
