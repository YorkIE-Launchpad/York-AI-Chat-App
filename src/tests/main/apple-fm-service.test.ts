import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';
import {
  ensureAppleLlmServer,
  getAppleLlmStatus,
  listAppleLlmModels,
  parseFmAvailability,
  parseFmLicenseAgreed,
  resetAppleLlmStateForTests,
  type AppleFmDeps,
} from '../../main/apple-llm/apple-fm-service';

function deps(overrides: Partial<AppleFmDeps> = {}): AppleFmDeps {
  return {
    platform: 'darwin',
    helperPath: null, // force the fm fallback unless a test opts into the helper
    fmBinaryExists: () => true,
    runFm: vi.fn(async (args: string[]) => {
      if (args[0] === 'license') return { stdout: 'Agreed.', stderr: '', code: 0 };
      return { stdout: 'System model available', stderr: '', code: 0 };
    }),
    probeServer: vi.fn(async () => false),
    spawnServer: vi.fn(() => ({ on: vi.fn(), killed: false }) as unknown as ChildProcess),
    ...overrides,
  };
}

function helperDeps(overrides: Partial<AppleFmDeps> = {}): AppleFmDeps {
  return deps({
    helperPath: '/fake/bin/york-apple-llm',
    runHelper: vi.fn(async () => ({
      stdout: '{"available":true,"reason":null,"message":null}',
      stderr: '',
      code: 0,
    })),
    ...overrides,
  });
}

afterEach(() => {
  resetAppleLlmStateForTests();
  vi.restoreAllMocks();
});

describe('parseFmLicenseAgreed', () => {
  it('parses agreed / not agreed / unknown', () => {
    expect(parseFmLicenseAgreed("Not agreed. Run 'sudo fm license'")).toBe(false);
    expect(parseFmLicenseAgreed('Agreed to version 1')).toBe(true);
    expect(parseFmLicenseAgreed('something else')).toBeNull();
  });
});

describe('parseFmAvailability', () => {
  it('parses available', () => {
    expect(parseFmAvailability('System model available')).toEqual({ available: true });
  });

  it('parses Apple Intelligence unsupported devices', () => {
    const parsed = parseFmAvailability('This device does not support Apple Intelligence.');
    expect(parsed.available).toBe(false);
    expect(parsed.reason).toBe('apple-intelligence-unavailable');
  });

  it('parses unavailable with a reason', () => {
    const parsed = parseFmAvailability(
      'System model unavailable: Apple Intelligence is not enabled'
    );
    expect(parsed.available).toBe(false);
    expect(parsed.reason).toBe('model-unavailable');
    expect(parsed.message).toContain('Apple Intelligence is not enabled');
  });
});

describe('getAppleLlmStatus', () => {
  it('rejects non-macOS platforms', async () => {
    const status = await getAppleLlmStatus(deps({ platform: 'win32' }));
    expect(status).toMatchObject({ available: false, reason: 'unsupported-platform' });
  });

  it('reports a missing fm binary', async () => {
    const status = await getAppleLlmStatus(deps({ fmBinaryExists: () => false }));
    expect(status).toMatchObject({ available: false, reason: 'fm-missing' });
  });

  it('reports the one-time sudo license gate', async () => {
    const status = await getAppleLlmStatus(
      deps({
        runFm: vi.fn(async () => ({
          stdout: '',
          stderr: "Not agreed. Run 'sudo fm license' to review and agree.",
          code: 1,
        })),
      })
    );
    expect(status.available).toBe(false);
    expect(status.reason).toBe('license-required');
    expect(status.message).toContain('sudo fm license');
  });

  it('reports ready when licensed and available', async () => {
    const status = await getAppleLlmStatus(deps());
    expect(status).toEqual({ available: true, serverRunning: false, backend: 'fm-cli' });
  });

  it('license message points Jamf fleets at IT instead of the employee', async () => {
    const status = await getAppleLlmStatus(
      deps({
        runFm: vi.fn(async () => ({ stdout: 'Not agreed.', stderr: '', code: 1 })),
      })
    );
    expect(status.message).toContain('Jamf');
  });
});

describe('bundled helper backend (no sudo, Jamf-safe)', () => {
  it('prefers the helper and never touches fm or the license', async () => {
    const d = helperDeps();
    const status = await getAppleLlmStatus(d);
    expect(status).toEqual({
      available: true,
      serverRunning: false,
      backend: 'foundation-models-helper',
    });
    expect(d.runFm).not.toHaveBeenCalled();
  });

  it('surfaces helper availability reasons (e.g. Apple Intelligence off)', async () => {
    const status = await getAppleLlmStatus(
      helperDeps({
        runHelper: vi.fn(async () => ({
          stdout:
            '{"available":false,"reason":"apple-intelligence-unavailable","message":"Apple Intelligence is not enabled on this Mac."}',
          stderr: '',
          code: 0,
        })),
      })
    );
    expect(status.available).toBe(false);
    expect(status.reason).toBe('apple-intelligence-unavailable');
    expect(status.message).toContain('not enabled');
  });

  it('falls back to fm when helper output is unparseable', async () => {
    const status = await getAppleLlmStatus(
      helperDeps({
        runHelper: vi.fn(async () => ({ stdout: 'not json', stderr: 'boom', code: 1 })),
      })
    );
    expect(status).toMatchObject({ available: true, backend: 'fm-cli' });
  });

  it('spawns the helper (not fm) when starting the server', async () => {
    let probes = 0;
    const d = helperDeps({
      probeServer: vi.fn(async () => {
        probes += 1;
        return probes >= 3;
      }),
    });
    await expect(ensureAppleLlmServer(d)).resolves.toMatchObject({
      available: true,
      serverRunning: true,
      backend: 'foundation-models-helper',
    });
    expect(d.spawnServer).toHaveBeenCalledWith({
      executable: '/fake/bin/york-apple-llm',
      args: ['serve', '--port', '1976'],
    });
  });
});

describe('listAppleLlmModels', () => {
  it('lists the single system model only when available', async () => {
    await expect(listAppleLlmModels(deps())).resolves.toEqual([
      { id: 'system', name: 'Apple Local LLM (offline)', contextWindow: 4096 },
    ]);
    await expect(listAppleLlmModels(deps({ platform: 'linux' }))).resolves.toEqual([]);
  });
});

describe('ensureAppleLlmServer', () => {
  it('does not spawn when the server is already healthy', async () => {
    const d = deps({ probeServer: vi.fn(async () => true) });
    await expect(ensureAppleLlmServer(d)).resolves.toMatchObject({ serverRunning: true });
    expect(d.spawnServer).not.toHaveBeenCalled();
  });

  it('spawns fm serve and waits for health', async () => {
    let probes = 0;
    const d = deps({
      probeServer: vi.fn(async () => {
        probes += 1;
        return probes >= 3; // status probe + start poll succeed on 2nd poll
      }),
    });
    await expect(ensureAppleLlmServer(d)).resolves.toMatchObject({
      available: true,
      serverRunning: true,
    });
    expect(d.spawnServer).toHaveBeenCalledWith({
      executable: 'fm',
      args: ['serve', '--host', '127.0.0.1', '--port', '1976'],
    });
  });

  it('refuses to spawn when the license has not been agreed', async () => {
    const d = deps({
      runFm: vi.fn(async () => ({ stdout: 'Not agreed.', stderr: '', code: 1 })),
    });
    await expect(ensureAppleLlmServer(d)).rejects.toThrow('sudo fm license');
    expect(d.spawnServer).not.toHaveBeenCalled();
  });
});
