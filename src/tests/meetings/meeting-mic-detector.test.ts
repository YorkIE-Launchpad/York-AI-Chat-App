import { describe, expect, it } from 'vitest';
import {
  filterZoomMicUsage,
  isZoomMicProcess,
  parseMicProbeJson,
  type MicProbeResult,
} from '../../main/meetings/meeting-mic-detector';

describe('meeting-mic-detector', () => {
  it('parses probe JSON', () => {
    const parsed = parseMicProbeJson(
      JSON.stringify({
        active: true,
        mode: 'process',
        deviceRunningSomewhere: true,
        processes: [
          { pid: 42, bundleId: 'us.zoom.xos', name: 'zoom.us', path: '/Applications/zoom.us.app' },
        ],
      })
    );
    expect(parsed.active).toBe(true);
    expect(parsed.mode).toBe('process');
    expect(parsed.processes).toHaveLength(1);
    expect(parsed.processes[0].pid).toBe(42);
    expect(parsed.processes[0].bundleId).toBe('us.zoom.xos');
  });

  it('matches Zoom by bundle id, name, and path', () => {
    expect(isZoomMicProcess({ pid: 1, bundleId: 'us.zoom.xos' })).toBe(true);
    expect(isZoomMicProcess({ pid: 1, bundleId: 'us.zoom.ZoomPresence' })).toBe(true);
    expect(isZoomMicProcess({ pid: 1, name: 'zoom.us' })).toBe(true);
    expect(isZoomMicProcess({ pid: 1, name: 'CptHost' })).toBe(true);
    expect(
      isZoomMicProcess({
        pid: 1,
        path: '/Applications/zoom.us.app/Contents/Frameworks/CptHost.app',
      })
    ).toBe(true);
    expect(isZoomMicProcess({ pid: 1, bundleId: 'com.apple.Safari', name: 'Safari' })).toBe(false);
  });

  it('filters self PIDs and detects Zoom mic usage', () => {
    const probe: MicProbeResult = {
      active: true,
      mode: 'process',
      deviceRunningSomewhere: true,
      processes: [
        { pid: 111, bundleId: 'com.yorkie.app', name: 'York IE VECOS' },
        { pid: 222, bundleId: 'us.zoom.xos', name: 'zoom.us' },
      ],
    };
    const usage = filterZoomMicUsage(probe, new Set([111]));
    expect(usage.probeAvailable).toBe(true);
    expect(usage.zoomUsingMic).toBe(true);
    expect(usage.processes).toHaveLength(1);
    expect(usage.processes[0].pid).toBe(222);
  });

  it('does not treat own capture as Zoom', () => {
    const probe: MicProbeResult = {
      active: true,
      mode: 'process',
      deviceRunningSomewhere: true,
      processes: [{ pid: 999, bundleId: 'com.yorkie.app', name: 'Electron' }],
    };
    const usage = filterZoomMicUsage(probe, new Set([999]));
    expect(usage.zoomUsingMic).toBe(false);
    expect(usage.processes).toHaveLength(0);
  });
});
