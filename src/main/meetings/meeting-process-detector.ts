/**
 * @deprecated Prefer meeting-mic-detector. Kept as a thin re-export for older imports.
 */
export { detectMeetingApps, detectZoomMicUsage, type ZoomMicUsage } from './meeting-mic-detector';

import { detectZoomMicUsage } from './meeting-mic-detector';

/** @deprecated Use detectZoomMicUsage — process heuristics were replaced by mic probe. */
export async function detectZoom(): Promise<{
  appRunning: boolean;
  inMeeting: boolean;
}> {
  const usage = await detectZoomMicUsage();
  return {
    appRunning: usage.zoomUsingMic,
    inMeeting: usage.zoomUsingMic,
  };
}
