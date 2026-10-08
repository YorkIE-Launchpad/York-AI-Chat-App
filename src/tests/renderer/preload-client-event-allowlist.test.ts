/**
 * Every ClientEvent the renderer sends via `send({ type })` must be in the preload
 * allowlist — otherwise preload drops it silently (e.g. AskUserQuestion answers
 * never reach main and the tool times out into the recommended option).
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function readAllowlist(): Set<string> {
  const source = readFileSync(join(ROOT, 'preload', 'index.ts'), 'utf8');
  const match = source.match(/const ALLOWED_CLIENT_EVENTS[^=]*=\s*new Set[^[]*\[([\s\S]*?)\]\)/);
  if (!match) {
    throw new Error('ALLOWED_CLIENT_EVENTS not found in preload');
  }
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

function collectRendererSentTypes(): Set<string> {
  const types = new Set<string>();
  for (const file of listSourceFiles(join(ROOT, 'renderer'))) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/\bsend\(\{\s*type:\s*'([^']+)'/g)) {
      types.add(m[1]);
    }
  }
  return types;
}

describe('preload ClientEvent allowlist', () => {
  it('allows question.response so AskUserQuestion answers reach main', () => {
    expect(readAllowlist().has('question.response')).toBe(true);
  });

  it('allows every event type the renderer sends', () => {
    const allowlist = readAllowlist();
    const sent = collectRendererSentTypes();
    expect(sent.size).toBeGreaterThan(0);
    const missing = [...sent].filter((type) => !allowlist.has(type));
    expect(missing).toEqual([]);
  });
});
