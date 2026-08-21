import { describe, expect, it } from 'vitest';

/**
 * Mirror of normalizeTokenUsage from agent-runner (kept local so we don't
 * pull Electron deps into the unit test). Keep in sync with the main helper.
 */
function normalizeTokenUsage(usage: unknown):
  | { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  | undefined {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  const raw = usage as Record<string, unknown>;
  const input = raw.input ?? raw.input_tokens ?? raw.inputTokens;
  const output = raw.output ?? raw.output_tokens ?? raw.outputTokens;
  if (typeof input !== 'number' || typeof output !== 'number') {
    return undefined;
  }

  const cacheRead =
    typeof raw.cacheRead === 'number'
      ? raw.cacheRead
      : typeof raw.cache_read === 'number'
        ? raw.cache_read
        : typeof raw.cache_read_input_tokens === 'number'
          ? raw.cache_read_input_tokens
          : undefined;
  const cacheWrite =
    typeof raw.cacheWrite === 'number'
      ? raw.cacheWrite
      : typeof raw.cache_write === 'number'
        ? raw.cache_write
        : typeof raw.cache_creation_input_tokens === 'number'
          ? raw.cache_creation_input_tokens
          : undefined;

  const result: { input: number; output: number; cacheRead?: number; cacheWrite?: number } = {
    input,
    output,
  };
  if (typeof cacheRead === 'number' && Number.isFinite(cacheRead)) result.cacheRead = cacheRead;
  if (typeof cacheWrite === 'number' && Number.isFinite(cacheWrite)) result.cacheWrite = cacheWrite;
  return result;
}

describe('normalizeTokenUsage cache fields', () => {
  it('preserves pi-ai cacheRead/cacheWrite', () => {
    expect(
      normalizeTokenUsage({
        input: 1000,
        output: 50,
        cacheRead: 800,
        cacheWrite: 200,
      })
    ).toEqual({ input: 1000, output: 50, cacheRead: 800, cacheWrite: 200 });
  });

  it('maps Anthropic snake_case cache fields', () => {
    expect(
      normalizeTokenUsage({
        input_tokens: 1000,
        output_tokens: 50,
        cache_read_input_tokens: 700,
        cache_creation_input_tokens: 100,
      })
    ).toEqual({ input: 1000, output: 50, cacheRead: 700, cacheWrite: 100 });
  });
});
