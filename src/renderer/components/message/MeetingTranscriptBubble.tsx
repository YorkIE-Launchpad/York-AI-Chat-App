import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { AUTO_TEXT_DIRECTION_PROPS } from '../../utils/text-direction';
import type { MeetingTranscriptContent } from '../../types';

interface MeetingTranscriptBubbleProps {
  block: MeetingTranscriptContent;
}

export const MeetingTranscriptBubble = memo(function MeetingTranscriptBubble({
  block,
}: MeetingTranscriptBubbleProps) {
  const { t } = useTranslation();
  const speaker = block.speaker?.trim() || t('meetings.liveAssistUnknownSpeaker');

  return (
    <div className="flex min-w-0 max-w-full flex-col items-start gap-1">
      <span className="text-[11px] font-medium text-text-muted px-1">{speaker}</span>
      <div
        className="message-user min-w-0 w-fit max-w-[90%] break-words px-4 py-2.5 rounded-[1.25rem] rounded-tl-md bg-surface-muted border border-border-subtle text-text-primary text-sm"
        {...AUTO_TEXT_DIRECTION_PROPS}
      >
        {block.text}
      </div>
    </div>
  );
});
