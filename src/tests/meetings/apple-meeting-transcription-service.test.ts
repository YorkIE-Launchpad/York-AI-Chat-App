import { describe, expect, it } from 'vitest';
import { parseAppleHelperEventLine } from '../../main/meetings/apple-meeting-transcription-service';

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
