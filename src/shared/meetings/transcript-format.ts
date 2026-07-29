/** Shared helpers for speaker-labeled meeting transcripts. */

export interface TranscriptSegmentLike {
  text: string;
  speaker?: string | null;
}

/** Format one segment for display / prompt context. */
export function formatSegmentLine(segment: TranscriptSegmentLike): string {
  const text = segment.text.trim();
  if (!text) return '';
  const speaker = segment.speaker?.trim();
  if (speaker) {
    return `${speaker}: ${text}`;
  }
  return text;
}

/** Join segments into labeled transcript text. */
export function buildTranscriptText(segments: TranscriptSegmentLike[]): string {
  return segments
    .map((segment) => formatSegmentLine(segment))
    .filter(Boolean)
    .join('\n');
}
