/**
 * Portable chat export/import (.yorkchat ZIP).
 *
 * Format:
 *   manifest.json  — { format: "york-chat", version: 1, exportedAt, appVersion? }
 *   chat.json      — session metadata + messages + trace steps
 *   attachments/*  — binary files for file_attachment blocks
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import extract from 'extract-zip';
import type {
  ContentBlock,
  FileAttachmentContent,
  Message,
  Session,
  TraceStep,
} from '../../renderer/types';
import type { WorkspaceDivisionKind } from '../../shared/workspace-division';
import { log, logError, logWarn } from '../utils/logger';

export const YORK_CHAT_FORMAT = 'york-chat' as const;
export const YORK_CHAT_VERSION = 1 as const;

export interface ChatExportManifest {
  format: typeof YORK_CHAT_FORMAT;
  version: typeof YORK_CHAT_VERSION;
  exportedAt: number;
  appVersion?: string;
}

export interface PortableSessionMeta {
  title: string;
  model?: string;
  allowedTools: string[];
  memoryEnabled: boolean;
  division?: WorkspaceDivisionKind;
  hubProjectId?: string | null;
  hubProjectName?: string | null;
}

export interface ChatExportPayload {
  session: PortableSessionMeta;
  messages: Message[];
  traceSteps: TraceStep[];
}

export interface SessionTransferExportDeps {
  getSession: (sessionId: string) => Session | null;
  getMessages: (sessionId: string) => Message[];
  getTraceSteps: (sessionId: string) => TraceStep[];
  appVersion?: string;
}

export interface SessionTransferImportDeps {
  importSession: (
    payload: ChatExportPayload,
    attachmentFiles: Map<string, Buffer>,
    options: { cwd?: string }
  ) => Session;
}

function sanitizeZipEntryName(name: string): string {
  return name
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.\./g, '_')
    .replace(/[^a-zA-Z0-9._\-/]/g, '_');
}

function attachmentZipKey(relativePath: string, filename: string): string {
  const base = path.basename(relativePath || filename || `attachment-${Date.now()}`);
  return sanitizeZipEntryName(base || `attachment-${Date.now()}`);
}

function resolveAttachmentDiskPath(session: Session, block: FileAttachmentContent): string | null {
  const rel = (block.relativePath || '').trim();
  if (!rel) return null;
  if (path.isAbsolute(rel) && fs.existsSync(rel)) {
    return rel;
  }
  const cwd = session.cwd || process.cwd();
  const candidate = path.join(cwd, rel);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  // Legacy: relativePath sometimes stored as bare filename under .tmp
  const tmpCandidate = path.join(cwd, '.tmp', path.basename(rel));
  if (fs.existsSync(tmpCandidate)) {
    return tmpCandidate;
  }
  return null;
}

export function buildPortablePayload(
  session: Session,
  messages: Message[],
  traceSteps: TraceStep[]
): ChatExportPayload {
  return {
    session: {
      title: session.title,
      model: session.model,
      allowedTools: [...session.allowedTools],
      memoryEnabled: session.memoryEnabled,
      division: session.division,
      hubProjectId: session.hubProjectId ?? null,
      hubProjectName: session.hubProjectName ?? null,
    },
    // Deep-clone content so export path rewrites never mutate live session cache
    messages: messages.map((m) => ({
      ...m,
      content: JSON.parse(JSON.stringify(m.content)) as ContentBlock[],
      localStatus: undefined,
    })),
    traceSteps: traceSteps.map((step) => ({ ...step })),
  };
}

export async function exportSessionToPath(
  deps: SessionTransferExportDeps,
  sessionId: string,
  destPath: string
): Promise<{ success: boolean; path?: string; error?: string }> {
  const session = deps.getSession(sessionId);
  if (!session) {
    return { success: false, error: 'Session not found' };
  }
  if (session.incognito) {
    return { success: false, error: 'Incognito chats cannot be exported' };
  }

  const liveMessages = deps.getMessages(sessionId);
  const traceSteps = deps.getTraceSteps(sessionId);
  const payload = buildPortablePayload(session, liveMessages, traceSteps);

  const attachmentEntries: Array<{ zipName: string; diskPath: string }> = [];
  const usedNames = new Set<string>();

  for (let mi = 0; mi < liveMessages.length; mi++) {
    const liveMessage = liveMessages[mi];
    const payloadMessage = payload.messages[mi];
    if (!liveMessage || !payloadMessage) continue;

    for (let bi = 0; bi < liveMessage.content.length; bi++) {
      const liveBlock = liveMessage.content[bi];
      const payloadBlock = payloadMessage.content[bi];
      if (liveBlock?.type !== 'file_attachment' || payloadBlock?.type !== 'file_attachment') {
        continue;
      }
      const liveFile = liveBlock as FileAttachmentContent;
      const payloadFile = payloadBlock as FileAttachmentContent;
      const diskPath = resolveAttachmentDiskPath(session, liveFile);
      if (!diskPath) {
        logWarn(
          '[SessionTransfer] Skipping missing attachment:',
          liveFile.filename || liveFile.relativePath
        );
        continue;
      }
      let zipName = attachmentZipKey(liveFile.relativePath, liveFile.filename);
      if (usedNames.has(zipName)) {
        const ext = path.extname(zipName);
        const stem = path.basename(zipName, ext);
        zipName = `${stem}-${randomUUID().slice(0, 8)}${ext}`;
      }
      usedNames.add(zipName);
      attachmentEntries.push({ zipName, diskPath });
      payloadFile.relativePath = `.tmp/${path.basename(zipName)}`;
      delete payloadFile.inlineDataBase64;
    }
  }

  const manifest: ChatExportManifest = {
    format: YORK_CHAT_FORMAT,
    version: YORK_CHAT_VERSION,
    exportedAt: Date.now(),
    appVersion: deps.appVersion,
  };

  try {
    const archiver = await import('archiver');
    const output = fs.createWriteStream(destPath);
    const archive = archiver.default('zip', { zlib: { level: 9 } });

    return await new Promise((resolve) => {
      let settled = false;
      const settle = (value: { success: boolean; path?: string; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      output.on('close', () => {
        log('[SessionTransfer] Exported chat to', destPath, `(${archive.pointer()} bytes)`);
        settle({ success: true, path: destPath });
      });
      output.on('error', (err) => {
        logError('[SessionTransfer] Export write error:', err);
        settle({ success: false, error: err.message });
      });
      archive.on('error', (err) => {
        logError('[SessionTransfer] Archive error:', err);
        settle({ success: false, error: err.message });
      });

      archive.pipe(output);
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
      archive.append(JSON.stringify(payload, null, 2), { name: 'chat.json' });
      for (const entry of attachmentEntries) {
        archive.file(entry.diskPath, { name: `attachments/${entry.zipName}` });
      }
      void archive.finalize();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError('[SessionTransfer] Export failed:', error);
    return { success: false, error: message };
  }
}

function isPortableSessionMeta(value: unknown): value is PortableSessionMeta {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.title === 'string' && Array.isArray(obj.allowedTools);
}

function isChatExportPayload(value: unknown): value is ChatExportPayload {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    isPortableSessionMeta(obj.session) &&
    Array.isArray(obj.messages) &&
    Array.isArray(obj.traceSteps)
  );
}

function parseManifest(raw: string): ChatExportManifest {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid manifest.json');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.format !== YORK_CHAT_FORMAT) {
    throw new Error(`Unsupported chat format: ${String(obj.format)}`);
  }
  if (obj.version !== YORK_CHAT_VERSION) {
    throw new Error(`Unsupported chat export version: ${String(obj.version)}`);
  }
  return {
    format: YORK_CHAT_FORMAT,
    version: YORK_CHAT_VERSION,
    exportedAt: typeof obj.exportedAt === 'number' ? obj.exportedAt : Date.now(),
    appVersion: typeof obj.appVersion === 'string' ? obj.appVersion : undefined,
  };
}

export async function importSessionFromPath(
  deps: SessionTransferImportDeps,
  sourcePath: string,
  options: { cwd?: string } = {}
): Promise<{ success: boolean; session?: Session; error?: string }> {
  if (!fs.existsSync(sourcePath)) {
    return { success: false, error: 'File not found' };
  }

  const tempRoot = path.join(os.tmpdir(), `york-chat-import-${randomUUID()}`);
  const extractDir = path.join(tempRoot, 'extracted');

  try {
    fs.mkdirSync(extractDir, { recursive: true });
    await extract(sourcePath, { dir: extractDir });

    const manifestPath = path.join(extractDir, 'manifest.json');
    const chatPath = path.join(extractDir, 'chat.json');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(chatPath)) {
      return { success: false, error: 'Invalid .yorkchat file (missing manifest or chat.json)' };
    }

    parseManifest(fs.readFileSync(manifestPath, 'utf8'));
    const payloadRaw = JSON.parse(fs.readFileSync(chatPath, 'utf8')) as unknown;
    if (!isChatExportPayload(payloadRaw)) {
      return { success: false, error: 'Invalid chat.json contents' };
    }

    const attachmentFiles = new Map<string, Buffer>();
    const attachmentsDir = path.join(extractDir, 'attachments');
    if (fs.existsSync(attachmentsDir)) {
      const walk = (dir: string, prefix: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          const key = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walk(full, key);
          } else if (entry.isFile()) {
            const buf = fs.readFileSync(full);
            attachmentFiles.set(sanitizeZipEntryName(key), buf);
            // Also index by basename for simpler relativePath matching
            attachmentFiles.set(sanitizeZipEntryName(entry.name), buf);
          }
        }
      };
      walk(attachmentsDir, '');
    }

    // Prefer inline base64 on file blocks when ZIP file is missing
    for (const message of payloadRaw.messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as ContentBlock[]) {
        if (block.type !== 'file_attachment') continue;
        const fileBlock = block as FileAttachmentContent;
        const zipKey = attachmentZipKey(fileBlock.relativePath, fileBlock.filename);
        if (!attachmentFiles.has(zipKey) && fileBlock.inlineDataBase64) {
          attachmentFiles.set(zipKey, Buffer.from(fileBlock.inlineDataBase64, 'base64'));
        }
      }
    }

    const session = deps.importSession(payloadRaw, attachmentFiles, { cwd: options.cwd });
    log('[SessionTransfer] Imported chat as session', session.id);
    return { success: true, session };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError('[SessionTransfer] Import failed:', error);
    return { success: false, error: message };
  } finally {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      logWarn('[SessionTransfer] Failed to clean import temp dir:', cleanupError);
    }
  }
}

/** Sanitize a title for use in a default save filename. */
export function sanitizeChatExportFilename(title: string): string {
  const controlChars = new RegExp(
    `[<>:"/\\\\|?*${String.fromCharCode(0)}-${String.fromCharCode(31)}]`,
    'g'
  );
  const cleaned = title.trim().replace(controlChars, '').replace(/\s+/g, '-').slice(0, 80);
  return cleaned || 'chat';
}
