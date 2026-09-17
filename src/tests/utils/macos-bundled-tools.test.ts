import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const existsMock = vi.fn();

vi.mock('electron', () => ({
  app: { isPackaged: true },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) => existsMock(...args),
  };
});

describe('resolveMeetingSpeechTranscriberPath (packaged layout)', () => {
  afterEach(() => {
    existsMock.mockReset();
    vi.resetModules();
  });

  it('finds helper under Contents/Resources/tools/York GrowthOS.app', async () => {
    const resourcesPath = '/Applications/York GrowthOS.app/Contents/Resources';
    const helperExec = path.join(
      resourcesPath,
      'tools',
      'York GrowthOS.app',
      'Contents',
      'MacOS',
      'meeting-speech-transcriber'
    );

    existsMock.mockImplementation((candidate: string) => candidate === helperExec);

    Object.defineProperty(process, 'resourcesPath', {
      value: resourcesPath,
      configurable: true,
    });

    const { resolveMeetingSpeechTranscriberPath } =
      await import('../../main/meetings/apple-meeting-transcription-service');

    expect(resolveMeetingSpeechTranscriberPath()).toBe(helperExec);
  });
});
