import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Content split across MessageCard.tsx and the message/ sub-components directory
const messageCardPath = path.resolve(process.cwd(), 'src/renderer/components/MessageCard.tsx');
const messageDir = path.resolve(process.cwd(), 'src/renderer/components/message');
const messageCardContent = [
  fs.readFileSync(messageCardPath, 'utf8'),
  ...fs.readdirSync(messageDir).map((f) => fs.readFileSync(path.join(messageDir, f), 'utf8')),
].join('\n');

describe('AskUserQuestion UI rendering', () => {
  it('renders interactive AskUserQuestionBlock with submit and pending state', () => {
    expect(messageCardContent).toContain('function AskUserQuestionBlock');
    expect(messageCardContent).toContain('respondToQuestion');
    expect(messageCardContent).toContain('pendingQuestionsBySessionId');
    expect(messageCardContent).toContain('handleSubmit');
    expect(messageCardContent).toContain('Recommended');
  });

  it('uses three-state pending/answered/closed (never !isPending ⇒ answered)', () => {
    expect(messageCardContent).toContain('const isAnswered = submitted');
    expect(messageCardContent).not.toContain('submitted || !isPending');
    expect(messageCardContent).toContain("t('messageCard.pleaseAnswer')");
    expect(messageCardContent).toContain("t('messageCard.questionsAnswered')");
    expect(messageCardContent).toContain("t('messageCard.questionClosed')");
  });

  it('still renders lettered options and free-text fallback', () => {
    expect(messageCardContent).toContain('getOptionLetter');
    expect(messageCardContent).toContain('QuestionItem');
    expect(messageCardContent).toContain('freeTextPlaceholder');
  });
});
