// Editable draft card for ```draft fenced blocks (emails, Slack messages, replies).
import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, FileText, RotateCcw, Send } from 'lucide-react';
import { useIPC } from '../../hooks/useIPC';

interface DraftBlockProps {
  raw: string;
  sessionId?: string;
  isStreaming?: boolean;
}

interface ParsedDraft {
  to?: string;
  subject?: string;
  via?: string;
  channel?: string;
  body: string;
}

const HEADER_RE = /^(to|subject|via|channel|cc)\s*:\s*(.*)$/i;

export function parseDraft(raw: string): ParsedDraft {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const draft: ParsedDraft = { body: '' };
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      if (i > 0) i += 1;
      break;
    }
    const m = HEADER_RE.exec(line.trim());
    if (!m) break;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'to') draft.to = value;
    else if (key === 'subject') draft.subject = value;
    else if (key === 'via') draft.via = value;
    else if (key === 'channel') draft.channel = value;
  }
  draft.body = lines.slice(i).join('\n').trim();
  return draft;
}

export const DraftBlock = memo(function DraftBlock({
  raw,
  sessionId,
  isStreaming,
}: DraftBlockProps) {
  const { t } = useTranslation();
  const { continueSession } = useIPC();
  const parsed = useMemo(() => parseDraft(raw), [raw]);
  const [subject, setSubject] = useState(parsed.subject ?? '');
  const [body, setBody] = useState(parsed.body);
  const [dirty, setDirty] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);

  // Follow streamed text until the user starts editing.
  useEffect(() => {
    if (dirty) return;
    setSubject(parsed.subject ?? '');
    setBody(parsed.body);
  }, [parsed, dirty]);

  const recipient = parsed.channel || parsed.to;
  const via =
    parsed.via || (parsed.channel ? 'Slack' : parsed.subject !== undefined ? 'Gmail' : '');
  const heading = [
    via ? t('chat.draft.kindVia', { via }) : t('chat.draft.kind'),
    recipient ? t('chat.draft.to', { recipient }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const fullText = subject ? `${t('chat.draft.subject')}: ${subject}\n\n${body}` : body;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  };

  const handleSend = () => {
    if (!sessionId || !body.trim()) return;
    const lines = [
      t('chat.draft.sendPrompt', {
        via: via || t('chat.draft.defaultChannel'),
        recipient: recipient || t('chat.draft.sameRecipient'),
      }),
      '',
      '```draft',
      ...(recipient ? [`${parsed.channel ? 'Channel' : 'To'}: ${recipient}`] : []),
      ...(subject ? [`Subject: ${subject}`] : []),
      ...(via ? [`Via: ${via}`] : []),
      ...(recipient || subject || via ? [''] : []),
      body.trim(),
      '```',
    ];
    void continueSession(sessionId, lines.join('\n'));
    setSent(true);
  };

  const reset = () => {
    setSubject(parsed.subject ?? '');
    setBody(parsed.body);
    setDirty(false);
  };

  return (
    <div className="not-prose my-3 overflow-hidden whitespace-normal rounded-xl border border-border bg-surface font-sans">
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2 text-[12px] text-text-secondary">
        <FileText className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{heading}</span>
        {dirty ? (
          <button
            type="button"
            onClick={reset}
            className="btn btn-ghost btn-sm"
            title={t('chat.draft.reset')}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('chat.draft.reset')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="btn btn-secondary btn-sm"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? t('common.copied') : t('chat.draft.copy')}
        </button>
        {sessionId ? (
          <button
            type="button"
            onClick={handleSend}
            disabled={isStreaming || sent || !body.trim()}
            className="btn btn-primary btn-sm"
            title={t('chat.draft.sendHint')}
          >
            {sent ? <Check className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
            {sent
              ? t('chat.draft.sent')
              : via
                ? t('chat.draft.sendVia', { via })
                : t('chat.draft.send')}
          </button>
        ) : null}
      </div>
      <div className="space-y-2 p-3">
        {parsed.subject !== undefined ? (
          <input
            className="draft-field !min-h-0 py-2 font-medium"
            value={subject}
            onChange={(e) => {
              setDirty(true);
              setSubject(e.target.value);
            }}
            aria-label={t('chat.draft.subject')}
            placeholder={t('chat.draft.subject')}
            spellCheck
          />
        ) : null}
        <textarea
          className="draft-field"
          value={body}
          rows={Math.min(18, Math.max(4, body.split('\n').length + 1))}
          onChange={(e) => {
            setDirty(true);
            setBody(e.target.value);
          }}
          aria-label={t('chat.draft.body')}
          spellCheck
        />
        <p className="text-[11.5px] text-text-muted">{t('chat.draft.note')}</p>
      </div>
    </div>
  );
});
