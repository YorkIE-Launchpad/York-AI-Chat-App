// AskUserQuestion tool block — interactive A/B/C/D clarifying questions
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HelpCircle, Check, CheckCircle2, Send } from 'lucide-react';
import type { ToolUseContent, QuestionItem, Message } from '../../types';
import { useAppStore } from '../../store';
import { useIPC } from '../../hooks/useIPC';

interface AskUserQuestionBlockProps {
  block: ToolUseContent;
  message?: Message;
}

function buildRecommendedSelections(questions: QuestionItem[]): Record<number, string[]> {
  const selections: Record<number, string[]> = {};
  questions.forEach((q, idx) => {
    if (!q.options || q.options.length === 0) {
      return;
    }
    const recommended = q.options.find((o) => o.recommended);
    if (recommended) {
      selections[idx] = [recommended.label];
    }
  });
  return selections;
}

export function AskUserQuestionBlock({ block, message }: AskUserQuestionBlockProps) {
  const { t } = useTranslation();
  const { respondToQuestion } = useIPC();
  const sessionId = message?.sessionId;
  const pendingQuestion = useAppStore((s) =>
    sessionId ? (s.pendingQuestionsBySessionId[sessionId] ?? null) : null
  );

  const questions: QuestionItem[] =
    ((block.input as Record<string, unknown>)?.questions as QuestionItem[]) || [];

  const isPending = Boolean(pendingQuestion && pendingQuestion.toolUseId === block.id);
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  const [freeText, setFreeText] = useState<Record<number, string>>({});
  const [submitted, setSubmitted] = useState(false);

  // Prefill recommended options when this block becomes the pending question
  useEffect(() => {
    if (!isPending || submitted) {
      return;
    }
    setSelections(buildRecommendedSelections(questions));
  }, [isPending, submitted, block.id]); // eslint-disable-line react-hooks/exhaustive-deps -- questions derived from block

  const isAnswered = submitted;
  const isClosed = !isPending && !submitted;
  const isReadOnly = !isPending || submitted;

  const handleOptionToggle = (questionIdx: number, label: string, multiSelect: boolean) => {
    if (isReadOnly) {
      return;
    }
    setSelections((prev) => {
      const current = prev[questionIdx] || [];
      if (multiSelect) {
        if (current.includes(label)) {
          return { ...prev, [questionIdx]: current.filter((l) => l !== label) };
        }
        return { ...prev, [questionIdx]: [...current, label] };
      }
      return { ...prev, [questionIdx]: [label] };
    });
  };

  const canSubmit =
    isPending &&
    !submitted &&
    questions.every((q, idx) => {
      if (q.options && q.options.length > 0) {
        return (selections[idx] || []).length > 0;
      }
      return (freeText[idx] || '').trim().length > 0;
    });

  const handleSubmit = () => {
    if (!pendingQuestion || !sessionId || submitted || !canSubmit) {
      return;
    }

    const answers: Record<number, string[]> = { ...selections };
    questions.forEach((q, idx) => {
      if (!q.options || q.options.length === 0) {
        const text = (freeText[idx] || '').trim();
        if (text) {
          answers[idx] = [text];
        }
      }
    });

    respondToQuestion(sessionId, pendingQuestion.questionId, JSON.stringify(answers));
    setSubmitted(true);
  };

  const getOptionLetter = (index: number) => String.fromCharCode(65 + index);

  const headerLabel = isAnswered
    ? t('messageCard.questionsAnswered')
    : isPending
      ? t('messageCard.pleaseAnswer')
      : t('messageCard.questionClosed');

  if (questions.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-4">
        <span className="text-text-muted">{t('messageCard.noQuestions')}</span>
      </div>
    );
  }

  return (
    <div className="rounded-xl border-2 border-accent/30 bg-gradient-to-br from-accent/5 to-transparent overflow-hidden">
      <div className="px-4 py-3 bg-accent/10 border-b border-accent/20 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-accent/20 flex items-center justify-center">
          <HelpCircle className="w-4 h-4 text-accent" />
        </div>
        <div>
          <span className="font-medium text-sm text-text-primary">{headerLabel}</span>
        </div>
        {isAnswered && <CheckCircle2 className="w-5 h-5 text-success ml-auto" />}
      </div>

      <div className="p-4 space-y-5">
        {questions.map((q, qIdx) => (
          <div key={qIdx} className="space-y-2">
            {q.header && (
              <span className="inline-block px-2 py-0.5 bg-accent/10 text-accent text-xs font-semibold rounded uppercase tracking-wide">
                {q.header}
              </span>
            )}
            <p className="text-text-primary font-medium text-sm">{q.question}</p>
            {q.options && q.options.length > 0 ? (
              <div className="space-y-1.5 mt-2">
                {q.options.map((option, optIdx) => {
                  const isSelected = (selections[qIdx] || []).includes(option.label);
                  const letter = getOptionLetter(optIdx);

                  return (
                    <button
                      key={optIdx}
                      type="button"
                      onClick={() => handleOptionToggle(qIdx, option.label, q.multiSelect || false)}
                      disabled={isReadOnly}
                      className={`w-full p-3 rounded-lg border text-left transition-all ${
                        isReadOnly
                          ? isSelected
                            ? 'border-accent/50 bg-accent/10 cursor-default'
                            : 'border-border-subtle bg-surface-muted cursor-default opacity-60'
                          : isSelected
                            ? 'border-accent bg-accent/10 hover:bg-accent/15'
                            : 'border-border-subtle bg-surface hover:border-border hover:bg-surface-muted'
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <div
                          className={`w-6 h-6 rounded flex items-center justify-center flex-shrink-0 text-xs font-semibold ${
                            isSelected
                              ? 'bg-accent text-white'
                              : 'bg-border-subtle text-text-secondary'
                          }`}
                        >
                          {isSelected ? <Check className="w-3.5 h-3.5" /> : letter}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span
                              className={`text-sm ${
                                isSelected ? 'text-accent font-medium' : 'text-text-primary'
                              }`}
                            >
                              {option.label}
                            </span>
                            {option.recommended && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-accent/15 text-accent">
                                {t('messageCard.recommended')}
                              </span>
                            )}
                          </div>
                          {option.description && (
                            <p className="text-xs text-text-muted mt-0.5">{option.description}</p>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <textarea
                value={freeText[qIdx] || ''}
                onChange={(e) =>
                  setFreeText((prev) => ({
                    ...prev,
                    [qIdx]: e.target.value,
                  }))
                }
                disabled={isReadOnly}
                rows={3}
                placeholder={t('messageCard.freeTextPlaceholder')}
                className="w-full mt-2 p-3 rounded-lg border border-border-subtle bg-surface text-sm text-text-primary placeholder:text-text-muted disabled:opacity-60 disabled:cursor-default focus:outline-none focus:border-accent"
              />
            )}
          </div>
        ))}
      </div>

      {isPending && !submitted && (
        <div className="px-4 pb-4">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={`w-full py-2.5 rounded-lg font-medium text-sm flex items-center justify-center gap-2 transition-all ${
              canSubmit
                ? 'bg-accent text-white hover:bg-accent-hover'
                : 'bg-surface-muted text-text-muted cursor-not-allowed'
            }`}
          >
            <Send className="w-4 h-4" />
            {t('messageCard.submitAnswers')}
          </button>
        </div>
      )}

      {isClosed && (
        <div className="px-4 pb-3 text-xs text-text-muted">
          {t('messageCard.questionClosedHint')}
        </div>
      )}
    </div>
  );
}
