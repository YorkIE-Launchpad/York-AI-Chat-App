export function isTipSeen(storageKey: string): boolean {
  try {
    return localStorage.getItem(storageKey) === '1';
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
