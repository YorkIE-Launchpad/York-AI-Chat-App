import { describe, expect, it, vi } from 'vitest';
import { shell } from 'electron';
import { openOAuthInExternalBrowser } from '../src/main/auth/oauth-external-browser';

describe('openOAuthInExternalBrowser', () => {
  it('opens the authorize URL in the default browser (existing Chrome window)', async () => {
    const openExternal = vi.spyOn(shell, 'openExternal').mockResolvedValue(undefined);
    await openOAuthInExternalBrowser('https://auth.example.com/authorize?client_id=abc');
    expect(openExternal).toHaveBeenCalledWith('https://auth.example.com/authorize?client_id=abc');
  });

  it('rejects non-http(s) URLs without opening a browser', async () => {
    const openExternal = vi.spyOn(shell, 'openExternal').mockResolvedValue(undefined);
    await expect(openOAuthInExternalBrowser('file:///etc/passwd')).rejects.toThrow(
      'unsupported protocol'
    );
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects malformed URLs without opening a browser', async () => {
    const openExternal = vi.spyOn(shell, 'openExternal').mockResolvedValue(undefined);
    await expect(openOAuthInExternalBrowser('not a url')).rejects.toThrow(
      'Invalid OAuth authorization URL'
    );
    expect(openExternal).not.toHaveBeenCalled();
  });
});
