/**
 * Convert Claude / ChatGPT / Markdown / PDF conversation exports into York
 * portable chat payloads (ChatExportPayload).
 */
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import extract from 'extract-zip';
import type { Message, MessageRole } from '../../renderer/types';
import type { ChatExportPayload, PortableSessionMeta } from './session-transfer';
import { logWarn } from '../utils/logger';

const execFileAsync = promisify(execFile);

export const MAX_EXTERNAL_CONVERSATIONS = 50;

export interface ExternalImportResult {
  payloads: ChatExportPayload[];
  source: 'chatgpt' | 'claude' | 'markdown' | 'pdf' | 'unknown';
}

function defaultSessionMeta(title: string): PortableSessionMeta {
  return {
    title: title.trim() || 'Imported chat',
    allowedTools: [],
    memoryEnabled: true,
  };
}

function textMessage(
  role: MessageRole,
  text: string,
  timestamp: number,
  index: number
): Message {
  return {
    id: `import-${index}-${randomUUID().slice(0, 8)}`,
    sessionId: 'pending',
    role,
    content: [{ type: 'text', text }],
    timestamp,
  };
}

function payloadFromTurns(
  title: string,
  turns: Array<{ role: MessageRole; text: string; timestamp?: number }>
): ChatExportPayload | null {
  const messages: Message[] = [];
  let i = 0;
  for (const turn of turns) {
    const text = (turn.text || '').trim();
    if (!text) continue;
    if (turn.role !== 'user' && turn.role !== 'assistant' && turn.role !== 'system') continue;
    messages.push(
      textMessage(turn.role, text, turn.timestamp || Date.now() + i, i)
    );
    i += 1;
  }
  if (messages.length === 0) return null;
  return {
    session: defaultSessionMeta(title),
    messages,
    traceSteps: [],
  };
}

function extractChatGptParts(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const c = content as Record<string, unknown>;
  if (typeof c.text === 'string') return c.text;
  if (Array.isArray(c.parts)) {
    return c.parts
      .map((p) => (typeof p === 'string' ? p : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Walk ChatGPT mapping tree in conversation order (DFS from root). */
function chatgptTurnsFromMapping(
  mapping: Record<string, unknown>
): Array<{ role: MessageRole; text: string; timestamp?: number }> {
  const turns: Array<{ role: MessageRole; text: string; timestamp?: number }> = [];
  const visited = new Set<string>();

  const roots = Object.values(mapping).filter((node) => {
    if (!node || typeof node !== 'object') return false;
    const parent = (node as Record<string, unknown>).parent;
    return parent == null || parent === '';
  });

  const visit = (nodeId: string | null | undefined) => {
    if (!nodeId || typeof nodeId !== 'string' || visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = mapping[nodeId];
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    const message = n.message;
    if (message && typeof message === 'object') {
      const m = message as Record<string, unknown>;
      const author =
        m.author && typeof m.author === 'object'
          ? (m.author as Record<string, unknown>)
          : null;
      const roleRaw = typeof author?.role === 'string' ? author.role : '';
      let role: MessageRole | null = null;
      if (roleRaw === 'user') role = 'user';
      else if (roleRaw === 'assistant') role = 'assistant';
      else if (roleRaw === 'system') role = 'system';
      const text = extractChatGptParts(m.content);
      if (role && text.trim()) {
        const ts =
          typeof m.create_time === 'number'
            ? Math.round(m.create_time * 1000)
            : undefined;
        turns.push({ role, text, timestamp: ts });
      }
    }
    const children = Array.isArray(n.children) ? n.children : [];
    for (const child of children) {
      if (typeof child === 'string') visit(child);
    }
  };

  if (roots.length > 0) {
    for (const root of roots) {
      const id = (root as Record<string, unknown>).id;
      if (typeof id === 'string') visit(id);
    }
  } else {
    // Fallback: chronological by create_time
    const nodes = Object.values(mapping)
      .filter((n): n is Record<string, unknown> => Boolean(n) && typeof n === 'object')
      .sort((a, b) => {
        const am =
          a.message && typeof a.message === 'object'
            ? (a.message as Record<string, unknown>).create_time
            : 0;
        const bm =
          b.message && typeof b.message === 'object'
            ? (b.message as Record<string, unknown>).create_time
            : 0;
        return (typeof am === 'number' ? am : 0) - (typeof bm === 'number' ? bm : 0);
      });
    for (const n of nodes) {
      if (typeof n.id === 'string') visit(n.id);
    }
  }

  return turns;
}

export function convertChatGptConversations(data: unknown): ChatExportPayload[] {
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).conversations)
      ? ((data as Record<string, unknown>).conversations as unknown[])
      : null;
  if (!rows) return [];

  const payloads: ChatExportPayload[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const mapping = r.mapping;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) continue;
    const title =
      typeof r.title === 'string' && r.title.trim()
        ? r.title.trim()
        : 'ChatGPT conversation';
    const payload = payloadFromTurns(
      title,
      chatgptTurnsFromMapping(mapping as Record<string, unknown>)
    );
    if (payload) payloads.push(payload);
    if (payloads.length >= MAX_EXTERNAL_CONVERSATIONS) break;
  }
  return payloads;
}

function claudeMessageText(msg: Record<string, unknown>): string {
  if (typeof msg.text === 'string' && msg.text.trim()) return msg.text;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string') return b.text;
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function convertClaudeConversations(data: unknown): ChatExportPayload[] {
  const rows = Array.isArray(data) ? data : null;
  if (!rows) return [];

  const payloads: ChatExportPayload[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const messages = Array.isArray(r.chat_messages)
      ? r.chat_messages
      : Array.isArray(r.messages)
        ? r.messages
        : null;
    if (!messages) continue;

    const title =
      (typeof r.name === 'string' && r.name.trim()) ||
      (typeof r.title === 'string' && r.title.trim()) ||
      'Claude conversation';

    const turns: Array<{ role: MessageRole; text: string; timestamp?: number }> = [];
    for (const raw of messages) {
      if (!raw || typeof raw !== 'object') continue;
      const m = raw as Record<string, unknown>;
      const sender = typeof m.sender === 'string' ? m.sender.toLowerCase() : '';
      const roleField = typeof m.role === 'string' ? m.role.toLowerCase() : '';
      let role: MessageRole | null = null;
      if (sender === 'human' || sender === 'user' || roleField === 'user' || roleField === 'human') {
        role = 'user';
      } else if (
        sender === 'assistant' ||
        sender === 'claude' ||
        roleField === 'assistant'
      ) {
        role = 'assistant';
      }
      const text = claudeMessageText(m);
      if (!role || !text.trim()) continue;
      let timestamp: number | undefined;
      if (typeof m.created_at === 'string') {
        const parsed = Date.parse(m.created_at);
        if (!Number.isNaN(parsed)) timestamp = parsed;
      } else if (typeof m.created_at === 'number') {
        timestamp = m.created_at > 1e12 ? m.created_at : Math.round(m.created_at * 1000);
      }
      turns.push({ role, text, timestamp });
    }

    const payload = payloadFromTurns(title, turns);
    if (payload) payloads.push(payload);
    if (payloads.length >= MAX_EXTERNAL_CONVERSATIONS) break;
  }
  return payloads;
}

const TRANSCRIPT_SPEAKER =
  /^(?:#{1,6}\s*)?(?:\*{0,2})?(User|Human|Assistant|Claude|ChatGPT|System)(?:\*{0,2})?\s*[:：]\s*/gim;

export function convertMarkdownTranscript(
  text: string,
  title = 'Imported transcript'
): ChatExportPayload | null {
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return null;

  const turns: Array<{ role: MessageRole; text: string }> = [];
  let currentRole: MessageRole | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (!currentRole) return;
    const body = buffer.join('\n').trim();
    if (body) turns.push({ role: currentRole, text: body });
    buffer = [];
  };

  const lines = cleaned.split(/\r?\n/);
  let sawSpeaker = false;
  for (const line of lines) {
    TRANSCRIPT_SPEAKER.lastIndex = 0;
    const match = TRANSCRIPT_SPEAKER.exec(line);
    if (match && match.index === 0) {
      sawSpeaker = true;
      flush();
      const label = match[1].toLowerCase();
      if (label === 'user' || label === 'human') currentRole = 'user';
      else if (label === 'system') currentRole = 'system';
      else currentRole = 'assistant';
      const rest = line.slice(match[0].length);
      buffer = rest ? [rest] : [];
    } else if (currentRole) {
      buffer.push(line);
    }
  }
  flush();

  if (!sawSpeaker || turns.length === 0) {
    // Single blob — treat as one user message so the chat is still usable.
    return payloadFromTurns(title, [{ role: 'user', text: cleaned }]);
  }

  return payloadFromTurns(title, turns);
}

async function extractPdfText(filePath: string): Promise<string> {
  const script = `
import sys
path = sys.argv[1]
try:
    from pypdf import PdfReader
except ImportError:
    try:
        from PyPDF2 import PdfReader
    except ImportError:
        sys.stderr.write('pypdf is not installed')
        sys.exit(2)
reader = PdfReader(path)
parts = []
for page in reader.pages:
    t = page.extract_text() or ''
    if t.strip():
        parts.append(t)
sys.stdout.write('\\n'.join(parts))
`;
  try {
    const { stdout } = await execFileAsync(
      'python3',
      ['-c', script, filePath],
      { maxBuffer: 20 * 1024 * 1024, timeout: 60_000 }
    );
    return stdout || '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/pypdf is not installed/i.test(message) || /exit code 2/i.test(message)) {
      throw new Error(
        'PDF import requires Python pypdf. Install with: pip install pypdf — or export as Markdown/JSON instead.'
      );
    }
    throw new Error(`Failed to extract PDF text: ${message}`);
  }
}

function looksLikeChatGpt(data: unknown): boolean {
  if (!Array.isArray(data) || data.length === 0) return false;
  const first = data[0];
  return Boolean(
    first &&
      typeof first === 'object' &&
      (first as Record<string, unknown>).mapping &&
      typeof (first as Record<string, unknown>).mapping === 'object'
  );
}

function looksLikeClaude(data: unknown): boolean {
  if (!Array.isArray(data) || data.length === 0) return false;
  const first = data[0];
  if (!first || typeof first !== 'object') return false;
  const r = first as Record<string, unknown>;
  return Array.isArray(r.chat_messages) || (Array.isArray(r.messages) && (typeof r.name === 'string' || typeof r.uuid === 'string'));
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await fs.promises.readFile(filePath, 'utf8');
  return JSON.parse(raw) as unknown;
}

async function tryConvertJson(data: unknown): Promise<ExternalImportResult | null> {
  if (looksLikeChatGpt(data)) {
    const payloads = convertChatGptConversations(data);
    if (payloads.length) return { payloads, source: 'chatgpt' };
  }
  if (looksLikeClaude(data)) {
    const payloads = convertClaudeConversations(data);
    if (payloads.length) return { payloads, source: 'claude' };
  }
  // Try both even if heuristics fail (single conversation shapes)
  const chatgpt = convertChatGptConversations(data);
  if (chatgpt.length) return { payloads: chatgpt, source: 'chatgpt' };
  const claude = convertClaudeConversations(data);
  if (claude.length) return { payloads: claude, source: 'claude' };
  return null;
}

async function importFromExtractedDir(dir: string): Promise<ExternalImportResult | null> {
  const candidates = [
    path.join(dir, 'conversations.json'),
    path.join(dir, 'chat.html'), // ignore for now
  ];
  // Also search one level deep
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase() === 'conversations.json') {
      candidates.unshift(path.join(dir, entry.name));
    }
    if (entry.isDirectory()) {
      const nested = path.join(dir, entry.name, 'conversations.json');
      if (fs.existsSync(nested)) candidates.push(nested);
    }
  }

  for (const candidate of candidates) {
    if (!candidate.endsWith('.json') || !fs.existsSync(candidate)) continue;
    try {
      const data = await readJsonFile(candidate);
      const converted = await tryConvertJson(data);
      if (converted) return converted;
    } catch (err) {
      logWarn('[ExternalChatImport] Failed parsing', candidate, err);
    }
  }
  return null;
}

/**
 * Detect and convert an external chat export file into York payloads.
 * Returns null when the file is not a recognized external format (caller may try .yorkchat).
 */
export async function convertExternalChatFile(
  sourcePath: string
): Promise<ExternalImportResult | null> {
  if (!fs.existsSync(sourcePath)) {
    throw new Error('File not found');
  }

  const ext = path.extname(sourcePath).toLowerCase();
  const baseTitle = path.basename(sourcePath, ext);

  if (ext === '.md' || ext === '.txt' || ext === '.markdown') {
    const text = await fs.promises.readFile(sourcePath, 'utf8');
    const payload = convertMarkdownTranscript(text, baseTitle);
    if (!payload) return null;
    return { payloads: [payload], source: 'markdown' };
  }

  if (ext === '.pdf') {
    const text = await extractPdfText(sourcePath);
    if (!text.trim()) {
      throw new Error('No text could be extracted from this PDF');
    }
    const payload = convertMarkdownTranscript(text, baseTitle);
    if (!payload) return null;
    return { payloads: [payload], source: 'pdf' };
  }

  if (ext === '.json') {
    const data = await readJsonFile(sourcePath);
    return tryConvertJson(data);
  }

  if (ext === '.zip' || ext === '.yorkchat') {
    const tempRoot = path.join(os.tmpdir(), `york-ext-chat-${randomUUID()}`);
    const extractDir = path.join(tempRoot, 'extracted');
    try {
      await fs.promises.mkdir(extractDir, { recursive: true });
      await extract(sourcePath, { dir: extractDir });

      // York format — signal caller to use native importer
      if (
        fs.existsSync(path.join(extractDir, 'manifest.json')) &&
        fs.existsSync(path.join(extractDir, 'chat.json'))
      ) {
        return null;
      }

      return await importFromExtractedDir(extractDir);
    } finally {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  return null;
}
