/**
 * Persist generated welcome quick actions per user email.
 */

import Store from 'electron-store';
import type { WelcomeProfile, WelcomeQuickAction } from '../../shared/welcome-actions';

interface WelcomeActionsCacheEntry {
  email: string;
  connectorFingerprint: string;
  chips: WelcomeQuickAction[];
  profile: WelcomeProfile | null;
  updatedAt: number;
}

interface WelcomeActionsStoreSchema {
  byEmail: Record<string, WelcomeActionsCacheEntry>;
}

class WelcomeActionsStore {
  private store: Store<WelcomeActionsStoreSchema>;

  constructor() {
    this.store = new Store<WelcomeActionsStoreSchema>({
      name: 'welcome-actions',
      defaults: { byEmail: {} },
    });
  }

  get(email: string): WelcomeActionsCacheEntry | null {
    const key = email.trim().toLowerCase();
    if (!key) return null;
    const byEmail = this.store.get('byEmail') || {};
    return byEmail[key] ?? null;
  }

  set(entry: WelcomeActionsCacheEntry): void {
    const key = entry.email.trim().toLowerCase();
    if (!key) return;
    const byEmail = { ...(this.store.get('byEmail') || {}) };
    byEmail[key] = { ...entry, email: key };
    this.store.set('byEmail', byEmail);
  }

  clear(email?: string): void {
    if (!email) {
      this.store.set('byEmail', {});
      return;
    }
    const key = email.trim().toLowerCase();
    const byEmail = { ...(this.store.get('byEmail') || {}) };
    delete byEmail[key];
    this.store.set('byEmail', byEmail);
  }
}

export const welcomeActionsStore = new WelcomeActionsStore();
