export type MeetingAudioLevelListener = (rms: number) => void;

const SEGMENT_MS = 5_000;

export class MeetingAudioCapture {
  private micStream: MediaStream | null = null;
  private displayStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private analyser: AnalyserNode | null = null;
  private recorder: MediaRecorder | null = null;
  private recorderMimeType = '';
  private meetingId: string | null = null;
  private levelTimer: number | null = null;
  private rotateTimer: number | null = null;
  private rotating = false;
  private onLevel: MeetingAudioLevelListener | null = null;
  private latestRms = 0;
  private segmentPeakRms = 0;
  private pendingChunks = new Set<Promise<void>>();

  setLevelListener(listener: MeetingAudioLevelListener | null): void {
    this.onLevel = listener;
  }

  get isActive(): boolean {
    return Boolean(this.meetingId);
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

    // System/speaker audio via Electron loopback. A video track may be granted by
    // main (app frame or screen) to satisfy getDisplayMedia; we stop it immediately.
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
    // Without resume(), Chromium often leaves the context suspended → silent recordings.
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

    this.recorderMimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';

    this.beginRecorderSegment();
    this.rotateTimer = window.setInterval(() => {
      void this.rotateRecorderSegment();
    }, SEGMENT_MS);
    this.startLevelMeter();
  }

  async stop(): Promise<void> {
    if (this.rotateTimer !== null) {
      window.clearInterval(this.rotateTimer);
      this.rotateTimer = null;
    }

    if (this.levelTimer !== null) {
      window.clearInterval(this.levelTimer);
      this.levelTimer = null;
    }

    const recorder = this.recorder;
    this.recorder = null;
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        try {
          recorder.stop();
        } catch {
          resolve();
        }
      });
    }

    // Wait for final chunk uploads while meetingId is still set.
    if (this.pendingChunks.size > 0) {
      await Promise.allSettled([...this.pendingChunks]);
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
    this.recorderMimeType = '';
    this.rotating = false;
    this.latestRms = 0;
    this.onLevel?.(0);
  }

  private beginRecorderSegment(): void {
    if (!this.destination || !this.meetingId) {
      return;
    }
    this.recorder = new MediaRecorder(
      this.destination.stream,
      this.recorderMimeType ? { mimeType: this.recorderMimeType } : undefined
    );
    this.segmentPeakRms = 0;
    this.recorder.ondataavailable = (event) => {
      const task = this.handleChunk(event.data);
      this.pendingChunks.add(task);
      void task.finally(() => this.pendingChunks.delete(task));
    };
    // No timeslice: stop/restart yields a complete WebM with EBML header each segment.
    this.recorder.start();
  }

  private async rotateRecorderSegment(): Promise<void> {
    if (this.rotating || !this.meetingId || !this.destination) {
      return;
    }
    const recorder = this.recorder;
    if (!recorder || recorder.state !== 'recording') {
      return;
    }
    this.rotating = true;
    try {
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        try {
          recorder.stop();
        } catch {
          resolve();
        }
      });
      this.recorder = null;
      if (this.meetingId && this.destination) {
        this.beginRecorderSegment();
      }
    } finally {
      this.rotating = false;
    }
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
      if (this.latestRms > this.segmentPeakRms) {
        this.segmentPeakRms = this.latestRms;
      }
      this.onLevel?.(this.latestRms);
    }, 200);
  }

  private async handleChunk(blob: Blob): Promise<void> {
    const meetingId = this.meetingId;
    if (!meetingId || blob.size < 256) {
      return;
    }
    const peakRms = this.segmentPeakRms;
    this.segmentPeakRms = 0;
    const buffer = await blob.arrayBuffer();
    if (buffer.byteLength < 256) {
      return;
    }
    await window.electronAPI.meetings.appendChunk({
      meetingId,
      data: buffer,
      mimeType: blob.type || 'audio/webm',
      rms: peakRms,
    });
  }
}
