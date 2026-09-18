import { describe, expect, it } from 'vitest';
import {
  isMacOs26OrNewer,
  parseAppleHelperEventLine,
} from '../../main/meetings/apple-meeting-transcription-service';

describe('parseAppleHelperEventLine', () => {
  it('parses ready', () => {
    expect(parseAppleHelperEventLine('{"type":"ready"}')).toEqual({ type: 'ready' });
  });

  it('parses partial and final', () => {
    expect(
      parseAppleHelperEventLine(
        '{"type":"partial","itemId":"p1","text":"hello"}'
      )
    ).toEqual({ type: 'partial', itemId: 'p1', text: 'hello' });

    expect(
      parseAppleHelperEventLine('{"type":"final","itemId":"f1","text":"done."}')
    ).toEqual({ type: 'final', itemId: 'f1', text: 'done.' });
  });

  it('parses error', () => {
    expect(parseAppleHelperEventLine('{"type":"error","message":"nope"}')).toEqual({
      type: 'error',
      message: 'nope',
    });
  });

  it('ignores invalid lines', () => {
    expect(parseAppleHelperEventLine('not json')).toBeNull();
    expect(parseAppleHelperEventLine('{"type":"partial","text":""}')).toBeNull();
  });
});

describe('isMacOs26OrNewer', () => {
  it('accepts macOS 26 and 27 marketing versions', () => {
    expect(isMacOs26OrNewer('26.0')).toBe(true);
    expect(isMacOs26OrNewer('26.1.2')).toBe(true);
    expect(isMacOs26OrNewer('27.0')).toBe(true);
  });

  it('accepts Tahoe compat major 16', () => {
    expect(isMacOs26OrNewer('16.0')).toBe(true);
    expect(isMacOs26OrNewer('16.0.0')).toBe(true);
  });

  it('rejects older macOS majors', () => {
    expect(isMacOs26OrNewer('15.6')).toBe(false);
    expect(isMacOs26OrNewer('14.0')).toBe(false);
  });
});
