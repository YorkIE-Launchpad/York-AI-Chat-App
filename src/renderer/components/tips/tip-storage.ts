export function isTipSeen(storageKey: string, defaultSeen = false): boolean {
  try {
    const value = localStorage.getItem(storageKey);
    return value === null ? defaultSeen : value === '1';
  } catch {
    return true;
  }
}

export function markTipSeen(storageKey: string): void {
  try {
    localStorage.setItem(storageKey, '1');
  } catch {
    // ignore quota / private mode
  }
}
