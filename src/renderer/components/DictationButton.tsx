import { AudioLines, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { DictationErrorKind, DictationStatus } from '../hooks/useDictation';

interface DictationButtonProps {
  status: DictationStatus;
  errorKind: DictationErrorKind;
  disabled?: boolean;
  onToggle: () => void;
}

function titleForState(
  t: (key: string) => string,
  status: DictationStatus,
  errorKind: DictationErrorKind
): string {
  if (status === 'recording') {
    return t('chat.dictationStop');
  }
  if (status === 'connecting') {
    return t('chat.dictationConnecting');
  }
  if (status === 'error') {
    if (errorKind === 'mic_denied') {
      return t('chat.dictationMicDenied');
    }
    if (errorKind === 'sign_in') {
      return t('chat.dictationSignInRequired');
    }
    return t('chat.dictationFailed');
  }
  return t('chat.dictationStart');
}

export function DictationButton({
  status,
  errorKind,
  disabled = false,
  onToggle,
}: DictationButtonProps) {
  const { t } = useTranslation();
  const isRecording = status === 'recording';
  const isConnecting = status === 'connecting';
  const title = titleForState(t, status, errorKind);

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled || isConnecting}
      className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        isRecording
          ? 'text-accent bg-accent/10 hover:bg-accent/15'
          : status === 'error'
            ? 'text-error bg-error/10 hover:bg-error/15'
            : 'text-text-muted hover:text-text-primary hover:bg-surface-hover'
      }`}
      title={title}
      aria-label={title}
      aria-pressed={isRecording}
    >
      {isConnecting ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <AudioLines className={`w-3.5 h-3.5 ${isRecording ? 'animate-pulse' : ''}`} />
      )}
    </button>
  );
}
