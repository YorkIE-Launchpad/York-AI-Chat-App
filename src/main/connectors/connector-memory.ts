import type { MemoryService } from '../memory/memory-service';
import { logWarn } from '../utils/logger';
import type { ConnectorId } from './connector-types';

type ConnectorToolIngestContext = {
  serverId: string;
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
};

let memoryService: MemoryService | null = null;

export function bindConnectorMemoryService(service: MemoryService | null): void {
  memoryService = service;
}

function extractTextResult(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const text = (item as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function parseJsonText<T>(text: string): T | null {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function toConnectorId(serverName: string): ConnectorId | null {
  const lowered = serverName.trim().toLowerCase();
  if (lowered === 'slack') return 'slack';
  if (lowered === 'gmail') return 'gmail';
  if (lowered === 'google drive') return 'google-drive';
  return null;
}

export async function maybeIngestConnectorToolResult(
  context: ConnectorToolIngestContext
): Promise<void> {
  if (!memoryService) {
    return;
  }
  const connectorId = toConnectorId(context.serverName);
  if (!connectorId) {
    return;
  }

  const rawText = extractTextResult(context.result);
  const payload = parseJsonText<Record<string, unknown>>(rawText);
  if (!payload || payload.ingest === false) {
    return;
  }

  const title = typeof payload.memoryTitle === 'string' ? payload.memoryTitle : null;
  const summary = typeof payload.memorySummary === 'string' ? payload.memorySummary : null;
  const body = typeof payload.memoryBody === 'string' ? payload.memoryBody : null;
  const externalId = typeof payload.externalId === 'string' ? payload.externalId : null;
  if (!title || !summary || !body || !externalId) {
    return;
  }

  try {
    await memoryService.ingestConnectorArtifact({
      connectorId,
      externalId,
      title,
      summary,
      content: body,
      occurredAt:
        typeof payload.occurredAt === 'number' && Number.isFinite(payload.occurredAt)
          ? payload.occurredAt
          : Date.now(),
      keywords: Array.isArray(payload.keywords)
        ? payload.keywords.filter((value): value is string => typeof value === 'string')
        : [],
      coreKey:
        typeof payload.coreKey === 'string' && payload.coreKey.trim() ? payload.coreKey : undefined,
      coreValue:
        typeof payload.coreValue === 'string' && payload.coreValue.trim()
          ? payload.coreValue
          : undefined,
    });
  } catch (error) {
    logWarn('[ConnectorMemory] Failed to ingest connector tool result', {
      connectorId,
      toolName: context.toolName,
      error,
    });
  }
}
