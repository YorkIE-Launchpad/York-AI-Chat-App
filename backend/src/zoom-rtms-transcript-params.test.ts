import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyZoomRtmsTranscriptParams, ZOOM_RTMS_TRANSCRIPT_PARAMS } from './zoom-routes.js';

describe('zoom RTMS transcript language params', () => {
  it('exports English primary + LID enabled', () => {
    assert.equal(ZOOM_RTMS_TRANSCRIPT_PARAMS.srcLanguage, 9);
    assert.equal(ZOOM_RTMS_TRANSCRIPT_PARAMS.enableLid, true);
  });

  it('applyZoomRtmsTranscriptParams calls setTranscriptParams', () => {
    const calls: Array<{ srcLanguage: number; enableLid: boolean }> = [];
    applyZoomRtmsTranscriptParams({
      setTranscriptParams: (params) => {
        calls.push(params);
      },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      srcLanguage: 9,
      enableLid: true,
    });
  });

  it('applyZoomRtmsTranscriptParams no-ops when method missing', () => {
    assert.doesNotThrow(() => applyZoomRtmsTranscriptParams({}));
  });
});
