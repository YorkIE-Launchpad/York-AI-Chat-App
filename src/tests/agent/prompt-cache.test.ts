import { describe, expect, it } from 'vitest';
import { enableLongAnthropicPromptCache } from '../../main/agent/prompt-cache';

describe('prompt-cache helpers', () => {
  it('sets PI_CACHE_RETENTION=long unless explicitly none', () => {
    const prev = process.env.PI_CACHE_RETENTION;
    delete process.env.PI_CACHE_RETENTION;
    enableLongAnthropicPromptCache();
    expect(process.env.PI_CACHE_RETENTION).toBe('long');

    process.env.PI_CACHE_RETENTION = 'none';
    enableLongAnthropicPromptCache();
    expect(process.env.PI_CACHE_RETENTION).toBe('none');

    if (prev === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = prev;
  });
});
