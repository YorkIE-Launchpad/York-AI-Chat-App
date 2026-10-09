import { useCallback, useEffect, useReducer } from 'react';
import type { ScreenSnapSessionEvent } from '../../shared/screen-snap';
import type {
  Message,
  PermissionRequest,
  SessionStatus,
  TraceStep,
  UserQuestionRequest,
} from '../types';

export interface SnapChatState {
  messages: Message[];
  partial: string;
  status: SessionStatus | 'starting' | null;
  error: string | null;
  /** Tool currently running (for a one-line "Using X..." row). */
  activeTool: { stepId: string; name: string } | null;
  permission: PermissionRequest | null;
  question: UserQuestionRequest | null;
}

type Action =
  | { type: 'event'; event: ScreenSnapSessionEvent }
  | { type: 'starting' }
  | { type: 'sending' }
  | { type: 'failed'; error: string }
  | { type: 'reset' };

const initialState: SnapChatState = {
  messages: [],
  partial: '',
  status: null,
  error: null,
  activeTool: null,
  permission: null,
  question: null,
};

function upsertMessage(messages: Message[], message: Message): Message[] {
  const index = messages.findIndex((m) => m.id === message.id);
  if (index === -1) return [...messages, message];
  const next = messages.slice();
  next[index] = message;
  return next;
}

export function snapChatReducer(state: SnapChatState, action: Action): SnapChatState {
  switch (action.type) {
    case 'reset':
      return initialState;
    case 'starting':
      return { ...initialState, status: 'starting' };
    case 'sending':
      return { ...state, status: 'running', error: null };
    case 'failed':
      return { ...state, status: 'error', error: action.error, partial: '', activeTool: null };
    case 'event':
      break;
  }

  const { event } = action;
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case 'stream.message': {
      const message = payload.message as Message;
      return {
        ...state,
        messages: upsertMessage(state.messages, message),
        partial: message.role === 'assistant' ? '' : state.partial,
      };
    }
    case 'stream.messageUpdate':
      return { ...state, messages: upsertMessage(state.messages, payload.message as Message) };
    case 'stream.partial':
      return { ...state, partial: state.partial + String(payload.delta ?? '') };
    case 'session.status': {
      const status = payload.status as SessionStatus;
      const running = status === 'running';
      return {
        ...state,
        status,
        error: status === 'error' ? String(payload.error ?? '') || state.error : null,
        partial: running ? state.partial : '',
        activeTool: running ? state.activeTool : null,
      };
    }
    case 'trace.step': {
      const step = payload.step as TraceStep;
      if (step.type !== 'tool_call') return state;
      if (step.status === 'running' || step.status === 'pending') {
        return {
          ...state,
          activeTool: { stepId: step.id, name: step.toolName || step.title },
        };
      }
      return state.activeTool?.stepId === step.id ? { ...state, activeTool: null } : state;
    }
    case 'trace.update': {
      const stepId = payload.stepId as string | undefined;
      const updates = (payload.updates ?? {}) as Partial<TraceStep>;
      if (
        state.activeTool &&
        state.activeTool.stepId === stepId &&
        (updates.status === 'completed' || updates.status === 'error')
      ) {
        return { ...state, activeTool: null };
      }
      return state;
    }
    case 'permission.request':
      return { ...state, permission: payload as unknown as PermissionRequest };
    case 'permission.dismiss':
      return state.permission?.toolUseId === payload.toolUseId
        ? { ...state, permission: null }
        : state;
    case 'question.request':
      return { ...state, question: payload as unknown as UserQuestionRequest };
    case 'question.dismiss':
      return state.question?.questionId === payload.questionId
        ? { ...state, question: null }
        : state;
    default:
      return state;
  }
}

/**
 * State for the Screen Snap panel's in-place chat. Subscribes on mount so the
 * first events of a freshly started session are never missed.
 */
export function useSnapChat() {
  const [state, dispatch] = useReducer(snapChatReducer, initialState);

  useEffect(() => {
    const api = window.electronAPI?.snap;
    if (!api) return;
    return api.onSessionEvent((event) => dispatch({ type: 'event', event }));
  }, []);

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  const markStarting = useCallback(() => dispatch({ type: 'starting' }), []);
  const markSending = useCallback(() => dispatch({ type: 'sending' }), []);
  const markFailed = useCallback((error: string) => dispatch({ type: 'failed', error }), []);

  return { state, reset, markStarting, markSending, markFailed };
}
