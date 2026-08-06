import { describe, it, expect } from 'vitest';
import {
  buildTitlePrompt,
  isPrimarilyCjkText,
  isTitleLanguageCompatible,
  normalizeGeneratedTitle,
  shouldGenerateTitle,
} from '../src/main/session/session-title-utils';

describe('session title utils', () => {
  it('generates title only for first user message and default title', () => {
    expect(
      shouldGenerateTitle({
        userMessageCount: 1,
        currentTitle: 'Hello world',
        prompt: 'Hello world',
        hasAttempted: false,
      })
    ).toBe(true);

    expect(
      shouldGenerateTitle({
        userMessageCount: 2,
        currentTitle: 'Hello world',
        prompt: 'Hello world',
        hasAttempted: false,
      })
    ).toBe(false);
  });

  it('skips when title was manually changed', () => {
    expect(
      shouldGenerateTitle({
        userMessageCount: 1,
        currentTitle: 'Custom title',
        prompt: 'Hello world',
        hasAttempted: false,
      })
    ).toBe(false);
  });

  it('skips when already attempted', () => {
    expect(
      shouldGenerateTitle({
        userMessageCount: 1,
        currentTitle: 'Hello world',
        prompt: 'Hello world',
        hasAttempted: true,
      })
    ).toBe(false);
  });

  it('builds an English-only title prompt for Latin user requests', () => {
    const prompt = buildTitlePrompt('Help me make a PPT');
    expect(prompt).toContain('English only');
    expect(prompt).toContain('Do not use Chinese');
    expect(prompt).toContain('Help me make a PPT');
    expect(prompt).not.toContain('same language as the user request');
  });

  it('builds a CJK title prompt for Chinese user requests', () => {
    const prompt = buildTitlePrompt('帮我做一个PPT');
    expect(prompt).toContain('same CJK language');
    expect(prompt).toContain('帮我做一个PPT');
    expect(prompt).not.toContain('English only');
  });

  it('detects primarily CJK vs Latin text', () => {
    expect(isPrimarilyCjkText('Help me make a PPT')).toBe(false);
    expect(isPrimarilyCjkText('帮我做一个PPT')).toBe(true);
    expect(isPrimarilyCjkText('Weekly status update')).toBe(false);
  });

  it('rejects any CJK in titles when the user request is not primarily CJK', () => {
    expect(isTitleLanguageCompatible('Help me plan Q3 hiring', '招聘计划')).toBe(false);
    expect(isTitleLanguageCompatible('Help me plan Q3 hiring', 'PPT制作')).toBe(false);
    expect(isTitleLanguageCompatible('Help me plan Q3 hiring', 'Q3 hiring plan')).toBe(true);
    expect(isTitleLanguageCompatible('帮我规划第三季度招聘', '招聘计划')).toBe(true);
    expect(isTitleLanguageCompatible('帮我规划第三季度招聘', 'PPT制作')).toBe(true);
    expect(isTitleLanguageCompatible('帮我规划第三季度招聘', 'Q3 hiring plan')).toBe(true);
  });

  it('normalizes generated title by taking first line and stripping quotes', () => {
    const title = normalizeGeneratedTitle('"  My Title  "\nSecond line');
    expect(title).toBe('My Title');
  });

  it('drops synthetic empty placeholder titles', () => {
    expect(normalizeGeneratedTitle('(no content)')).toBeNull();
    expect(normalizeGeneratedTitle('(empty content)')).toBeNull();
  });

  it('drops Chinese titles for English user prompts during normalize', () => {
    expect(normalizeGeneratedTitle('周报总结', 'Write a weekly report')).toBeNull();
    expect(normalizeGeneratedTitle('Weekly report summary', 'Write a weekly report')).toBe(
      'Weekly report summary'
    );
  });

  it('keeps Chinese titles when the user prompt is Chinese', () => {
    expect(normalizeGeneratedTitle('周报总结', '写一份周报')).toBe('周报总结');
  });
});
