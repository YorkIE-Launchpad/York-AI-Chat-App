/**
 * Decide whether to show What's New and load combined release notes.
 */

import type { WhatsNewPayload } from '../../shared/whats-new-types';
import {
  collectReleaseNotes,
  compareSemver,
  normalizeVersion,
  type FetchReleaseNotesText,
} from './release-notes';
import { whatsNewStore, type WhatsNewStore } from './whats-new-store';

const FETCH_TIMEOUT_MS = 10_000;

export async function defaultFetchReleaseNotesText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'text/markdown, text/plain, */*' },
    });
    if (!response.ok) return null;
    const text = await response.text();
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

export interface WhatsNewServiceDeps {
  store?: WhatsNewStore;
  fetchText?: FetchReleaseNotesText;
}

/**
 * Returns a pending What's New payload after an upgrade, or null.
 * First launch / migration seeds lastSeen to current without showing the modal.
 * Fetch failure or empty filtered notes advance lastSeen so the user is not nagged.
 */
export async function getPendingWhatsNew(
  currentVersion: string,
  deps: WhatsNewServiceDeps = {}
): Promise<WhatsNewPayload | null> {
  const store = deps.store ?? whatsNewStore;
  const fetchText = deps.fetchText ?? defaultFetchReleaseNotesText;

  const current = normalizeVersion(currentVersion);
  if (!current || current === 'unknown') return null;

  const lastSeenRaw = store.getLastSeenVersion();
  if (!lastSeenRaw) {
    store.setLastSeenVersion(current);
    return null;
  }

  const lastSeen = normalizeVersion(lastSeenRaw);
  if (!lastSeen) {
    store.setLastSeenVersion(current);
    return null;
  }

  if (compareSemver(lastSeen, current) >= 0) {
    return null;
  }

  const collected = await collectReleaseNotes({
    fromExclusive: lastSeen,
    toInclusive: current,
    fetchText,
  });

  if (!collected) {
    store.setLastSeenVersion(current);
    return null;
  }

  return {
    fromVersion: lastSeen,
    toVersion: current,
    markdown: collected.markdown,
  };
}

/** Mark the given version as seen (typically current app version on dismiss). */
export function markWhatsNewSeen(version: string, deps: WhatsNewServiceDeps = {}): void {
  const store = deps.store ?? whatsNewStore;
  const normalized = normalizeVersion(version);
  if (!normalized || normalized === 'unknown') return;
  store.setLastSeenVersion(normalized);
}
