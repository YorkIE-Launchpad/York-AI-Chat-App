import Store from 'electron-store';
import { log, logWarn } from '../utils/logger';
import {
  createEncryptedStoreWithKeyRotation,
  getLegacyDerivedKeyHexes,
} from '../utils/store-encryption';
import type { ConnectorId, ConnectorTokenRecord } from './connector-types';

type ConnectorTokenStoreSchema = {
  records: Partial<Record<ConnectorId, ConnectorTokenRecord>>;
};

class ConnectorTokenStore {
  private store: Store<ConnectorTokenStoreSchema>;

  constructor() {
    this.store = createEncryptedStoreWithKeyRotation<
      ConnectorTokenStoreSchema & Record<string, unknown>
    >({
      stableKey: 'york-ie-connectors-stable-v1',
      legacyKeys: [
        'york-ie-connectors-v1',
        ...getLegacyDerivedKeyHexes({
          moduleDirname: __dirname,
          stableSeed: 'york-ie-connectors-stable-v1',
          legacySeed: 'york-ie-connectors-v1',
          salt: 'york-ie-connectors-salt',
        }),
      ],
      storeOptions: {
        name: 'connector-tokens',
        projectName: 'york-ie',
        defaults: {
          records: {},
        },
      },
      logPrefix: '[ConnectorTokenStore]',
      log,
      warn: logWarn,
    }) as unknown as Store<ConnectorTokenStoreSchema>;
  }

  load(connectorId: ConnectorId): ConnectorTokenRecord | null {
    return this.store.get('records')[connectorId] ?? null;
  }

  save(record: ConnectorTokenRecord): void {
    const records = { ...this.store.get('records'), [record.connectorId]: record };
    this.store.set('records', records);
  }

  clear(connectorId: ConnectorId): void {
    const records = { ...this.store.get('records') };
    delete records[connectorId];
    this.store.set('records', records);
  }

  getAll(): Partial<Record<ConnectorId, ConnectorTokenRecord>> {
    return { ...this.store.get('records') };
  }
}

export const connectorTokenStore = new ConnectorTokenStore();
