import { useState } from 'react';
import { ArrowUp, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface MatterAskBarProps {
  disabled?: boolean;
  onAsk: (prompt: string) => void;
}

export function MatterAskBar({ disabled, onAsk }: MatterAskBarProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onAsk(trimmed);
    setValue('');
  };

  return (
    <div className="border-t border-border-muted bg-surface/40 px-4 py-3">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center gap-2 rounded-2xl border border-border-muted bg-background px-3 py-2">
          <Sparkles className="w-4 h-4 text-accent shrink-0" />
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={t('matter.askPlaceholder')}
            disabled={disabled}
            className="flex-1 min-w-0 bg-transparent text-sm text-text-primary placeholder:text-text-muted outline-none"
          />
          <button
            type="button"
            onClick={submit}
            disabled={disabled || !value.trim()}
            className="h-8 w-8 rounded-xl flex items-center justify-center bg-accent text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
            title={t('matter.askTitle')}
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
        <p className="mt-2 px-1 text-[11px] leading-4 text-text-muted text-center">
          {t('matter.askDisclaimer')}
        </p>
      </div>
    </div>
  );
}
