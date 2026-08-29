import { randomUUID } from 'crypto';
import { systemPreferences } from 'electron';
import { configStore, type MeetingsRuntimeConfig } from '../config/config-store';
import { connectorManager } from '../connectors/connector-manager';
import { log, logWarn } from '../utils/logger';
import { buildTranscriptText } from '../../shared/meetings/transcript-format';
import { findCurrentCalendarMeeting, type CalendarMeetingMatch } from './calendar-enrichment';
import { MeetingNotesService } from './meeting-notes-service';
import { detectMeetingApps, detectZoomMicUsage } from './meeting-mic-detector';
import { MeetingStore } from './meeting-store';
import { MeetingTranscriptionService } from './meeting-transcription-service';
import { normalizeTranscriptToEnglish } from './meeting-transcript-english';
import {
  ZoomRtmsDesktopClient,
  type ZoomRtmsTranscriptSegment,
  type ZoomSpeakerUpdate,
} from './zoom-rtms-client';
import type { MemoryService } from '../memory/memory-service';
import type {
  MeetingCaptureStatus,
  MeetingListItem,
  MeetingLiveAssist,
  MeetingLiveAssistStatus,
  MeetingOverview,
  MeetingPermissionStatus,
  MeetingSegment,
  MeetingSession,
  MeetingStartOptions,
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
type AutoCaptureListener = (options?: { showOsNotification?: boolean }) => void;

const DETECTION_POLL_MS = 12_000;
/** Poll faster while capturing so leaving a Zoom call is noticed sooner. */
const DETECTION_POLL_ACTIVE_MS = 5_000;
/** Don't re-fire OS notifications for the same app more often than this. */
const DETECTION_NOTIFY_COOLDOWN_MS = 60 * 1000;
/** Retry auto-start IPC while Zoom mic stays active after a miss/failure. */
const AUTO_START_RETRY_MS = 15_000;
/** Require this many consecutive "gone" polls before auto-stop. */
const ZOOM_ABSENT_POLLS_BEFORE_STOP = 2;
/** Fall back to local Whisper if RTMS has not delivered segments by then. */
const RTMS_FALLBACK_MS = 25_000;
/** Retry Zoom RTMS start if segments have not arrived yet. */
const RTMS_START_RETRY_MS = 12_000;

function defaultRuntime(): MeetingsRuntimeConfig {
  return {
    transcriptionModel: 'gpt-4o-transcribe',
    allowChatReference: true,
    ingestIntoGlobalMemory: true,
    recentMeetingCount: 5,
    processDetectEnabled: true,
    storageRoot: '',
    liveAssistInstructions: '',
    liveAssistIntervalMs: 120_000,
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
  private wikiIngest:
    | ((meeting: {
        id: string;
        title: string;
        startedAt: number;
        notes: { title?: string; summary?: string; actionItems?: string[]; keyTopics?: string[] };
      }) => void)
    | null = null;
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
  /** True while Zoom mic is active but capture has not successfully started. */
  private pendingAutoStart = false;
  private pendingAutoStartSince: number | null = null;
  private lastAutoStartAttemptAt = 0;
  private detectionPollMs = DETECTION_POLL_MS;
  private micProbeUnavailableLogged = false;
  /** Raw audio kept for finalize retry when live STT produced no text. */
  private pendingAudioChunks: Array<{ buffer: Buffer; mimeType: string }> = [];
  private pendingTranscriptions = new Set<Promise<unknown>>();
  private pendingRtmsIngests = new Set<Promise<unknown>>();
  private readonly zoomRtms = new ZoomRtmsDesktopClient();
  /** When true, local Whisper chunks are accepted (RTMS timed out or unavailable). */
  private localSttFallbackActive = false;
  private rtmsFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private rtmsStartRetryTimer: ReturnType<typeof setTimeout> | null = null;

  setMemoryService(service: MemoryService | null): void {
    this.memoryService = service;
  }

  setWikiIngest(
    ingest:
      | ((meeting: {
          id: string;
          title: string;
          startedAt: number;
          notes: { title?: string; summary?: string; actionItems?: string[]; keyTopics?: string[] };
        }) => void)
      | null
  ): void {
    this.wikiIngest = ingest;
  }

  isZoomConnected(): boolean {
    return connectorManager.isConnected('zoom');
  }

  /** Auto mic-detect runs only when Zoom is connected. */
  private shouldAutoDetect(): boolean {
    return this.isZoomConnected();
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

  /** Start/stop background meeting-app detection based on Zoom connection. */
  syncDetectionPolling(): void {
    const shouldPoll = this.shouldAutoDetect();
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
    this.clearPendingAutoStart();
  }

  private clearPendingAutoStart(): void {
    this.pendingAutoStart = false;
    this.pendingAutoStartSince = null;
    this.lastAutoStartAttemptAt = 0;
  }

  /** Renderer ack after auto-start IPC — success clears pending; failure keeps retrying. */
  reportAutoStartResult(result: { ok: boolean; error?: string }): void {
    if (result.ok) {
      log('[Meetings] Auto-start acknowledged by renderer');
      this.clearPendingAutoStart();
      return;
    }
    logWarn(
      '[Meetings] Auto-start failed in renderer — will retry while Zoom mic stays active',
      result.error || 'unknown error'
    );
    // Keep pendingAutoStart; next poll retries after AUTO_START_RETRY_MS.
    if (!this.pendingAutoStart) {
      this.pendingAutoStart = true;
      this.pendingAutoStartSince = Date.now();
    }
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
    const zoomConnected = this.isZoomConnected();
    const detectedMeetingApps = zoomConnected
      ? this.lastDetectedApps.length
        ? this.lastDetectedApps
        : await detectMeetingApps()
      : [];

    return {
      enabled: this.isEnabled(),
      zoomConnected,
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
    if (!this.shouldAutoDetect()) {
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
      this.clearPendingAutoStart();
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

    if (!usage.zoomUsingMic) {
      this.clearPendingAutoStart();
      return;
    }

    // Zoom mic active and no capture — keep requesting until start succeeds.
    if (!this.pendingAutoStart) {
      this.pendingAutoStart = true;
      this.pendingAutoStartSince = Date.now();
    }

    const isEdge = wasBootstrapping || newlyDetected.includes('Zoom');
    const retryDue =
      this.lastAutoStartAttemptAt > 0 &&
      Date.now() - this.lastAutoStartAttemptAt >= AUTO_START_RETRY_MS;
    const firstAttempt = this.lastAutoStartAttemptAt === 0;
    if (!isEdge && !firstAttempt && !retryDue) {
      return;
    }

    const showOsNotification = this.shouldNotifyForApp('Zoom');
    if (showOsNotification) {
      this.lastNotifiedAt.set('Zoom', Date.now());
    }

    const reason = isEdge || firstAttempt ? 'detect' : 'retry';
    log(
      `[Meetings] Zoom using microphone — requesting auto-start (${reason}) ` +
        `(mode=${usage.mode} processes=${usage.processes.map((p) => p.name || p.pid).join(',')})` +
        (this.pendingAutoStartSince
          ? ` pendingForMs=${Date.now() - this.pendingAutoStartSince}`
          : '')
    );
    const payload = {
      apps,
      newlyDetected: isEdge ? newlyDetected.filter((app) => app === 'Zoom') : ['Zoom'],
    };
    for (const listener of this.detectionListeners) {
      try {
        listener(payload);
      } catch (error) {
        logWarn('[Meetings] Detection listener failed', error);
      }
    }
    this.lastAutoStartAttemptAt = Date.now();
    this.emitAutoStart({ showOsNotification });
  }

  private emitAutoStart(options?: { showOsNotification?: boolean }): void {
    for (const listener of this.autoStartListeners) {
      try {
        listener(options);
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

  getLiveAssistStatus(): MeetingLiveAssistStatus {
    const meetingId = this.activeMeetingId;
    if (!meetingId) {
      return { meetingId: null, enabled: false, sessionId: null };
    }
    const meeting = this.store.get(meetingId);
    if (!meeting?.liveAssist?.enabled) {
      return { meetingId, enabled: false, sessionId: meeting?.liveAssist?.sessionId ?? null };
    }
    return {
      meetingId,
      enabled: true,
      sessionId: meeting.liveAssist.sessionId ?? null,
    };
  }

  setLiveAssist(options: {
    enabled: boolean;
    instructions?: string;
  }): MeetingSession | null {
    if (!this.activeMeetingId) {
      return null;
    }
    const meeting = this.store.get(this.activeMeetingId);
    if (!meeting) {
      return null;
    }
    const defaults = this.getRuntime();
    const next: MeetingLiveAssist = {
      enabled: options.enabled,
      instructions:
        options.instructions?.trim() ||
        meeting.liveAssist?.instructions?.trim() ||
        defaults.liveAssistInstructions?.trim() ||
        '',
      sessionId: meeting.liveAssist?.sessionId ?? null,
    };
    if (!options.enabled) {
      next.sessionId = meeting.liveAssist?.sessionId ?? null;
    }
    meeting.liveAssist = next;
    meeting.updatedAt = Date.now();
    this.store.save(meeting);
    return meeting;
  }

  patchLiveAssist(meetingId: string, patch: Partial<MeetingLiveAssist>): MeetingSession | null {
    const meeting = this.store.get(meetingId);
    if (!meeting) {
      return null;
    }
    meeting.liveAssist = {
      enabled: patch.enabled ?? meeting.liveAssist?.enabled ?? false,
      instructions: patch.instructions ?? meeting.liveAssist?.instructions,
      sessionId: patch.sessionId ?? meeting.liveAssist?.sessionId ?? null,
    };
    meeting.updatedAt = Date.now();
    this.store.save(meeting);
    return meeting;
  }

  search(query: string, limit?: number): MeetingListItem[] {
    return this.store.search(query, limit);
  }

  async delete(id: string): Promise<{ success: boolean }> {
    if (this.activeMeetingId === id) {
      throw new Error('Cannot delete an active meeting capture');
    }
    const meeting = this.store.get(id);
    this.store.delete(id);
    if (meeting && this.memoryService) {
      try {
        await this.memoryService.deleteMeetingMemories({
          id: meeting.id,
          title: meeting.title,
          startedAt: meeting.startedAt,
          notes: meeting.notes,
        });
      } catch (error) {
        logWarn('[Meetings] Failed to delete meeting memories', error);
      }
    }
    return { success: true };
  }

  async clearAll(): Promise<{ success: boolean; deleted: number }> {
    if (this.activeMeetingId) {
      throw new Error('Stop the active meeting capture before clearing meetings');
    }
    if (this.memoryService) {
      try {
        await this.memoryService.deleteAllMeetingMemories();
      } catch (error) {
        logWarn('[Meetings] Failed to delete meeting memories during clearAll', error);
      }
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
    if (meeting.attendees?.length) {
      lines.push(`Attendees: ${meeting.attendees.join('; ')}`);
    }
    if (meeting.notes?.keyTopics?.length) {
      lines.push(`Key topics: ${meeting.notes.keyTopics.join('; ')}`);
    }
    if (meeting.notes?.actionItems?.length) {
      lines.push(`Action items: ${meeting.notes.actionItems.join('; ')}`);
    }
    if (includeTranscript) {
      lines.push(`Transcript (speaker-labeled):\n${meeting.transcriptText || '(empty)'}`);
    }
    return lines.join('\n');
  }

  async start(_title?: string, options?: MeetingStartOptions): Promise<MeetingSession> {
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
    const calendar = await findCurrentCalendarMeeting(now);
    const zoomTitle = await this.resolveZoomLiveTitle();
    const meeting: MeetingSession = {
      id: randomUUID(),
      title: zoomTitle || '',
      status: 'recording',
      createdAt: now,
      startedAt: now,
      segments: [],
      transcriptText: '',
      updatedAt: now,
      attendees: calendar?.attendees?.length ? calendar.attendees : undefined,
      zoomMeetingId: calendar?.zoomMeetingId ?? undefined,
      calendarEventId: calendar?.eventId || undefined,
    };

    if (options?.liveAssist) {
      const defaults = this.getRuntime();
      meeting.liveAssist = {
        enabled: true,
        instructions:
          options.liveAssistInstructions?.trim() ||
          defaults.liveAssistInstructions?.trim() ||
          '',
        sessionId: null,
      };
    }

    this.store.save(meeting);
    this.activeMeetingId = meeting.id;
    this.activeStartedAt = now;
    this.liveTranscript = '';
    this.captureError = undefined;
    this.pendingAudioChunks = [];
    this.pendingTranscriptions.clear();
    this.zoomAbsentPolls = 0;
    this.pendingRendererAutoStop = false;
    this.clearPendingAutoStart();
    this.localSttFallbackActive = !this.isZoomConnected();
    this.clearRtmsFallbackTimer();
    this.clearRtmsStartRetryTimer();
    this.emitStatus();
    if (this.shouldAutoDetect()) {
      this.restartDetectionTimer(DETECTION_POLL_ACTIVE_MS);
    }

    if (this.isZoomConnected()) {
      void this.bootstrapZoomRtms(meeting.id, calendar);
      this.rtmsFallbackTimer = setTimeout(() => {
        if (!this.activeMeetingId || this.activeMeetingId !== meeting.id) return;
        if (this.zoomRtms.hasReceivedSegments) return;
        this.clearRtmsStartRetryTimer();
        this.localSttFallbackActive = true;
        log('[Meetings] RTMS silent — enabling local STT fallback');
      }, RTMS_FALLBACK_MS);
    }

    log(`[Meetings] Started capture ${meeting.id}`);
    return meeting;
  }

  private clearRtmsFallbackTimer(): void {
    if (this.rtmsFallbackTimer) {
      clearTimeout(this.rtmsFallbackTimer);
      this.rtmsFallbackTimer = null;
    }
  }

  private clearRtmsStartRetryTimer(): void {
    if (this.rtmsStartRetryTimer) {
      clearTimeout(this.rtmsStartRetryTimer);
      this.rtmsStartRetryTimer = null;
    }
  }

  private scheduleRtmsStartRetry(yorkMeetingId: string, zoomMeetingId: string): void {
    this.clearRtmsStartRetryTimer();
    this.rtmsStartRetryTimer = setTimeout(() => {
      void this.retryRtmsStart(yorkMeetingId, zoomMeetingId);
    }, RTMS_START_RETRY_MS);
  }

  private async retryRtmsStart(yorkMeetingId: string, zoomMeetingId: string): Promise<void> {
    if (!this.activeMeetingId || this.activeMeetingId !== yorkMeetingId) return;
    if (this.zoomRtms.hasReceivedSegments) return;
    try {
      log('[Meetings] Retrying Zoom RTMS start', `meetingId=${zoomMeetingId}`);
      const zoomToken = await connectorManager.ensureFreshAccessToken('zoom');
      await this.zoomRtms.startParticipantRtms(zoomToken.accessToken, zoomMeetingId);
      // One more retry before the 25s local-STT fallback.
      if (!this.zoomRtms.hasReceivedSegments) {
        this.rtmsStartRetryTimer = setTimeout(() => {
          void (async () => {
            if (!this.activeMeetingId || this.activeMeetingId !== yorkMeetingId) return;
            if (this.zoomRtms.hasReceivedSegments) return;
            try {
              const token = await connectorManager.ensureFreshAccessToken('zoom');
              await this.zoomRtms.startParticipantRtms(token.accessToken, zoomMeetingId);
            } catch (error) {
              logWarn('[Meetings] Second RTMS start retry failed', error);
            }
          })();
        }, RTMS_START_RETRY_MS);
      }
    } catch (error) {
      logWarn('[Meetings] RTMS start retry failed', error);
    }
  }

  private async resolveZoomLiveTitle(): Promise<string | null> {
    if (!this.isZoomConnected()) {
      return null;
    }
    try {
      const zoomToken = await connectorManager.ensureFreshAccessToken('zoom');
      const live = await this.zoomRtms.findLiveMeeting(zoomToken.accessToken);
      const topic = live?.topic?.trim();
      return topic || null;
    } catch (error) {
      logWarn('[Meetings] Failed to resolve Zoom meeting title', error);
      return null;
    }
  }

  private async bootstrapZoomRtms(
    yorkMeetingId: string,
    calendar?: CalendarMeetingMatch | null
  ): Promise<void> {
    try {
      log('[Meetings] bootstrapZoomRtms start', `yorkMeetingId=${yorkMeetingId}`);
      const zoomToken = await connectorManager.ensureFreshAccessToken('zoom');
      log(
        '[Meetings] Zoom token ready for RTMS bootstrap',
        `accountId=${zoomToken.accountId || 'n/a'}`
      );
      const live = await this.zoomRtms.findLiveMeeting(zoomToken.accessToken);
      const calendarZoomId = calendar?.zoomMeetingId || null;
      const zoomMeetingId = live?.id || calendarZoomId;
      const zoomMeetingUuid = live?.uuid ?? null;

      if (live || calendarZoomId) {
        const current = this.store.get(yorkMeetingId);
        if (current) {
          if (zoomMeetingId) current.zoomMeetingId = zoomMeetingId;
          if (zoomMeetingUuid) current.zoomMeetingUuid = zoomMeetingUuid;
          const zoomTopic = live?.topic?.trim();
          if (zoomTopic) {
            current.title = zoomTopic;
          }
          current.updatedAt = Date.now();
          this.store.save(current);
        }
      }

      if (zoomMeetingId) {
        await this.zoomRtms.startParticipantRtms(zoomToken.accessToken, zoomMeetingId);
        this.scheduleRtmsStartRetry(yorkMeetingId, zoomMeetingId);
      } else {
        logWarn('[Meetings] No live Zoom meeting or calendar Zoom ID — cannot start RTMS via REST');
      }

      const registered = await this.zoomRtms.registerSession({
        yorkMeetingId,
        zoomMeetingUuid,
        zoomMeetingId: zoomMeetingId ?? null,
        zoomUserId: zoomToken.accountId ?? null,
      });
      if (!registered) {
        logWarn(
          '[Meetings] Zoom RTMS session registration failed',
          `yorkMeetingId=${yorkMeetingId}`
        );
      }

      this.zoomRtms.startPolling(yorkMeetingId, (batch) => {
        if (batch.speakerUpdates.length > 0) {
          this.applyRtmsSpeakerUpdates(yorkMeetingId, batch.speakerUpdates);
        }
        if (batch.segments.length === 0) {
          return;
        }
        const task = this.ingestRtmsSegments(yorkMeetingId, batch.segments);
        this.pendingRtmsIngests.add(task);
        void task.finally(() => this.pendingRtmsIngests.delete(task));
      });
    } catch (error) {
      logWarn('[Meetings] bootstrapZoomRtms failed — local STT fallback', error);
      this.localSttFallbackActive = true;
    }
  }

  /** Patch speaker labels on already-ingested RTMS segments and rebuild transcriptText. */
  private applyRtmsSpeakerUpdates(meetingId: string, updates: ZoomSpeakerUpdate[]): void {
    if (!this.activeMeetingId || this.activeMeetingId !== meetingId) {
      return;
    }
    const current = this.store.get(meetingId);
    if (!current || (current.status !== 'recording' && current.status !== 'finalizing')) {
      return;
    }

    const byId = new Map(current.segments.map((segment) => [segment.id, segment]));
    let patched = 0;
    for (const update of updates) {
      const segment = byId.get(update.id);
      if (!segment) continue;
      const name = update.speaker.trim();
      if (!name) continue;
      if (segment.speaker?.trim() === name) continue;
      segment.speaker = name;
      if (update.speakerUserId) {
        segment.speakerUserId = update.speakerUserId;
      }
      patched += 1;
    }

    if (patched === 0) {
      return;
    }

    current.transcriptText = buildTranscriptText(current.segments);
    current.updatedAt = Date.now();
    this.store.save(current);
    this.liveTranscript = current.transcriptText;
    log(
      '[Meetings] applyRtmsSpeakerUpdates',
      `meetingId=${meetingId}`,
      `patched=${patched}`,
      `updates=${updates.length}`
    );
    this.emitStatus();
  }

  /**
   * Rebuild/update local segments from the full server snapshot so late speaker
   * backfills are present in the raw transcript before the session is deleted.
   */
  private async resyncRtmsFromServer(meetingId: string): Promise<void> {
    const serverSegments = await this.zoomRtms.fetchAllSegments();
    if (serverSegments.length === 0) {
      return;
    }

    const current = this.store.get(meetingId);
    if (!current) {
      return;
    }

    const byId = new Map(current.segments.map((segment) => [segment.id, segment]));
    let patched = 0;
    let appended = 0;

    for (const remote of serverSegments) {
      const local = byId.get(remote.id);
      if (local) {
        const name = remote.speaker?.trim();
        if (name && local.speaker?.trim() !== name) {
          local.speaker = name;
          local.speakerUserId = remote.speakerUserId;
          patched += 1;
        } else if (!local.speakerUserId && remote.speakerUserId) {
          local.speakerUserId = remote.speakerUserId;
        }
        continue;
      }

      const text = remote.text?.trim();
      if (!text) continue;
      const normalized = (await normalizeTranscriptToEnglish(text)).trim() || text;
      const segment: MeetingSegment = {
        id: remote.id || randomUUID(),
        text: normalized,
        startedAt: remote.startedAt || Date.now(),
        endedAt: remote.endedAt || Date.now(),
        createdAt: Date.now(),
        speaker: remote.speaker,
        speakerUserId: remote.speakerUserId,
        source: 'zoom-rtms',
      };
      current.segments.push(segment);
      byId.set(segment.id, segment);
      appended += 1;
    }

    if (patched === 0 && appended === 0) {
      return;
    }

    current.transcriptText = buildTranscriptText(current.segments);
    current.updatedAt = Date.now();
    this.store.save(current);
    this.liveTranscript = current.transcriptText;
    log(
      '[Meetings] resyncRtmsFromServer',
      `meetingId=${meetingId}`,
      `server=${serverSegments.length}`,
      `patched=${patched}`,
      `appended=${appended}`
    );
    this.emitStatus();
  }

  private async ingestRtmsSegments(
    meetingId: string,
    rtmsSegments: ZoomRtmsTranscriptSegment[]
  ): Promise<void> {
    if (!this.activeMeetingId || this.activeMeetingId !== meetingId) {
      return;
    }
    const latest = this.store.get(meetingId);
    if (!latest || (latest.status !== 'recording' && latest.status !== 'finalizing')) {
      return;
    }

    this.localSttFallbackActive = false;
    this.clearRtmsFallbackTimer();
    this.clearRtmsStartRetryTimer();
    const withSpeaker = rtmsSegments.filter((item) => !!item.speaker?.trim()).length;
    log(
      '[Meetings] ingestRtmsSegments',
      `meetingId=${meetingId}`,
      `count=${rtmsSegments.length}`,
      `withSpeaker=${withSpeaker}`
    );

    const normalizedTexts = await Promise.all(
      rtmsSegments.map(async (item) => {
        const raw = item.text.trim();
        if (!raw) return '';
        return normalizeTranscriptToEnglish(raw);
      })
    );

    // Re-check meeting is still active after async translate.
    if (!this.activeMeetingId || this.activeMeetingId !== meetingId) {
      return;
    }
    const current = this.store.get(meetingId);
    if (!current || (current.status !== 'recording' && current.status !== 'finalizing')) {
      return;
    }

    const appended: MeetingSegment[] = [];
    for (let i = 0; i < rtmsSegments.length; i += 1) {
      const item = rtmsSegments[i];
      const text = normalizedTexts[i]?.trim() || '';
      if (!text) continue;
      const segment: MeetingSegment = {
        id: item.id || randomUUID(),
        text,
        startedAt: item.startedAt || Date.now(),
        endedAt: item.endedAt || Date.now(),
        createdAt: Date.now(),
        speaker: item.speaker,
        speakerUserId: item.speakerUserId,
        source: 'zoom-rtms',
      };
      current.segments.push(segment);
      appended.push(segment);
    }

    if (appended.length === 0) {
      return;
    }

    current.transcriptText = buildTranscriptText(current.segments);
    current.updatedAt = Date.now();
    this.store.save(current);
    this.liveTranscript = current.transcriptText;
    this.captureError = undefined;

    for (const segment of appended) {
      for (const listener of this.segmentListeners) {
        try {
          listener({
            meetingId: current.id,
            segment,
            liveTranscript: this.liveTranscript,
          });
        } catch (error) {
          logWarn('[Meetings] Segment listener failed', error);
        }
      }
    }
    this.emitStatus();
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

    // Prefer Zoom RTMS named transcripts; buffer audio until fallback activates.
    if (!this.localSttFallbackActive) {
      const bufferEarly = Buffer.isBuffer(payload.data)
        ? payload.data
        : Buffer.from(
            payload.data instanceof ArrayBuffer ? new Uint8Array(payload.data) : payload.data
          );
      if (bufferEarly.byteLength >= 1500) {
        this.bufferAudioChunk(bufferEarly, payload.mimeType || 'audio/webm');
      }
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
      const rawText = await this.transcription.transcribeChunk(buffer, mimeType, model);
      const text = rawText ? await normalizeTranscriptToEnglish(rawText) : '';
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
        source: 'local-stt',
      };

      latest.segments.push(segment);
      latest.transcriptText = buildTranscriptText(latest.segments);
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

    this.clearRtmsFallbackTimer();
    this.clearRtmsStartRetryTimer();

    // Stop polling but keep the session so we can resync labeled speakers before unlink.
    this.zoomRtms.stopPolling();

    const meeting = this.store.get(meetingId);
    this.activeMeetingId = null;
    this.activeStartedAt = null;
    this.zoomAbsentPolls = 0;
    this.pendingRendererAutoStop = false;
    this.localSttFallbackActive = false;
    this.emitStatus();
    if (this.shouldAutoDetect()) {
      this.restartDetectionTimer(DETECTION_POLL_MS);
    }

    if (!meeting) {
      this.pendingAudioChunks = [];
      void this.zoomRtms.unregister();
      return null;
    }

    const endedAt = Date.now();
    meeting.status = 'finalizing';
    meeting.endedAt = endedAt;
    meeting.durationMs = Math.max(0, endedAt - meeting.startedAt);
    meeting.updatedAt = endedAt;
    this.store.save(meeting);

    // Wait for in-flight live STT / RTMS English-normalize, then pull final speaker labels.
    if (this.pendingTranscriptions.size > 0 || this.pendingRtmsIngests.size > 0) {
      await Promise.allSettled([...this.pendingTranscriptions, ...this.pendingRtmsIngests]);
    }

    try {
      await this.resyncRtmsFromServer(meetingId);
    } catch (error) {
      logWarn('[Meetings] RTMS final resync failed', error);
    }

    void this.zoomRtms.unregister();

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
    this.pendingRtmsIngests.clear();

    try {
      // Ensure transcriptText is always a string (Granola raw artifact).
      current.transcriptText = current.transcriptText || '';
      current.segments = Array.isArray(current.segments) ? current.segments : [];

      const notes = await this.notes.generateNotes(current);
      const storedTitle =
        current.title?.trim() || notes.title?.trim() || 'Untitled meeting';
      // Always persist notes object on ready — never leave notes undefined.
      current.notes = {
        title: storedTitle,
        summary:
          notes.summary?.trim() ||
          current.transcriptText.slice(0, 500) ||
          'No speech was transcribed for this meeting.',
        actionItems: Array.isArray(notes.actionItems) ? notes.actionItems : [],
        keyTopics: Array.isArray(notes.keyTopics) ? notes.keyTopics : [],
        generatedAt: notes.generatedAt || Date.now(),
      };
      current.title = storedTitle;
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
        title: current.title?.trim() || 'Untitled meeting',
        summary:
          current.transcriptText.slice(0, 500) ||
          'Notes generation failed; raw transcript was saved.',
        actionItems: [],
        keyTopics: [],
        generatedAt: Date.now(),
      };
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
      try {
        this.wikiIngest?.({
          id: meeting.id,
          title: meeting.title,
          startedAt: meeting.startedAt,
          notes: meeting.notes,
        });
      } catch (wikiError) {
        logWarn('[Meetings] Failed to ingest meeting into wiki', wikiError);
      }
    } catch (error) {
      logWarn('[Meetings] Failed to ingest meeting into global Memory', error);
    }
  }
}
