import { describe, expect, it } from 'vitest';
import { isImageInputUnsupportedError } from '../../shared/screen-snap';

describe('isImageInputUnsupportedError', () => {
  it.each([
    '500 image input is not supported - hint: if this is unexpected, you may need to provide the mmproj',
    '**Error**: 500 image input is not supported',
    'This model does not support image input',
    'No endpoints found that support image input',
    'Images are not supported by this model',
    "model doesn't support images",
  ])('matches %s', (message) => {
    expect(isImageInputUnsupportedError(message)).toBe(true);
  });

  it.each([null, undefined, '', '429 rate limit exceeded', 'No model is configured'])(
    'ignores %s',
    (message) => {
      expect(isImageInputUnsupportedError(message)).toBe(false);
    }
  );
});
