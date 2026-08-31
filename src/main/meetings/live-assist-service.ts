import { randomUUID } from 'node:crypto';
import { configStore } from '../config/config-store';
import type { MCPManager } from '../mcp/mcp-manager';
import { log, logWarn } from '../utils/logger';
import type { SessionManager } from '../session/session-manager';
import type { LiveAssistActivityPhase, ServerEvent } from '../../renderer/types';
import type { MeetingCaptureStatus, MeetingSegment, MeetingSession } from './meeting-types';
import type { MeetingService } from './meeting-service';
import { answerLiveAssistQuestion } from './live-assist-answer';
import {
  MAX_ANSWERS_PER_MEETING,
  QUESTION_DEBOUNCE_MS,
  QUESTION_DEDUP_MS,
  classifyLiveQuestion,
  findQuestionCandidateInWindow,
  hashQuestionForDedup,
  matchesQuestionHeuristic,
} from './live-assist-question-detect';

export const TRANSCRIPT_WINDOW_CHARS = 4_000;

export interface LiveAssistDeps {
  sessionManager: SessionManager;
  meetingService: MeetingService;
  mcpManager: MCPManager;
  sendToRenderer: (event: ServerEvent) => void;
  resolveMatterPrep?: (eventId: string) => string | null;
}

export function truncateTranscriptWindow(transcript: string, maxChars = TRANSCRIPT_WINDOW_CHARS): string {
  const trimmed = transcript.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return trimmed.slice(trimmed.length - maxChars);
}

export function buildLiveAssistKickoffPrompt(options: {
  meetingTitle: string;
  attendees?: string[];
  prepContext?: string | null;
  customInstructions?: string;
}): string {
  const attendeeLine =
    options.attendees && options.attendees.length
      ? `Attendees: ${options.attendees.join(', ')}`
      : 'Attendees: (unknown)';

  const sections = [
    'You are York IE Live Assist for an ongoing meeting.',
    'Your job: help the user during this live call — answer questions detected in the transcript and respond when the user asks here.',
    'Background research uses York tools (Hub, Slack, Gmail, Calendar, past meetings) to post concise answers here.',
    'Keep your own replies brief. When a researched answer appears, you may add a one-line summary if helpful.',
    '',
    `Meeting: ${options.meetingTitle}`,
    attendeeLine,
  ];

  if (options.prepContext?.trim()) {
    sections.push('', 'Meeting prep / calendar context:', options.prepContext.trim());
  }

  if (options.customInstructions?.trim()) {
    sections.push('', 'User Live Assist instructions:', options.customInstructions.trim());
  }

  sections.push(
    '',
    'Acknowledge you are listening. Live answers to meeting questions will appear here as they are researched.'
  );

  return sections.join('\n');
}

export function buildLiveAssistFarewellPrompt(): string {
  return [
    'The live meeting capture has ended.',
    'Summarize open questions, commitments, and suggested follow-ups from this conversation.',
    'Keep it concise and actionable.',
  ].join('\n');
}

export class LiveAssistService {
  private activeMeetingId: string | null = null;
  private liveTranscript = '';
  private lastSegmentText = '';
  private questionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private answerCount = 0;
  private starting = false;
  private focusedSessionId: string | null = null;
  private detachListeners: (() => void) | null = null;
  private inFlightAnswers = 0;
  private publishedSegmentIds = new Set<string>();
  private answeredQuestionAt = new Map<string, number>();

  constructor(private readonly deps: LiveAssistDeps) {}

  attach(): void {
    if (this.detachListeners) {
      return;
    }

    const offStatus = this.deps.meetingService.onStatus((status) => {
      void this.handleStatus(status);
    });
    const offSegment = this.deps.meetingService.onSegment((payload) => {
      void this.handleSegment(payload);
    });

    this.detachListeners = () => {
      offStatus();
      offSegment();
    };

    const current = this.deps.meetingService.getCaptureStatus();
    if (current.active && current.meetingId) {
      void this.handleStatus(current);
    }
  }

  detach(): void {
    this.clearQuestionDebounce();
    if (this.detachListeners) {
      this.detachListeners();
      this.detachListeners = null;
    }
    this.resetMeetingState();
  }

  getLinkedSessionId(): string | null {
    return this.deps.meetingService.getLiveAssistStatus().sessionId;
  }

  getLiveAssistStatus() {
    return this.deps.meetingService.getLiveAssistStatus();
  }

  async enableForMeeting(
    meetingId: string,
    options?: { instructions?: string; focusChat?: boolean }
  ): Promise<string | null> {
    const meeting = this.deps.meetingService.get(meetingId);
    if (!meeting) {
      return null;
    }

    this.deps.meetingService.patchLiveAssist(meetingId, {
      enabled: true,
      instructions:
        options?.instructions?.trim() ||
        meeting.liveAssist?.instructions?.trim() ||
        configStore.get('meetingsRuntime').liveAssistInstructions?.trim() ||
        '',
    });

    const sessionId = await this.ensureSessionForMeeting(meetingId);
    if (!sessionId) {
      return null;
    }

    this.activeMeetingId = meetingId;
    this.liveTranscript = meeting.transcriptText || this.liveTranscript;

    if (options?.focusChat === true) {
      this.emitSessionStarted(sessionId);
    }

    return sessionId;
  }

  async disableForMeeting(
    meetingId: string,
    options: { farewell?: boolean } = { farewell: true }
  ): Promise<void> {
    await this.stopForMeeting(meetingId, { farewell: options.farewell === true });
  }

  private resetMeetingState(): void {
    this.activeMeetingId = null;
    this.liveTranscript = '';
    this.lastSegmentText = '';
    this.answerCount = 0;
    this.inFlightAnswers = 0;
    this.focusedSessionId = null;
    this.publishedSegmentIds.clear();
    this.answeredQuestionAt.clear();
  }

  private emitSessionStarted(sessionId: string): void {
    if (this.focusedSessionId === sessionId) {
      return;
    }
    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      return;
    }
    this.focusedSessionId = sessionId;
    this.deps.sendToRenderer({
      type: 'liveAssist.sessionStarted',
      payload: { session, sessionId },
    });
  }

  private isLiveAssistEnabledForMeeting(meetingId: string): boolean {
    const meeting = this.deps.meetingService.get(meetingId);
    return meeting?.liveAssist?.enabled === true;
  }

  private getCustomInstructions(meetingId: string): string {
    const meeting = this.deps.meetingService.get(meetingId);
    return (
      meeting?.liveAssist?.instructions?.trim() ||
      configStore.get('meetingsRuntime').liveAssistInstructions?.trim() ||
      ''
    );
  }

  private async handleStatus(status: MeetingCaptureStatus): Promise<void> {
    if (status.active && status.meetingId) {
      this.liveTranscript = status.liveTranscript || this.liveTranscript;
      this.activeMeetingId = status.meetingId;
      if (this.isLiveAssistEnabledForMeeting(status.meetingId)) {
        await this.ensureSessionForMeeting(status.meetingId);
      }
      return;
    }

    if (this.activeMeetingId) {
      await this.stopForMeeting(this.activeMeetingId, { farewell: true });
    }
  }

  private publishTranscriptSegment(sessionId: string, segment: MeetingSegment): void {
    if (!segment.text?.trim() || this.publishedSegmentIds.has(segment.id)) {
      return;
    }
    const published = this.deps.sessionManager.publishMeetingTranscript(sessionId, {
      id: segment.id,
      speaker: segment.speaker,
      text: segment.text,
    });
    if (published) {
      this.publishedSegmentIds.add(segment.id);
    }
  }

  private backfillTranscript(sessionId: string, meeting: MeetingSession): void {
    for (const segment of meeting.segments) {
      this.publishTranscriptSegment(sessionId, segment);
    }
  }

  private async handleSegment(payload: {
    meetingId: string;
    segment: MeetingSegment;
    liveTranscript: string;
  }): Promise<void> {
    if (!payload.meetingId) {
      return;
    }

    if (!this.activeMeetingId) {
      this.activeMeetingId = payload.meetingId;
    }

    if (payload.meetingId !== this.activeMeetingId) {
      return;
    }

    this.liveTranscript = payload.liveTranscript || '';
    this.lastSegmentText = payload.segment.text?.trim() || '';

    if (!this.isLiveAssistEnabledForMeeting(payload.meetingId)) {
      return;
    }

    const sessionId = await this.ensureSessionForMeeting(payload.meetingId);
    if (sessionId) {
      this.publishTranscriptSegment(sessionId, payload.segment);
    }

    if (this.lastSegmentText) {
      this.scheduleQuestionCheck(payload.meetingId);
    }
  }

  private clearQuestionDebounce(): void {
    if (this.questionDebounceTimer) {
      clearTimeout(this.questionDebounceTimer);
      this.questionDebounceTimer = null;
    }
  }

  private scheduleQuestionCheck(meetingId: string): void {
    this.clearQuestionDebounce();
    this.questionDebounceTimer = setTimeout(() => {
      this.questionDebounceTimer = null;
      void this.runQuestionPipeline(meetingId);
    }, QUESTION_DEBOUNCE_MS);
  }

  private wasQuestionAnsweredRecently(question: string): boolean {
    const hash = hashQuestionForDedup(question);
    const answeredAt = this.answeredQuestionAt.get(hash);
    if (!answeredAt) {
      return false;
    }
    return Date.now() - answeredAt < QUESTION_DEDUP_MS;
  }

  private markQuestionAnswered(question: string): void {
    this.answeredQuestionAt.set(hashQuestionForDedup(question), Date.now());
  }

  private async runQuestionPipeline(meetingId: string): Promise<void> {
    if (!this.isLiveAssistEnabledForMeeting(meetingId)) {
      return;
    }
    if (this.answerCount >= MAX_ANSWERS_PER_MEETING) {
      return;
    }

    const meeting = this.deps.meetingService.get(meetingId);
    if (!meeting) {
      return;
    }

    const transcriptWindow = truncateTranscriptWindow(this.liveTranscript);
    const candidate =
      findQuestionCandidateInWindow(transcriptWindow) ||
      (matchesQuestionHeuristic(this.lastSegmentText) ? this.lastSegmentText : null);
    if (!candidate) {
      return;
    }

    const classification = await classifyLiveQuestion(transcriptWindow, candidate);
    if (!classification?.answerable) {
      return;
    }

    if (this.wasQuestionAnsweredRecently(classification.question)) {
      return;
    }

    const sessionId = await this.ensureSessionForMeeting(meetingId);
    if (!sessionId) {
      return;
    }

    this.answerCount += 1;
    this.markQuestionAnswered(classification.question);
    this.spawnAnswer({
      meetingId,
      meeting,
      sessionId,
      question: classification.question,
      transcriptWindow,
    });
  }

  private updateActivityMessage(
    sessionId: string,
    messageId: string,
    activityId: string,
    question: string,
    phase: LiveAssistActivityPhase,
    status: 'running' | 'completed' | 'failed',
    detail?: string
  ): void {
    this.deps.sessionManager.updatePublishedMessage(sessionId, messageId, [
      {
        type: 'live_assist_activity',
        activityId,
        phase,
        question,
        detail,
        status,
      },
    ]);
  }

  private spawnAnswer(options: {
    meetingId: string;
    meeting: MeetingSession;
    sessionId: string;
    question: string;
    transcriptWindow: string;
  }): void {
    const prepContext = this.resolvePrepContext(options.meeting);
    const activityId = randomUUID();
    const activityMessageId = this.deps.sessionManager.publishLiveAssistActivity(options.sessionId, {
      activityId,
      phase: 'detected',
      question: options.question,
      status: 'running',
    });

    this.inFlightAnswers += 1;
    void answerLiveAssistQuestion({
      question: options.question,
      transcriptWindow: options.transcriptWindow,
      meetingTitle: options.meeting.title,
      prepContext,
      customInstructions: this.getCustomInstructions(options.meetingId),
      mcpManager: this.deps.mcpManager,
      onProgress: (phase, detail) => {
        const activityPhase: LiveAssistActivityPhase =
          phase === 'planning' ? 'planning' : phase === 'mcp' ? 'mcp' : 'summarizing';
        this.updateActivityMessage(
          options.sessionId,
          activityMessageId,
          activityId,
          options.question,
          activityPhase,
          'running',
          detail
        );
      },
    })
      .then((answer) => {
        if (answer && !answer.startsWith('Error:')) {
          this.updateActivityMessage(
            options.sessionId,
            activityMessageId,
            activityId,
            options.question,
            'done',
            'completed'
          );
          this.deps.sessionManager.publishAssistantText(options.sessionId, answer);
        } else {
          this.updateActivityMessage(
            options.sessionId,
            activityMessageId,
            activityId,
            options.question,
            'failed',
            'failed',
            answer || 'No answer generated'
          );
        }
      })
      .catch((error) => {
        logWarn('[LiveAssist] Answer pipeline failed:', error);
        this.updateActivityMessage(
          options.sessionId,
          activityMessageId,
          activityId,
          options.question,
          'failed',
          'failed',
          error instanceof Error ? error.message : String(error)
        );
      })
      .finally(() => {
        this.inFlightAnswers = Math.max(0, this.inFlightAnswers - 1);
      });
  }

  private resolvePrepContext(meeting: MeetingSession): string | null {
    const eventId = meeting.calendarEventId?.trim();
    if (!eventId || !this.deps.resolveMatterPrep) {
      return null;
    }
    return this.deps.resolveMatterPrep(eventId);
  }

  private async ensureSessionForMeeting(meetingId: string): Promise<string | null> {
    const meeting = this.deps.meetingService.get(meetingId);
    if (!meeting?.liveAssist?.enabled) {
      return null;
    }

    const existingSessionId = meeting.liveAssist.sessionId?.trim();
    if (existingSessionId && this.deps.sessionManager.getSession(existingSessionId)) {
      if (this.publishedSegmentIds.size === 0) {
        this.backfillTranscript(existingSessionId, meeting);
      }
      return existingSessionId;
    }

    if (this.starting) {
      return existingSessionId || null;
    }

    this.starting = true;
    try {
      const title = `Live Assist · ${meeting.title}`;
      const kickoffPrompt = buildLiveAssistKickoffPrompt({
        meetingTitle: meeting.title,
        attendees: meeting.attendees,
        prepContext: this.resolvePrepContext(meeting),
        customInstructions: this.getCustomInstructions(meetingId),
      });

      const session = await this.deps.sessionManager.startSession(title, kickoffPrompt);
      this.deps.meetingService.patchLiveAssist(meetingId, {
        enabled: true,
        sessionId: session.id,
      });

      this.backfillTranscript(session.id, meeting);
      this.emitSessionStarted(session.id);

      log(`[LiveAssist] Started session ${session.id} for meeting ${meetingId}`);
      return session.id;
    } catch (error) {
      logWarn('[LiveAssist] Failed to start session:', error);
      return null;
    } finally {
      this.starting = false;
    }
  }

  private async stopForMeeting(
    meetingId: string,
    options: { farewell: boolean }
  ): Promise<void> {
    if (this.activeMeetingId && this.activeMeetingId !== meetingId) {
      return;
    }

    this.clearQuestionDebounce();

    const meeting = this.deps.meetingService.get(meetingId);
    const sessionId = meeting?.liveAssist?.sessionId ?? null;

    this.resetMeetingState();

    if (!sessionId || !options.farewell) {
      return;
    }

    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session || session.status === 'running') {
      return;
    }

    try {
      await this.deps.sessionManager.continueSession(
        sessionId,
        buildLiveAssistFarewellPrompt(),
        [{ type: 'text', text: 'Live Assist · meeting ended' }],
        { broadcastUserMessage: true }
      );
    } catch (error) {
      logWarn('[LiveAssist] Farewell turn failed:', error);
    }
  }
}
