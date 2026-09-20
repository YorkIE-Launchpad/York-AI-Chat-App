import { describe, expect, it } from 'vitest';
import {
  isDoubleExtensionLeaf,
  sharedDocFileName,
  titleBaseFromPathOrTitle,
} from '../src/shared/shared-docs/filename';

describe('shared doc filenames', () => {
  it('strips extension from title before adding kind extension', () => {
    expect(sharedDocFileName('hi.html', 'html')).toBe('hi.html');
    expect(sharedDocFileName('/workspace/hi.html', 'html')).toBe('hi.html');
    expect(sharedDocFileName('notes.md', 'markdown')).toBe('notes.md');
  });

  it('detects double-extension leaves', () => {
    expect(isDoubleExtensionLeaf('hi.html.html')).toBe(true);
    expect(isDoubleExtensionLeaf('hi.html')).toBe(false);
  });

  it('titleBaseFromPathOrTitle handles paths', () => {
    expect(titleBaseFromPathOrTitle('foo/bar/baz.html')).toBe('baz');
  });
});
