/**
 * Auto-share chat documents (HTML / Markdown artifacts) with a shared chat room.
 */
import type { Message } from '../../renderer/types';
import type { CollabSharedDocEntry } from '../../shared/collab/shared-session-doc';
import { sharedDocAccessCanEdit } from '../../shared/shared-docs/types';
import { sharedDocsService, workspaceRelativePath } from '../shared-docs/shared-docs-service';
import {
  getSharedDocLink,
  getSharedDocLinkByLocalPath,
  listSharedDocLinksForSession,
} from '../shared-docs/shared-doc-link-store';
import { logError } from '../utils/logger';

export type PublishedChatDoc = Pick<
  CollabSharedDocEntry,
  'docId' | 'inviteToken' | 'title' | 'kind'
>;

const FILE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'Write', 'Edit', 'write', 'edit']);

const DOCUMENT_PATH_RE = /\.(html?|md|markdown)$/i;

export function isChatDocumentPath(path: string): boolean {
  return DOCUMENT_PATH_RE.test(path.trim());
}

/** Document paths written or edited by file tools in these messages, in first-seen order. */
export function collectChatDocumentPaths(messages: Message[]): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== 'tool_use' || !FILE_TOOL_NAMES.has(block.name)) continue;
      const input = block.input ?? {};
      const candidate = [input.path, input.file_path, input.filePath, input.relativePath].find(
        (value): value is string => typeof value === 'string' && value.trim().length > 0
      );
      if (!candidate || !isChatDocumentPath(candidate)) continue;
      const key = candidate.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(key);
    }
  }
  return paths;
}

/**
 * Upload chat documents to Hub (when not linked yet) and mint edit invites for the room.
 * Also covers editable shared-doc links already attached to the session.
 */
export async function publishChatDocuments(input: {
  sessionId: string;
  cwd: string;
  paths: string[];
  alreadyPublished: Set<string>;
}): Promise<PublishedChatDoc[]> {
  const published: PublishedChatDoc[] = [];
  const handled = new Set(input.alreadyPublished);

  for (const path of input.paths) {
    let relativePath: string;
    try {
      relativePath = workspaceRelativePath(input.cwd, path);
    } catch {
      continue;
    }
    if (!relativePath || relativePath.startsWith('..')) continue;
    if (getSharedDocLinkByLocalPath(input.sessionId, relativePath)) continue;
    try {
      const { doc, inviteToken } = await sharedDocsService.shareLocalArtifact({
        sessionId: input.sessionId,
        cwd: input.cwd,
        localPath: relativePath,
        permission: 'edit',
      });
      handled.add(doc.id);
      published.push({ docId: doc.id, inviteToken, title: doc.title, kind: doc.kind });
    } catch (error) {
      logError(`[Collab] auto-share document failed (${relativePath}):`, error);
    }
  }

  for (const link of listSharedDocLinksForSession(input.sessionId)) {
    if (handled.has(link.doc_id) || !sharedDocAccessCanEdit(link.permission)) continue;
    try {
      const invite = await sharedDocsService.createInvite({
        docId: link.doc_id,
        permission: 'edit',
        sessionId: input.sessionId,
      });
      handled.add(link.doc_id);
      published.push({
        docId: link.doc_id,
        inviteToken: invite.inviteToken,
        title: link.title,
        kind: link.kind === 'markdown' ? 'markdown' : 'html',
      });
    } catch (error) {
      logError(`[Collab] auto-share invite failed (${link.doc_id}):`, error);
    }
  }

  return published;
}

/** Join and download room documents this session does not have yet. Returns new local paths. */
export async function adoptChatDocuments(input: {
  sessionId: string;
  cwd: string;
  entries: CollabSharedDocEntry[];
}): Promise<string[]> {
  const adopted: string[] = [];
  for (const entry of input.entries) {
    if (getSharedDocLink(entry.docId, input.sessionId)) continue;
    try {
      const doc = await sharedDocsService.joinByInvite(entry.inviteToken);
      const { localPath } = await sharedDocsService.materializeSharedDoc({
        sessionId: input.sessionId,
        cwd: input.cwd,
        docId: doc.id,
        doc,
      });
      adopted.push(localPath);
    } catch (error) {
      logError(`[Collab] auto-join document failed (${entry.docId}):`, error);
    }
  }
  return adopted;
}
