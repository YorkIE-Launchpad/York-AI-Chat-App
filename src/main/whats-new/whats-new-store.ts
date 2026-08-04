/**
 * Persist last-seen app version for What's New modal.
 * Plain electron-store (no secrets).
 */

import Store from 'electron-store';

export interface WhatsNewStoreSchema {
  lastSeenVersion?: string;
}

export class WhatsNewStore {
  private store: Store<WhatsNewStoreSchema>;

  constructor(store?: Store<WhatsNewStoreSchema>) {
    this.store =
      store ??
      new Store<WhatsNewStoreSchema>({
        name: 'whats-new',
        defaults: {},
      });
  }

  getLastSeenVersion(): string | undefined {
    const value = this.store.get('lastSeenVersion');
    if (typeof value !== 'string' || !value.trim()) return undefined;
    return value.trim();
  }

  setLastSeenVersion(version: string): void {
    const trimmed = version.trim();
    if (!trimmed) return;
    this.store.set('lastSeenVersion', trimmed);
  }
}

export const whatsNewStore = new WhatsNewStore();
