import { authConfig } from '../../shared/auth-config';
import { resolveBackendUrl } from '../../shared/backend-config';
import { getBackendAuthHeaders } from '../config/backend-auth';
import { log, logWarn } from '../utils/logger';

export interface ZoomRtmsTranscriptSegment {
  id: string;
  text: string;
  speaker: string | null;
  speakerUserId: string | null;
  startedAt: number;
  endedAt: number;
  meetingUuid?: string | null;
}

/** Speaker name filled in after the segment was already delivered. */
export interface ZoomSpeakerUpdate {
  id: string;
  speaker: string;
  speakerUserId: string | null;
}

export interface ZoomPollBatch {
  segments: ZoomRtmsTranscriptSegment[];
  speakerUpdates: ZoomSpeakerUpdate[];
}

export interface ZoomLiveMeeting {
  id: string;
  uuid: string;
  topic: string;
}

function backendBase(): string {
  return resolveBackendUrl().replace(/\/+$/, '');
}

/** True when York backend rejected the request for missing/invalid Cognito JWT. */
function isCognitoAuthRequiredBody(body: string): boolean {
  return (
    body.includes('Authentication required') ||
    body.includes('Authentication failed') ||
    body.includes('Cognito JWT')
  );
}

function logZoomSessionAuthFailure(operation: string, status: number, body: string): void {
  if (status === 401 && isCognitoAuthRequiredBody(body)) {
    logWarn(
      `[ZoomRTMS] ${operation} unauthorized — VECOS Cognito sign-in required for Zoom RTMS session APIs`,
      `(POST /zoom/sessions/*). Sign in to VECOS, ensure backend Cognito env matches the app,`,
      `and keep Zoom Marketplace Event Notification URL on /zoom/webhooks (not /zoom/sessions).`,
      `status=${status}`,
      body
    );
    return;
  }
  logWarn(`[ZoomRTMS] ${operation} failed`, status, body);
}

/** Zoom errors that mean RTMS is already running — treat as success for mid-meeting join. */
function isRtmsAlreadyActiveError(status: number, body: string): boolean {
  if (status === 409) return true;
  return /already\s*(started|active|running|in\s*progress)|rtms.*(started|active)/i.test(body);
}

function parseSpeakerUpdates(raw: unknown): ZoomSpeakerUpdate[] {
  if (!Array.isArray(raw)) return [];
  const updates: ZoomSpeakerUpdate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const speaker = typeof rec.speaker === 'string' ? rec.speaker.trim() : '';
    if (!id || !speaker) continue;
    const speakerUserId =
      rec.speakerUserId != null && String(rec.speakerUserId).trim()
        ? String(rec.speakerUserId)
        : null;
    updates.push({ id, speaker, speakerUserId });
  }
  return updates;
}

/**
 * Desktop client for Zoom RTMS: register with York backend, start RTMS via Zoom REST,
 * and poll for named transcript segments.
 */
export class ZoomRtmsDesktopClient {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;
  private yorkMeetingId: string | null = null;
  private onBatch: ((batch: ZoomPollBatch) => void) | null = null;
  private receivedCount = 0;

  get hasReceivedSegments(): boolean {
    return this.receivedCount > 0;
  }

  async findLiveMeeting(accessToken: string): Promise<ZoomLiveMeeting | null> {
    try {
      const response = await fetch(
        'https://api.zoom.us/v2/users/me/meetings?type=live&page_size=30',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const payload = (await response.json()) as {
        meetings?: Array<{ id?: number | string; uuid?: string; topic?: string }>;
        message?: string;
      };
      if (!response.ok) {
        logWarn('[ZoomRTMS] List live meetings failed', payload.message || response.statusText);
        return null;
      }
      log(
        '[ZoomRTMS] List live meetings response',
        `count=${Array.isArray(payload.meetings) ? payload.meetings.length : 0}`
      );
      const meeting = payload.meetings?.[0];
      if (!meeting?.uuid || meeting.id == null) {
        logWarn('[ZoomRTMS] No live meeting found for current user');
        return null;
      }
      log('[ZoomRTMS] Using live meeting', `id=${meeting.id}`, `uuid=${meeting.uuid}`);
      return {
        id: String(meeting.id),
        uuid: meeting.uuid,
        topic: typeof meeting.topic === 'string' ? meeting.topic : 'Zoom meeting',
      };
    } catch (error) {
      logWarn('[ZoomRTMS] findLiveMeeting error', error);
      return null;
    }
  }

  /**
   * Start (or confirm) participant RTMS for a live meeting via Zoom REST.
   * Zoom then sends meeting.rtms_started to the backend webhook for SDK join.
   *
   * Prerequisites: Marketplace RTMS entitlement, scope
   * meeting:update:participant_rtms_app_status, and webhook on /zoom/webhooks.
   */
  async startParticipantRtms(accessToken: string, meetingId: string): Promise<boolean> {
    const clientId = authConfig.zoomConnectorClientId?.trim();
    if (!clientId) {
      logWarn('[ZoomRTMS] Missing ZOOM_CONNECTOR_CLIENT_ID — cannot PATCH rtms_app/status');
      return false;
    }
    if (!meetingId?.trim()) {
      logWarn('[ZoomRTMS] startParticipantRtms called without meetingId');
      return false;
    }

    try {
      const url = `https://api.zoom.us/v2/live_meetings/${encodeURIComponent(meetingId)}/rtms_app/status`;
      log('[ZoomRTMS] Starting participant RTMS', `meetingId=${meetingId}`);
      const response = await fetch(url, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'start',
          settings: { client_id: clientId },
        }),
      });
      const body = await response.text();
      if (response.ok) {
        log(
          '[ZoomRTMS] RTMS start accepted',
          `meetingId=${meetingId}`,
          `status=${response.status}`
        );
        return true;
      }
      if (isRtmsAlreadyActiveError(response.status, body)) {
        log(
          '[ZoomRTMS] RTMS already active — treating as success',
          `meetingId=${meetingId}`,
          `status=${response.status}`
        );
        return true;
      }
      logWarn(
        '[ZoomRTMS] startParticipantRtms failed',
        `meetingId=${meetingId}`,
        `status=${response.status}`,
        body
      );
      return false;
    } catch (error) {
      logWarn('[ZoomRTMS] startParticipantRtms error', error);
      return false;
    }
  }

  async registerSession(input: {
    yorkMeetingId: string;
    zoomMeetingUuid?: string | null;
    zoomMeetingId?: string | null;
    zoomUserId?: string | null;
  }): Promise<boolean> {
    try {
      const headers = await getBackendAuthHeaders();
      const response = await fetch(`${backendBase()}/zoom/sessions/register`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        const body = await response.text();
        logZoomSessionAuthFailure('registerSession', response.status, body);
        return false;
      }
      log(
        '[ZoomRTMS] Session registered',
        `yorkMeetingId=${input.yorkMeetingId}`,
        `zoomMeetingId=${input.zoomMeetingId || 'n/a'}`,
        `zoomMeetingUuid=${input.zoomMeetingUuid || 'n/a'}`
      );
      this.yorkMeetingId = input.yorkMeetingId;
      this.cursor = 0;
      this.receivedCount = 0;
      return true;
    } catch (error) {
      logWarn(
        '[ZoomRTMS] registerSession error — ensure VECOS Cognito sign-in before Zoom RTMS register',
        error
      );
      return false;
    }
  }

  startPolling(
    yorkMeetingId: string,
    onBatch: (batch: ZoomPollBatch) => void,
    intervalMs = 2_000
  ): void {
    this.stopPolling();
    this.yorkMeetingId = yorkMeetingId;
    this.onBatch = onBatch;
    log('[ZoomRTMS] Start polling', `yorkMeetingId=${yorkMeetingId}`, `intervalMs=${intervalMs}`);
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
    void this.pollOnce();
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      log('[ZoomRTMS] Polling stopped');
    }
    this.onBatch = null;
  }

  /**
   * Fetch all segments currently held server-side (does not change the poll cursor).
   * Used on stop to rebuild labeled transcriptText from backend truth.
   */
  async fetchAllSegments(): Promise<ZoomRtmsTranscriptSegment[]> {
    const meetingId = this.yorkMeetingId;
    if (!meetingId) return [];
    try {
      const headers = await getBackendAuthHeaders();
      const url = new URL(
        `${backendBase()}/zoom/sessions/${encodeURIComponent(meetingId)}/segments`
      );
      url.searchParams.set('after', '0');
      const response = await fetch(url.toString(), { headers });
      if (!response.ok) {
        const body = await response.text();
        logZoomSessionAuthFailure('fetchAllSegments', response.status, body);
        return [];
      }
      const payload = (await response.json()) as {
        segments?: ZoomRtmsTranscriptSegment[];
      };
      return Array.isArray(payload.segments) ? payload.segments : [];
    } catch (error) {
      logWarn('[ZoomRTMS] fetchAllSegments error', error);
      return [];
    }
  }

  async unregister(): Promise<void> {
    this.stopPolling();
    const meetingId = this.yorkMeetingId;
    this.yorkMeetingId = null;
    if (!meetingId) return;
    try {
      const headers = await getBackendAuthHeaders();
      await fetch(`${backendBase()}/zoom/sessions/${encodeURIComponent(meetingId)}`, {
        method: 'DELETE',
        headers,
      });
    } catch (error) {
      logWarn('[ZoomRTMS] unregister error', error);
    }
  }

  private async pollOnce(): Promise<void> {
    const meetingId = this.yorkMeetingId;
    const onBatch = this.onBatch;
    if (!meetingId || !onBatch) return;
    try {
      const headers = await getBackendAuthHeaders();
      const url = new URL(
        `${backendBase()}/zoom/sessions/${encodeURIComponent(meetingId)}/segments`
      );
      url.searchParams.set('after', String(this.cursor));
      const response = await fetch(url.toString(), { headers });
      if (!response.ok) {
        const body = await response.text();
        logZoomSessionAuthFailure('pollOnce', response.status, body);
        return;
      }
      const payload = (await response.json()) as {
        segments?: ZoomRtmsTranscriptSegment[];
        nextCursor?: number;
        speakerUpdates?: unknown;
      };
      const segments = Array.isArray(payload.segments) ? payload.segments : [];
      const speakerUpdates = parseSpeakerUpdates(payload.speakerUpdates);
      if (typeof payload.nextCursor === 'number') {
        this.cursor = payload.nextCursor;
      }
      if (segments.length === 0 && speakerUpdates.length === 0) {
        return;
      }
      if (segments.length > 0) {
        this.receivedCount += segments.length;
        log(
          '[ZoomRTMS] Received transcript segments',
          `count=${segments.length}`,
          `speakerUpdates=${speakerUpdates.length}`,
          `nextCursor=${this.cursor}`
        );
      } else if (speakerUpdates.length > 0) {
        log(
          '[ZoomRTMS] Received speaker updates',
          `count=${speakerUpdates.length}`,
          `nextCursor=${this.cursor}`
        );
      }
      onBatch({ segments, speakerUpdates });
    } catch (error) {
      logWarn('[ZoomRTMS] pollOnce error', error);
    }
  }
}
