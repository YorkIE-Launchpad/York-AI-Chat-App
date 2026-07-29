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

/**
 * Desktop client for Zoom RTMS: register with York backend, start RTMS via Zoom REST,
 * and poll for named transcript segments.
 */
export class ZoomRtmsDesktopClient {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;
  private yorkMeetingId: string | null = null;
  private onSegments: ((segments: ZoomRtmsTranscriptSegment[]) => void) | null = null;
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
   * RTMS is webhook-push only — Zoom sends meeting.rtms_started to the backend when a
   * meeting begins and the Marketplace app has RTMS enabled.  There is no REST endpoint to
   * initiate RTMS from the participant side; this method is intentionally a no-op.
   *
   * To receive RTMS webhooks you must:
   *  1. Enable the RTMS feature on your Zoom General App in the Marketplace.
   *  2. Add a webhook endpoint: POST https://<backend>/zoom/webhooks
   *  3. Subscribe to the meeting.rtms_started (and meeting.rtms_stopped) events.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  startParticipantRtms(_accessToken: string, meetingId: string): Promise<boolean> {
    log(
      '[ZoomRTMS] RTMS is webhook-driven — no REST call needed.',
      `meetingId=${meetingId}`,
      'Waiting for backend to receive meeting.rtms_started webhook from Zoom.'
    );
    return Promise.resolve(true);
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
    onSegments: (segments: ZoomRtmsTranscriptSegment[]) => void,
    intervalMs = 2_000
  ): void {
    this.stopPolling();
    this.yorkMeetingId = yorkMeetingId;
    this.onSegments = onSegments;
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
    this.onSegments = null;
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
    const onSegments = this.onSegments;
    if (!meetingId || !onSegments) return;
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
      };
      const segments = Array.isArray(payload.segments) ? payload.segments : [];
      if (typeof payload.nextCursor === 'number') {
        this.cursor = payload.nextCursor;
      }
      if (segments.length > 0) {
        this.receivedCount += segments.length;
        log(
          '[ZoomRTMS] Received transcript segments',
          `count=${segments.length}`,
          `nextCursor=${this.cursor}`
        );
        onSegments(segments);
      }
    } catch (error) {
      logWarn('[ZoomRTMS] pollOnce error', error);
    }
  }
}
