import Store from 'electron-store';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { log, logWarn } from '../utils/logger';
import {
  createEncryptedStoreWithKeyRotation,
  getLegacyDerivedKeyHexes,
} from '../utils/store-encryption';

export interface PersistedMcpOAuthRecord {
  serverUrl: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  redirectUrl?: string;
}

type McpOAuthStoreSchema = {
  records: Record<string, PersistedMcpOAuthRecord>;
};

class McpOAuthStore {
  private store: Store<McpOAuthStoreSchema>;

  constructor() {
    this.store = createEncryptedStoreWithKeyRotation<McpOAuthStoreSchema & Record<string, unknown>>(
      {
        stableKey: 'york-ie-mcp-oauth-stable-v1',
        legacyKeys: [
          'york-ie-mcp-oauth-v1',
          ...getLegacyDerivedKeyHexes({
            moduleDirname: __dirname,
            stableSeed: 'york-ie-mcp-oauth-stable-v1',
            legacySeed: 'york-ie-mcp-oauth-v1',
            salt: 'york-ie-mcp-oauth-salt',
          }),
        ],
        storeOptions: {
          name: 'mcp-oauth',
          projectName: 'york-ie',
          defaults: {
            records: {},
          },
        },
        logPrefix: '[McpOAuthStore]',
        log,
        warn: logWarn,
      }
    ) as unknown as Store<McpOAuthStoreSchema>;
  }

  load(serverId: string, expectedServerUrl: string): PersistedMcpOAuthRecord | null {
    const records = this.store.get('records');
    const record = records[serverId];
    if (!record) {
      return null;
    }

    if (record.serverUrl !== expectedServerUrl) {
      logWarn(
        `[McpOAuthStore] Stored OAuth credentials for ${serverId} target a different server URL; clearing`
      );
      this.clear(serverId);
      return null;
    }

    return record;
  }

  save(serverId: string, record: PersistedMcpOAuthRecord): void {
    const records = { ...this.store.get('records'), [serverId]: record };
    this.store.set('records', records);
  }

  clear(serverId: string): void {
    const records = { ...this.store.get('records') };
    delete records[serverId];
    this.store.set('records', records);
  }
}

export const mcpOAuthStore = new McpOAuthStore();
