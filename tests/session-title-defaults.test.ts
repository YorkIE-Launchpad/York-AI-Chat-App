import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_TITLE,
  getDefaultTitleFromPrompt,
  getInitialSessionTitle,
} from '../src/shared/session-title';

describe('session title defaults', () => {
  it('uses truncated prompt text as the initial session title', () => {
    expect(getInitialSessionTitle("Help me organize this week's work plan and todos")).toBe(
      "Help me organize this week's work plan and todos"
    );
  });

  it('falls back to the first attachment name when prompt text is empty', () => {
    expect(getInitialSessionTitle('', 'Quarterly Summary-Final.pptx')).toBe(
      'Quarterly Summary-Final.pptx'
    );
  });

  it('uses the shared default title when neither prompt nor attachment name is available', () => {
    expect(getInitialSessionTitle('', '')).toBe(DEFAULT_SESSION_TITLE);
    expect(getDefaultTitleFromPrompt('')).toBe(DEFAULT_SESSION_TITLE);
  });
});
