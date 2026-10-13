import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TIPS } from '../../renderer/components/tips/registry';
import { TIP_CATEGORIES } from '../../renderer/components/tips/types';
import { isTipSeen, markTipSeen } from '../../renderer/components/tips/tip-storage';

const TIPS_DIR = resolve(__dirname, '../../renderer/components/tips');
const en = JSON.parse(
  readFileSync(resolve(__dirname, '../../renderer/i18n/locales/en.json'), 'utf8')
) as Record<string, unknown>;

function hasKey(key: string): boolean {
  let node: unknown = en;
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return false;
    const obj = node as Record<string, unknown>;
    // i18next plurals: `needYou` resolves via `needYou_one` / `needYou_other`.
    node = part in obj ? obj[part] : obj[`${part}_other`];
  }
  return typeof node === 'string';
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

describe('tips registry', () => {
  it('has unique ids and storage keys', () => {
    expect(new Set(TIPS.map((tip) => tip.id)).size).toBe(TIPS.length);
    expect(new Set(TIPS.map((tip) => tip.storageKey)).size).toBe(TIPS.length);
  });

  it('only auto-shows the snap wiggle tip on launch', () => {
    expect(TIPS.filter((tip) => !tip.defaultSeen).map((tip) => tip.id)).toEqual(['snap-wiggle']);
  });

  it('uses known categories with labels', () => {
    for (const tip of TIPS) expect(TIP_CATEGORIES).toContain(tip.category);
    for (const category of TIP_CATEGORIES) expect(hasKey(`tips.categories.${category}`)).toBe(true);
  });

  it('has title and summary strings for every tip', () => {
    for (const tip of TIPS) {
      expect(hasKey(tip.titleKey), tip.titleKey).toBe(true);
      expect(hasKey(tip.summaryKey), tip.summaryKey).toBe(true);
    }
  });

  it('has every literal i18n key used by tip components', () => {
    const files = listFiles(TIPS_DIR).filter((file) => file.endsWith('.tsx'));
    const keys = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([\w.]+)'/g)].map((match) => match[1])
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((key) => !hasKey(key))).toEqual([]);
  });
});

describe('tip storage', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to defaultSeen until the tip is marked seen', () => {
    expect(isTipSeen('tip-a')).toBe(false);
    expect(isTipSeen('tip-b', true)).toBe(true);
    markTipSeen('tip-a');
    expect(isTipSeen('tip-a')).toBe(true);
  });
});
