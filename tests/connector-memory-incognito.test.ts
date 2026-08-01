import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../src/main/utils/logger', async () => {
  const { AsyncLocalStorage: ALS } = await import('async_hooks');
  const logStorage = new ALS<{ sessionId?: string; incognito?: boolean }>();
  return {
    logStorage,
    logWarn: vi.fn(),
    log: vi.fn(),
    logError: vi.fn(),
  };
});

import { logStorage } from '../src/main/utils/logger';
import {
  bindConnectorMemoryService,
  maybeIngestConnectorToolResult,
} from '../src/main/connectors/connector-memory';

describe('maybeIngestConnectorToolResult incognito gate', () => {
  const ingestConnectorArtifact = vi.fn();

  beforeEach(() => {
    ingestConnectorArtifact.mockReset();
    bindConnectorMemoryService({
      ingestConnectorArtifact,
    } as never);
  });

  it('skips ingest when log context is incognito', async () => {
    await logStorage.run({ sessionId: 's1', incognito: true }, async () => {
      await maybeIngestConnectorToolResult({
        serverId: 'slack',
        serverName: 'Slack',
        toolName: 'slack_search',
        args: {},
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                memoryTitle: 't',
                memorySummary: 's',
                memoryBody: 'b',
                externalId: 'e1',
              }),
            },
          ],
        },
      });
    });

    expect(ingestConnectorArtifact).not.toHaveBeenCalled();
  });

  it('ingests when not incognito', async () => {
    await logStorage.run({ sessionId: 's1', incognito: false }, async () => {
      await maybeIngestConnectorToolResult({
        serverId: 'slack',
        serverName: 'Slack',
        toolName: 'slack_search',
        args: {},
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                memoryTitle: 't',
                memorySummary: 's',
                memoryBody: 'b',
                externalId: 'e1',
              }),
            },
          ],
        },
      });
    });

    expect(ingestConnectorArtifact).toHaveBeenCalledTimes(1);
  });
});
