import { configStore } from '../config/config-store';
import { runChildAgentSession } from '../agent/child-agent-session';
import type { MCPManager } from '../mcp/mcp-manager';
import { log, logWarn } from '../utils/logger';
import type { SessionManager } from '../session/session-manager';
import type { ServerEvent } from '../../renderer/types';
import type { MeetingCaptureStatus, MeetingSegment, MeetingSession } from './meeting-types';
import type { MeetingService } from './meeting-service';
import {
  MAX_SUBAGENT_ANSWERS_PER_MEETING,
  QUESTION_COOLDOWN_MS,
  QUESTION_DEBOUNCE_MS,
  buildLiveAssistSubagentTask,
  classifyLiveQuestion,
  findQuestionCandidateInWindow,
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
    'Background subagents research answers using York tools (Hub, Slack, Gmail, Calendar, past meetings) and web search when needed.',
    'Keep your own replies brief. When a subagent posts an answer, you may add a one-line summary if helpful.',
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
  private lastQuestionAt = 0;
  private subagentAnswerCount = 0;
  private starting = false;
  private detachListeners: (() => void) | null = null;
  private inFlightSubagents = 0;

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

    if (options?.focusChat !== false) {
      const session = this.deps.sessionManager.getSession(sessionId);
      if (session) {
        this.deps.sendToRenderer({
          type: 'liveAssist.sessionStarted',
          payload: { session, sessionId },
        });
      }
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
    this.lastQuestionAt = 0;
    this.subagentAnswerCount = 0;
    this.inFlightSubagents = 0;
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
      if (this.isLiveAssistEnabledForMeeting(status.meetingId)) {
        await this.enableForMeeting(status.meetingId, { focusChat: true });
      } else {
        this.activeMeetingId = status.meetingId;
      }
      return;
    }

    if (this.activeMeetingId) {
      await this.stopForMeeting(this.activeMeetingId, { farewell: true });
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

    if (!matchesQuestionHeuristic(this.lastSegmentText)) {
      return;
    }

    this.scheduleQuestionCheck(payload.meetingId);
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

  private async runQuestionPipeline(meetingId: string): Promise<void> {
    if (!this.isLiveAssistEnabledForMeeting(meetingId)) {
      return;
    }
    if (this.subagentAnswerCount >= MAX_SUBAGENT_ANSWERS_PER_MEETING) {
      return;
    }
    if (Date.now() - this.lastQuestionAt < QUESTION_COOLDOWN_MS) {
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

    const sessionId = await this.ensureSessionForMeeting(meetingId);
    if (!sessionId) {
      return;
    }

    this.lastQuestionAt = Date.now();
    this.subagentAnswerCount += 1;
    this.spawnAnswerSubagent({
      meetingId,
      meeting,
      sessionId,
      question: classification.question,
      transcriptWindow,
    });
  }

  private spawnAnswerSubagent(options: {
    meetingId: string;
    meeting: MeetingSession;
    sessionId: string;
    question: string;
    transcriptWindow: string;
  }): void {
    const prepContext = this.resolvePrepContext(options.meeting);
    const task = buildLiveAssistSubagentTask({
      question: options.question,
      transcriptWindow: options.transcriptWindow,
      prepContext,
      customInstructions: this.getCustomInstructions(options.meetingId),
      meetingTitle: options.meeting.title,
    });

    this.inFlightSubagents += 1;
    void runChildAgentSession({
      task,
      modelMode: 'free',
      includeCodingTools: false,
      mcpToolsMode: 'meta-only',
      mcpManager: this.deps.mcpManager,
      sendEvent: this.deps.sendToRenderer,
      parentSessionId: options.sessionId,
      emitProgress: true,
      usageFeature: 'live_assist',
    })
      .then((result) => {
        const answer = result.text?.trim();
        if (answer && !answer.startsWith('Error:')) {
          const header = `**Live Assist · question**\n> ${options.question}\n\n`;
          this.deps.sessionManager.publishAssistantText(options.sessionId, `${header}${answer}`);
        }
      })
      .catch((error) => {
        logWarn('[LiveAssist] Subagent answer failed:', error);
      })
      .finally(() => {
        this.inFlightSubagents = Math.max(0, this.inFlightSubagents - 1);
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

      this.deps.sendToRenderer({
        type: 'liveAssist.sessionStarted',
        payload: { session, sessionId: session.id },
      });

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
