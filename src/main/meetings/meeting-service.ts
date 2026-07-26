import { randomUUID } from 'crypto';
import { systemPreferences } from 'electron';
import { configStore, type MeetingsRuntimeConfig } from '../config/config-store';
import { log, logWarn } from '../utils/logger';
import { MeetingNotesService } from './meeting-notes-service';
import { detectMeetingApps, detectZoomMicUsage } from './meeting-mic-detector';
import { MeetingStore } from './meeting-store';
import { MeetingTranscriptionService } from './meeting-transcription-service';
import type { MemoryService } from '../memory/memory-service';
import type {
  MeetingCaptureStatus,
  MeetingListItem,
  MeetingOverview,
  MeetingPermissionStatus,
  MeetingSegment,
  MeetingSession,
  MeetingTranscriptionModel,
} from './meeting-types';

type StatusListener = (status: MeetingCaptureStatus) => void;
type SegmentListener = (payload: {
  meetingId: string;
  segment: MeetingSegment;
  liveTranscript: string;
}) => void;
type NotesListener = (meeting: MeetingSession) => void;
type DetectionListener = (payload: { apps: string[]; newlyDetected: string[] }) => void;
type AutoCaptureListener = () => void;

const DETECTION_POLL_MS = 12_000;
/** Poll faster while capturing so leaving a Zoom call is noticed sooner. */
const DETECTION_POLL_ACTIVE_MS = 5_000;
/** Don't re-notify / re-auto-start the same app more often than this. */
const DETECTION_NOTIFY_COOLDOWN_MS = 60 * 1000;
/** Require this many consecutive "gone" polls before auto-stop. */
const ZOOM_ABSENT_POLLS_BEFORE_STOP = 2;

function defaultRuntime(): MeetingsRuntimeConfig {
  return {
    transcriptionModel: 'gpt-4o-transcribe',
    allowChatReference: true,
    ingestIntoGlobalMemory: true,
    recentMeetingCount: 5,
    processDetectEnabled: true,
    storageRoot: '',
  };
}

function mediaAccessStatus(
  mediaType: 'microphone' | 'screen'
): MeetingPermissionStatus['microphone'] {
  try {
    if (process.platform === 'linux') {
      return 'unknown';
    }
    const status = systemPreferences.getMediaAccessStatus(mediaType);
    if (
      status === 'not-determined' ||
      status === 'granted' ||
      status === 'denied' ||
      status === 'restricted'
    ) {
      return status;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Prompt for microphone access only.
 * System audio (speakers) is attached at capture time via Electron loopback — no screen share UI.
 */
export class MeetingService {
  private readonly store = new MeetingStore();
  private readonly transcription = new MeetingTranscriptionService();
  private readonly notes = new MeetingNotesService();
  private memoryService: MemoryService | null = null;
  private activeMeetingId: string | null = null;
  private activeStartedAt: number | null = null;
  private liveTranscript = '';
  private captureError?: string;
  private statusListeners = new Set<StatusListener>();
  private segmentListeners = new Set<SegmentListener>();
  private notesListeners = new Set<NotesListener>();
  private detectionListeners = new Set<DetectionListener>();
  private autoStartListeners = new Set<AutoCaptureListener>();
  private autoStopListeners = new Set<AutoCaptureListener>();
  private lastDetectedApps: string[] = [];
  private detectionTimer: ReturnType<typeof setInterval> | null = null;
  private detectionBootstrapped = false;
  private lastNotifiedAt = new Map<string, number>();
  private zoomAbsentPolls = 0;
  private pendingRendererAutoStop = false;
  private detectionPollMs = DETECTION_POLL_MS;
  private micProbeUnavailableLogged = false;
  /** Raw audio kept for finalize retry when live STT produced no text. */
  private pendingAudioChunks: Array<{ buffer: Buffer; mimeType: string }> = [];
  private pendingTranscriptions = new Set<Promise<unknown>>();

  setMemoryService(service: MemoryService | null): void {
    this.memoryService = service;
  }

  isEnabled(): boolean {
    return configStore.get('meetingsEnabled') !== false;
  }

  setEnabled(enabled: boolean): { success: boolean; enabled: boolean } {
    configStore.update({ meetingsEnabled: enabled });
    if (!enabled && this.activeMeetingId) {
      void this.stop().catch((error) => {
        logWarn('[Meetings] Failed to stop capture after disable', error);
      });
    }
    this.syncDetectionPolling();
    return { success: true, enabled: this.isEnabled() };
  }

  getRuntime(): MeetingsRuntimeConfig {
    const runtime = configStore.get('meetingsRuntime') as MeetingsRuntimeConfig | undefined;
    return { ...defaultRuntime(), ...(runtime || {}) };
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onSegment(listener: SegmentListener): () => void {
    this.segmentListeners.add(listener);
    return () => this.segmentListeners.delete(listener);
  }

  onNotesReady(listener: NotesListener): () => void {
    this.notesListeners.add(listener);
    return () => this.notesListeners.delete(listener);
  }

  onMeetingDetected(listener: DetectionListener): () => void {
    this.detectionListeners.add(listener);
    return () => this.detectionListeners.delete(listener);
  }

  onAutoStartRequested(listener: AutoCaptureListener): () => void {
    this.autoStartListeners.add(listener);
    return () => this.autoStartListeners.delete(listener);
  }

  onAutoStopRequested(listener: AutoCaptureListener): () => void {
    this.autoStopListeners.add(listener);
    return () => this.autoStopListeners.delete(listener);
  }

  /** Start/stop background meeting-app detection based on settings. */
  syncDetectionPolling(): void {
    const shouldPoll = this.isEnabled() && this.getRuntime().processDetectEnabled !== false;
    if (shouldPoll) {
      this.restartDetectionTimer(
        this.activeMeetingId ? DETECTION_POLL_ACTIVE_MS : DETECTION_POLL_MS
      );
      void this.pollMeetingDetection();
      return;
    }
    this.clearDetectionTimer();
    this.lastDetectedApps = [];
    this.detectionBootstrapped = false;
    this.zoomAbsentPolls = 0;
    this.pendingRendererAutoStop = false;
  }

  private clearDetectionTimer(): void {
    if (this.detectionTimer) {
      clearInterval(this.detectionTimer);
      this.detectionTimer = null;
    }
  }

  private restartDetectionTimer(intervalMs: number): void {
    if (this.detectionTimer && this.detectionPollMs === intervalMs) {
      return;
    }
    this.clearDetectionTimer();
    this.detectionPollMs = intervalMs;
    this.detectionTimer = setInterval(() => {
      void this.pollMeetingDetection();
    }, intervalMs);
  }

  getCaptureStatus(): MeetingCaptureStatus {
    return {
      active: Boolean(this.activeMeetingId),
      meetingId: this.activeMeetingId,
      startedAt: this.activeStartedAt,
      segmentCount: this.activeMeetingId
        ? this.store.get(this.activeMeetingId)?.segments.length || 0
        : 0,
      liveTranscript: this.liveTranscript,
      error: this.captureError,
    };
  }

  private emitStatus(): void {
    const status = this.getCaptureStatus();
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch (error) {
        logWarn('[Meetings] Status listener failed', error);
      }
    }
  }

  getPermissions(): MeetingPermissionStatus {
    return {
      microphone: mediaAccessStatus('microphone'),
      screen: mediaAccessStatus('screen'),
    };
  }

  /**
   * Prompt for microphone access. System/speaker audio is acquired at capture start (loopback).
   */
  async requestMicrophoneAccess(): Promise<MeetingPermissionStatus> {
    const result = await this.requestCapturePermissions();
    return result.permissions;
  }

  async requestCapturePermissions(): Promise<{
    permissions: MeetingPermissionStatus;
    requestedMicrophone: boolean;
    requestedScreen: boolean;
  }> {
    const before = this.getPermissions();
    let requestedMicrophone = false;

    if (before.microphone !== 'granted') {
      try {
        if (process.platform === 'darwin') {
          await systemPreferences.askForMediaAccess('microphone');
          requestedMicrophone = true;
        } else if (process.platform === 'win32') {
          requestedMicrophone = true;
        }
      } catch (error) {
        logWarn('[Meetings] askForMediaAccess(microphone) failed', error);
      }
    }

    return {
      permissions: this.getPermissions(),
      requestedMicrophone,
      requestedScreen: false,
    };
  }

  isChatReferenceAllowed(): boolean {
    return this.isEnabled() && this.getRuntime().allowChatReference !== false;
  }

  async getOverview(): Promise<MeetingOverview> {
    const runtime = this.getRuntime();
    const readiness = this.transcription.getReadiness();
    const detectedMeetingApps =
      this.isEnabled() && runtime.processDetectEnabled
        ? this.lastDetectedApps.length
          ? this.lastDetectedApps
          : await detectMeetingApps()
        : [];

    return {
      enabled: this.isEnabled(),
      allowChatReference: runtime.allowChatReference !== false,
      processDetectEnabled: runtime.processDetectEnabled !== false,
      transcriptionModel: runtime.transcriptionModel || 'gpt-4o-transcribe',
      storageRoot: this.store.getStorageRoot(),
      meetingCount: this.store.list().length,
      transcriptionReady: readiness.ready,
      transcriptionReadyReason: readiness.reason,
      permissions: this.getPermissions(),
      capture: this.getCaptureStatus(),
      detectedMeetingApps,
    };
  }

  private async pollMeetingDetection(): Promise<void> {
    if (!this.isEnabled() || this.getRuntime().processDetectEnabled === false) {
      return;
    }

    if (process.platform !== 'darwin') {
      // Mic-process probe is macOS-only; avoid false starts from process heuristics.
      return;
    }

    const usage = await detectZoomMicUsage();
    if (!usage.probeAvailable) {
      if (!this.micProbeUnavailableLogged) {
        this.micProbeUnavailableLogged = true;
        logWarn('[Meetings] meeting-mic-probe unavailable — auto Zoom detect disabled');
      }
      return;
    }
    this.micProbeUnavailableLogged = false;

    const apps = usage.zoomUsingMic ? ['Zoom'] : [];
    const previous = this.lastDetectedApps;
    const newlyDetected = apps.filter((app) => !previous.includes(app));
    const wasBootstrapping = !this.detectionBootstrapped;
    this.lastDetectedApps = apps;
    this.detectionBootstrapped = true;

    if (this.activeMeetingId) {
      this.restartDetectionTimer(DETECTION_POLL_ACTIVE_MS);
      // Granola-style: stop when Zoom releases the microphone.
      if (!usage.zoomUsingMic) {
        this.zoomAbsentPolls += 1;
        log(
          `[Meetings] Zoom mic released absentPolls=${this.zoomAbsentPolls}/${ZOOM_ABSENT_POLLS_BEFORE_STOP} ` +
            `mode=${usage.mode} micProcesses=${usage.processes.length}`
        );
        if (
          this.zoomAbsentPolls >= ZOOM_ABSENT_POLLS_BEFORE_STOP &&
          !this.pendingRendererAutoStop
        ) {
          this.pendingRendererAutoStop = true;
          log('[Meetings] Zoom stopped using microphone — requesting auto-stop');
          this.emitAutoStop();
        }
      } else {
        if (this.zoomAbsentPolls > 0) {
          log('[Meetings] Zoom still using microphone while capturing');
        }
        this.zoomAbsentPolls = 0;
        this.pendingRendererAutoStop = false;
      }
      return;
    }

    this.restartDetectionTimer(DETECTION_POLL_MS);
    this.zoomAbsentPolls = 0;
    this.pendingRendererAutoStop = false;

    const toStart = wasBootstrapping
      ? apps.filter((app) => app === 'Zoom' && this.shouldNotifyForApp(app))
      : newlyDetected.filter((app) => app === 'Zoom' && this.shouldNotifyForApp(app));

    if (!toStart.length) {
      return;
    }

    for (const app of toStart) {
      this.lastNotifiedAt.set(app, Date.now());
    }

    log(
      `[Meetings] Zoom using microphone — requesting auto-start ` +
        `(mode=${usage.mode} processes=${usage.processes.map((p) => p.name || p.pid).join(',')})`
    );
    const payload = { apps, newlyDetected: toStart };
    for (const listener of this.detectionListeners) {
      try {
        listener(payload);
      } catch (error) {
        logWarn('[Meetings] Detection listener failed', error);
      }
    }
    this.emitAutoStart();
  }

  private emitAutoStart(): void {
    for (const listener of this.autoStartListeners) {
      try {
        listener();
      } catch (error) {
        logWarn('[Meetings] Auto-start listener failed', error);
      }
    }
  }

  private emitAutoStop(): void {
    for (const listener of this.autoStopListeners) {
      try {
        listener();
      } catch (error) {
        logWarn('[Meetings] Auto-stop listener failed', error);
      }
    }
  }

  private shouldNotifyForApp(app: string): boolean {
    const last = this.lastNotifiedAt.get(app) || 0;
    return Date.now() - last >= DETECTION_NOTIFY_COOLDOWN_MS;
  }

  list(): MeetingListItem[] {
    return this.store.list();
  }

  get(id: string): MeetingSession | null {
    return this.store.get(id);
  }

  search(query: string, limit?: number): MeetingListItem[] {
    return this.store.search(query, limit);
  }

  delete(id: string): { success: boolean } {
    if (this.activeMeetingId === id) {
      throw new Error('Cannot delete an active meeting capture');
    }
    this.store.delete(id);
    return { success: true };
  }

  clearAll(): { success: boolean; deleted: number } {
    if (this.activeMeetingId) {
      throw new Error('Stop the active meeting capture before clearing meetings');
    }
    return this.store.clearAll();
  }

  formatMeetingForPrompt(meeting: MeetingSession, includeTranscript = false): string {
    const title = meeting.notes?.title || meeting.title;
    const date = new Date(meeting.startedAt).toISOString();
    const summary = meeting.notes?.summary || '(no summary)';
    const lines = [
      `Meeting id: ${meeting.id}`,
      `Title: ${title}`,
      `Date: ${date}`,
      `Summary: ${summary}`,
    ];
    if (meeting.notes?.keyTopics?.length) {
      lines.push(`Key topics: ${meeting.notes.keyTopics.join('; ')}`);
    }
    if (meeting.notes?.actionItems?.length) {
      lines.push(`Action items: ${meeting.notes.actionItems.join('; ')}`);
    }
    if (includeTranscript) {
      lines.push(`Raw transcript:\n${meeting.transcriptText || '(empty)'}`);
    }
    return lines.join('\n');
  }

  async start(title?: string): Promise<MeetingSession> {
    if (!this.isEnabled()) {
      throw new Error('Meeting capture is disabled in Settings');
    }
    if (this.activeMeetingId) {
      throw new Error('A meeting capture is already active');
    }

    const readiness = this.transcription.getReadiness();
    if (!readiness.ready) {
      throw new Error(readiness.reason || 'Transcription is not configured');
    }

    await this.requestMicrophoneAccess();

    const now = Date.now();
    const meeting: MeetingSession = {
      id: randomUUID(),
      title: title?.trim() || `Meeting ${new Date(now).toLocaleString()}`,
      status: 'recording',
      createdAt: now,
      startedAt: now,
      segments: [],
      transcriptText: '',
      updatedAt: now,
    };

    this.store.save(meeting);
    this.activeMeetingId = meeting.id;
    this.activeStartedAt = now;
    this.liveTranscript = '';
    this.captureError = undefined;
    this.pendingAudioChunks = [];
    this.pendingTranscriptions.clear();
    this.zoomAbsentPolls = 0;
    this.pendingRendererAutoStop = false;
    this.emitStatus();
    if (this.isEnabled() && this.getRuntime().processDetectEnabled !== false) {
      this.restartDetectionTimer(DETECTION_POLL_ACTIVE_MS);
    }
    log(`[Meetings] Started capture ${meeting.id}`);
    return meeting;
  }

  async appendChunk(payload: {
    meetingId: string;
    data: ArrayBuffer | Buffer | Uint8Array;
    mimeType?: string;
    rms?: number;
  }): Promise<{ accepted: boolean; text?: string }> {
    if (!this.isEnabled()) {
      return { accepted: false };
    }
    if (!this.activeMeetingId || payload.meetingId !== this.activeMeetingId) {
      return { accepted: false };
    }

    // Skip near-silent chunks — Whisper often hallucinates on quiet audio.
    if (typeof payload.rms === 'number' && payload.rms < 0.02) {
      return { accepted: false };
    }

    const meeting = this.store.get(payload.meetingId);
    if (!meeting || meeting.status !== 'recording') {
      return { accepted: false };
    }

    const buffer = Buffer.isBuffer(payload.data)
      ? payload.data
      : Buffer.from(
          payload.data instanceof ArrayBuffer ? new Uint8Array(payload.data) : payload.data
        );

    // ~5s webm/opus segments should be larger; tiny blobs are usually empty.
    if (buffer.byteLength < 1500) {
      return { accepted: false };
    }

    const mimeType = payload.mimeType || 'audio/webm';
    this.bufferAudioChunk(buffer, mimeType);

    const task = this.transcribeAndAttach(meeting.id, buffer, mimeType);
    this.pendingTranscriptions.add(task);
    void task.finally(() => this.pendingTranscriptions.delete(task));
    return task;
  }

  private bufferAudioChunk(buffer: Buffer, mimeType: string): void {
    this.pendingAudioChunks.push({ buffer, mimeType });
    // Cap retained audio to avoid unbounded memory (~last ~5 minutes of 2s chunks).
    const maxChunks = 150;
    if (this.pendingAudioChunks.length > maxChunks) {
      this.pendingAudioChunks.splice(0, this.pendingAudioChunks.length - maxChunks);
    }
  }

  private async transcribeAndAttach(
    meetingId: string,
    buffer: Buffer,
    mimeType: string
  ): Promise<{ accepted: boolean; text?: string }> {
    const meeting = this.store.get(meetingId);
    if (!meeting || (meeting.status !== 'recording' && meeting.status !== 'finalizing')) {
      return { accepted: false };
    }

    const runtime = this.getRuntime();
    const model = (runtime.transcriptionModel || 'gpt-4o-transcribe') as MeetingTranscriptionModel;

    try {
      const text = await this.transcription.transcribeChunk(buffer, mimeType, model);
      if (!text) {
        return { accepted: false };
      }

      const latest = this.store.get(meetingId);
      if (!latest) {
        return { accepted: false };
      }

      const now = Date.now();
      const segment: MeetingSegment = {
        id: randomUUID(),
        text,
        startedAt: now - 5_000,
        endedAt: now,
        createdAt: now,
      };

      latest.segments.push(segment);
      latest.transcriptText = latest.segments.map((item) => item.text).join('\n');
      latest.updatedAt = now;
      this.store.save(latest);
      this.liveTranscript = latest.transcriptText;
      this.captureError = undefined;

      for (const listener of this.segmentListeners) {
        try {
          listener({
            meetingId: latest.id,
            segment,
            liveTranscript: this.liveTranscript,
          });
        } catch (error) {
          logWarn('[Meetings] Segment listener failed', error);
        }
      }
      this.emitStatus();
      return { accepted: true, text };
    } catch (error) {
      this.captureError = error instanceof Error ? error.message : String(error);
      this.emitStatus();
      logWarn('[Meetings] Chunk transcription failed', error);
      return { accepted: false };
    }
  }

  async stop(): Promise<MeetingSession | null> {
    const meetingId = this.activeMeetingId;
    if (!meetingId) {
      return null;
    }

    const meeting = this.store.get(meetingId);
    this.activeMeetingId = null;
    this.activeStartedAt = null;
    this.zoomAbsentPolls = 0;
    this.pendingRendererAutoStop = false;
    this.emitStatus();
    if (this.isEnabled() && this.getRuntime().processDetectEnabled !== false) {
      this.restartDetectionTimer(DETECTION_POLL_MS);
    }

    if (!meeting) {
      this.pendingAudioChunks = [];
      return null;
    }

    const endedAt = Date.now();
    meeting.status = 'finalizing';
    meeting.endedAt = endedAt;
    meeting.durationMs = Math.max(0, endedAt - meeting.startedAt);
    meeting.updatedAt = endedAt;
    this.store.save(meeting);

    // Wait for in-flight live STT, then retry buffered audio if transcript is still empty.
    if (this.pendingTranscriptions.size > 0) {
      await Promise.allSettled([...this.pendingTranscriptions]);
    }

    let current = this.store.get(meetingId) || meeting;
    if (!current.transcriptText.trim() && this.pendingAudioChunks.length > 0) {
      log(
        `[Meetings] Live transcript empty — retrying ${this.pendingAudioChunks.length} buffered chunk(s)`
      );
      for (const chunk of this.pendingAudioChunks) {
        await this.transcribeAndAttach(meetingId, chunk.buffer, chunk.mimeType);
      }
      current = this.store.get(meetingId) || current;
    }
    this.pendingAudioChunks = [];
    this.pendingTranscriptions.clear();

    try {
      // Ensure transcriptText is always a string (Granola raw artifact).
      current.transcriptText = current.transcriptText || '';
      current.segments = Array.isArray(current.segments) ? current.segments : [];

      const notes = await this.notes.generateNotes(current);
      // Always persist notes object on ready — never leave notes undefined.
      current.notes = {
        title: notes.title?.trim() || `Meeting ${new Date(current.startedAt).toLocaleString()}`,
        summary:
          notes.summary?.trim() ||
          current.transcriptText.slice(0, 500) ||
          'No speech was transcribed for this meeting.',
        actionItems: Array.isArray(notes.actionItems) ? notes.actionItems : [],
        keyTopics: Array.isArray(notes.keyTopics) ? notes.keyTopics : [],
        generatedAt: notes.generatedAt || Date.now(),
      };
      current.title = current.notes.title;
      current.status = 'ready';
      current.updatedAt = Date.now();
      this.store.save(current);
      this.liveTranscript = current.transcriptText;

      for (const listener of this.notesListeners) {
        try {
          listener(current);
        } catch (error) {
          logWarn('[Meetings] Notes listener failed', error);
        }
      }
      this.emitStatus();
      log(`[Meetings] Finalized capture ${current.id}`);

      void this.maybeIngestIntoGlobalMemory(current);

      return current;
    } catch (error) {
      // Even on failure, try to persist fallback Granola artifacts.
      current.transcriptText = current.transcriptText || '';
      current.notes = {
        title: current.title || `Meeting ${new Date(current.startedAt).toLocaleString()}`,
        summary:
          current.transcriptText.slice(0, 500) ||
          'Notes generation failed; raw transcript was saved.',
        actionItems: [],
        keyTopics: [],
        generatedAt: Date.now(),
      };
      current.title = current.notes.title;
      current.status = 'error';
      current.error = error instanceof Error ? error.message : String(error);
      current.updatedAt = Date.now();
      this.store.save(current);
      this.captureError = current.error;
      this.emitStatus();
      throw error;
    }
  }

  private async maybeIngestIntoGlobalMemory(meeting: MeetingSession): Promise<void> {
    if (!this.memoryService || !this.memoryService.isEnabled()) {
      return;
    }
    if (this.getRuntime().ingestIntoGlobalMemory === false) {
      return;
    }
    if (!meeting.notes) {
      return;
    }
    try {
      await this.memoryService.ingestMeeting({
        id: meeting.id,
        title: meeting.title,
        startedAt: meeting.startedAt,
        transcriptText: meeting.transcriptText,
        notes: meeting.notes,
      });
    } catch (error) {
      logWarn('[Meetings] Failed to ingest meeting into global Memory', error);
    }
  }
}
