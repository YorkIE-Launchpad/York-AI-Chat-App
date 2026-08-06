import { describe, it, expect } from 'vitest';
import { isAskGrowthOSHotkey } from '../../renderer/utils/ask-growthos-hotkey';

function makeKeyEvent(partial: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    key: partial.key,
    code: partial.code ?? (partial.key === ' ' ? 'Space' : partial.key),
    shiftKey: partial.shiftKey ?? false,
    metaKey: partial.metaKey ?? false,
    ctrlKey: partial.ctrlKey ?? false,
    altKey: partial.altKey ?? false,
    repeat: partial.repeat ?? false,
  } as KeyboardEvent;
}

describe('isAskGrowthOSHotkey', () => {
  it('matches Cmd+Shift+Space', () => {
    expect(
      isAskGrowthOSHotkey(makeKeyEvent({ key: ' ', code: 'Space', shiftKey: true, metaKey: true }))
    ).toBe(true);
  });

  it('matches Ctrl+Shift+Space', () => {
    expect(
      isAskGrowthOSHotkey(makeKeyEvent({ key: ' ', code: 'Space', shiftKey: true, ctrlKey: true }))
    ).toBe(true);
  });

  it('rejects plain Space (typing must still insert spaces)', () => {
    expect(isAskGrowthOSHotkey(makeKeyEvent({ key: ' ', code: 'Space' }))).toBe(false);
  });

  it('rejects Shift+Space without Cmd/Ctrl', () => {
    expect(isAskGrowthOSHotkey(makeKeyEvent({ key: ' ', code: 'Space', shiftKey: true }))).toBe(
      false
    );
  });

  it('rejects Cmd+Space without Shift', () => {
    expect(isAskGrowthOSHotkey(makeKeyEvent({ key: ' ', code: 'Space', metaKey: true }))).toBe(
      false
    );
  });

  it('rejects key-repeat events', () => {
    expect(
      isAskGrowthOSHotkey(
        makeKeyEvent({ key: ' ', code: 'Space', shiftKey: true, metaKey: true, repeat: true })
      )
    ).toBe(false);
  });
});
