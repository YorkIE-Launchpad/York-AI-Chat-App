/**
 * Knowledge tools for voice control: web search, reading a page, opening a URL,
 * and `ask_growthos`, which hands a task to a full GrowthOS agent session (all
 * MCP connectors, skills, and built-in tools) and waits for its answer.
 */
import type { VoiceActionResult } from '../../shared/voice-control';
import { log } from '../utils/logger';

/** What the Realtime model gets back; it summarises this aloud. */
const SEARCH_RESULT_MAX = 3000;
const PAGE_RESULT_MAX = 4000;
const AGENT_RESULT_MAX = 2000;
export const AGENT_TIMEOUT_MS = 150_000;

export interface VoiceAssistantDeps {
  searchWeb?: (query: string) => Promise<string>;
  fetchPage?: (url: string) => Promise<string>;
  openUrl?: (url: string) => Promise<void>;
  askAgent?: (task: string, onProgress?: (text: string) => void) => Promise<VoiceActionResult>;
  onProgress?: (text: string) => void;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Accepts "github.com/foo" as well as full URLs; only http(s) is allowed. */
export function normalizeUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function runAssistantAction(
  name: string,
  args: Record<string, unknown>,
  deps: VoiceAssistantDeps
): Promise<VoiceActionResult> {
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
  switch (name) {
    case 'web_search': {
      const query = text('query');
      if (!query) return { ok: false, message: 'Say what to search for.' };
      if (!deps.searchWeb) return { ok: false, message: 'Web search is unavailable.' };
      deps.onProgress?.(`Searching the web for “${query}”…`);
      return { ok: true, message: clip(await deps.searchWeb(query), SEARCH_RESULT_MAX) };
    }
    case 'read_webpage': {
      const url = normalizeUrl(text('url'));
      if (!url) return { ok: false, message: 'That is not a web address I can read.' };
      if (!deps.fetchPage) return { ok: false, message: 'Reading pages is unavailable.' };
      deps.onProgress?.(`Reading ${new URL(url).hostname}…`);
      return { ok: true, message: clip(await deps.fetchPage(url), PAGE_RESULT_MAX) };
    }
    case 'open_url': {
      const url = normalizeUrl(text('url'));
      if (!url) return { ok: false, message: 'That is not a web address I can open.' };
      if (!deps.openUrl) return { ok: false, message: 'Opening links is unavailable.' };
      await deps.openUrl(url);
      return { ok: true, message: `Opened ${new URL(url).hostname}.` };
    }
    case 'ask_growthos': {
      const task = text('task');
      if (!task) return { ok: false, message: 'Say what GrowthOS should do.' };
      if (!deps.askAgent) return { ok: false, message: 'GrowthOS is not ready yet.' };
      deps.onProgress?.('Asking GrowthOS…');
      return await deps.askAgent(task, deps.onProgress);
    }
    default:
      return { ok: false, message: `Unknown action "${name}".` };
  }
}

/** The slice of `ServerEvent` the bridge listens to. */
export type VoiceAgentEvent =
  | {
      type: 'stream.message';
      payload: {
        sessionId: string;
        message: { role?: string; content?: Array<{ type: string; text?: string }> };
      };
    }
  | { type: 'session.status'; payload: { sessionId: string; status: string; error?: string } }
  | {
      type: 'trace.step';
      payload: { sessionId: string; step: { type?: string; toolName?: string; status?: string } };
    }
  | { type: 'permission.request'; payload: { sessionId: string; toolName: string } }
  | { type: 'question.request'; payload: { sessionId: string } }
  | { type: string; payload?: unknown };

export interface VoiceAgentBridgeDeps {
  startSession: (title: string, prompt: string) => Promise<{ id: string }>;
  continueSession: (sessionId: string, prompt: string) => Promise<void>;
  hasSession: (sessionId: string) => boolean;
  /** Bring GrowthOS forward on this session when the agent needs the user. */
  showSession?: (sessionId: string) => void;
  timeoutMs?: number;
}

interface Waiter {
  reply: string;
  onProgress?: (text: string) => void;
  finish: (result: VoiceActionResult) => void;
}

const VOICE_TASK_PREFIX = [
  '[Voice request from the user. Do the task fully with your tools.',
  'Your final reply is read aloud: answer in 1-3 short plain sentences, no markdown, lists, tables, or links.]',
].join(' ');

function prettyToolName(toolName: string): string {
  const parts = toolName.split('__').filter(Boolean);
  const server = parts.length > 2 ? parts[1] : null;
  const tool = (parts.at(-1) ?? toolName).replace(/[_-]+/g, ' ');
  return server ? `${server.replace(/[_-]+/g, ' ')}: ${tool}` : tool;
}

/**
 * Runs voice tasks as a normal GrowthOS chat (visible in the sidebar), reusing
 * one chat per voice session so follow-ups keep their context.
 */
export class VoiceAgentBridge {
  private sessionId: string | null = null;
  private readonly waiters = new Map<string, Waiter>();

  constructor(private readonly deps: VoiceAgentBridgeDeps) {}

  /** A new voice session starts a new chat. */
  reset(): void {
    this.sessionId = null;
  }

  ask = async (task: string, onProgress?: (text: string) => void): Promise<VoiceActionResult> => {
    const prompt = `${VOICE_TASK_PREFIX}\n\n${task}`;
    const reuse = this.sessionId && this.deps.hasSession(this.sessionId) ? this.sessionId : null;
    if (reuse && this.waiters.has(reuse)) {
      return { ok: false, message: 'GrowthOS is still working on the previous request.' };
    }

    let sessionId = reuse;
    const done = new Promise<VoiceActionResult>((resolve) => {
      const start = async () => {
        if (sessionId) {
          this.register(sessionId, onProgress, resolve);
          await this.deps.continueSession(sessionId, prompt);
        } else {
          const title = `Voice: ${task.length > 60 ? `${task.slice(0, 57)}…` : task}`;
          const session = await this.deps.startSession(title, prompt);
          sessionId = session.id;
          this.sessionId = session.id;
          this.register(session.id, onProgress, resolve);
        }
      };
      start().catch((error: unknown) => {
        if (sessionId) this.waiters.delete(sessionId);
        resolve({
          ok: false,
          message: `GrowthOS could not start: ${error instanceof Error ? error.message : String(error)}`,
        });
      });
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<VoiceActionResult>((resolve) => {
      timer = setTimeout(() => {
        if (sessionId) this.waiters.delete(sessionId);
        resolve({
          ok: true,
          message: 'GrowthOS is still working on it. The answer will be in the GrowthOS chat.',
        });
      }, this.deps.timeoutMs ?? AGENT_TIMEOUT_MS);
    });
    try {
      return await Promise.race([done, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** Feed every `ServerEvent` here; events for other chats are ignored. */
  handleEvent(event: VoiceAgentEvent): void {
    const payload = event.payload as { sessionId?: string } | undefined;
    const waiter = payload?.sessionId ? this.waiters.get(payload.sessionId) : undefined;
    if (!waiter || !payload?.sessionId) return;
    const sessionId = payload.sessionId;

    switch (event.type) {
      case 'stream.message': {
        const { message } = (event as Extract<VoiceAgentEvent, { type: 'stream.message' }>).payload;
        if (message?.role !== 'assistant' || !Array.isArray(message.content)) return;
        const text = message.content
          .filter((block) => block.type === 'text' && block.text)
          .map((block) => block.text)
          .join('\n')
          .trim();
        if (text) waiter.reply = text;
        return;
      }
      case 'trace.step': {
        const { step } = (event as Extract<VoiceAgentEvent, { type: 'trace.step' }>).payload;
        if (step?.type === 'tool_call' && step.toolName && step.status === 'running') {
          waiter.onProgress?.(`Using ${prettyToolName(step.toolName)}…`);
        }
        return;
      }
      case 'permission.request': {
        const { toolName } = (event as Extract<VoiceAgentEvent, { type: 'permission.request' }>)
          .payload;
        this.deps.showSession?.(sessionId);
        waiter.finish({
          ok: false,
          message: `GrowthOS needs your approval to use ${prettyToolName(toolName)}. Approve it in the GrowthOS window.`,
        });
        return;
      }
      case 'question.request':
        this.deps.showSession?.(sessionId);
        waiter.finish({
          ok: false,
          message: 'GrowthOS has a question for you. Answer it in the GrowthOS window.',
        });
        return;
      case 'session.status': {
        const { status, error } = (event as Extract<VoiceAgentEvent, { type: 'session.status' }>)
          .payload;
        if (status === 'error') {
          waiter.finish({
            ok: false,
            message: `GrowthOS hit an error: ${error ?? 'unknown error'}.`,
          });
        } else if (status === 'idle' || status === 'completed') {
          waiter.finish({
            ok: true,
            message: waiter.reply ? clip(waiter.reply, AGENT_RESULT_MAX) : 'Done.',
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private register(
    sessionId: string,
    onProgress: ((text: string) => void) | undefined,
    resolve: (result: VoiceActionResult) => void
  ): void {
    this.waiters.set(sessionId, {
      reply: '',
      onProgress,
      finish: (result) => {
        this.waiters.delete(sessionId);
        log('[Voice] GrowthOS task finished', sessionId, result.ok);
        resolve(result);
      },
    });
  }
}
