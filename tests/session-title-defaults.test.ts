import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_TITLE,
  getDefaultTitleFromPrompt,
  getInitialSessionTitle,
  isEchoTitle,
  succinctTitleFromPrompt,
} from '../src/shared/session-title';

describe('session title defaults', () => {
  it('uses a short topic phrase as the initial session title', () => {
    expect(getInitialSessionTitle("Help me organize this week's work plan and todos")).toBe(
      "Organize This Week's Work Plan"
    );
  });

  it('turns first-message chatter into a findable title', () => {
    expect(succinctTitleFromPrompt('hello check my api key')).toBe('Check My API Key');
    expect(succinctTitleFromPrompt('hi is this a paid model in growthos')).toBe(
      'Paid Model in Growthos'
    );
    expect(succinctTitleFromPrompt('what is my usage limit for the free plan')).toBe(
      'Usage Limit for the Free Plan'
    );
    expect(succinctTitleFromPrompt('If i wanted to create a skill for timesheets')).toBe(
      'Create a Skill for Timesheets'
    );
    expect(succinctTitleFromPrompt('help me convert ET to Indian time')).toBe(
      'Convert ET to Indian Time'
    );
  });

  it('treats a copied user sentence as an echo and keeps a rewritten topic', () => {
    expect(isEchoTitle('hello check my api key', 'hello check my api key')).toBe(true);
    expect(isEchoTitle('hello check my api key', 'API Key Check')).toBe(false);
    expect(
      isEchoTitle(
        'Convert ET to Indian time for the standup',
        'Convert ET to Indian time for the standup'
      )
    ).toBe(true);
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
