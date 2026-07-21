import Store from 'electron-store';
import { log, logWarn } from '../utils/logger';
import {
  createEncryptedStoreWithKeyRotation,
  getLegacyDerivedKeyHexes,
} from '../utils/store-encryption';

export interface PersistedAuthRecord {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  userJson: string;
}

type AuthStoreRecord = PersistedAuthRecord & Record<string, unknown>;

class AuthStore {
  private store: Store<AuthStoreRecord>;

  constructor() {
    this.store = createEncryptedStoreWithKeyRotation<AuthStoreRecord>({
      stableKey: 'york-ie-auth-stable-v1',
      legacyKeys: [
        'york-ie-auth-v1',
        ...getLegacyDerivedKeyHexes({
          moduleDirname: __dirname,
          stableSeed: 'york-ie-auth-stable-v1',
          legacySeed: 'york-ie-auth-v1',
          salt: 'york-ie-auth-salt',
        }),
      ],
      storeOptions: {
        name: 'auth-session',
        projectName: 'york-ie',
        defaults: {
          idToken: '',
          accessToken: '',
          refreshToken: '',
          userJson: '',
        },
      },
      logPrefix: '[AuthStore]',
      log,
      warn: logWarn,
    }) as unknown as Store<AuthStoreRecord>;
  }

  load(): PersistedAuthRecord | null {
    const idToken = this.store.get('idToken');
    const accessToken = this.store.get('accessToken');
    const refreshToken = this.store.get('refreshToken');
    const userJson = this.store.get('userJson');
    if (!idToken || !userJson) return null;
    return { idToken, accessToken, refreshToken, userJson };
  }

  save(record: PersistedAuthRecord): void {
    this.store.set('idToken', record.idToken);
    this.store.set('accessToken', record.accessToken);
    this.store.set('refreshToken', record.refreshToken);
    this.store.set('userJson', record.userJson);
  }

  clear(): void {
    this.store.clear();
  }
}

export const authStore = new AuthStore();
