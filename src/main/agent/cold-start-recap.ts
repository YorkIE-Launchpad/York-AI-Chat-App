/**
 * Cold-start recap for turns that fall outside the history budget.
 *
 * Without this, a rebuilt session only sees "[N older messages omitted]" and
 * the model loses what the chat was about. We combine the last persisted
 * compaction summary (when there is one) with a compact digest of the omitted
 * user requests and answer openings.
 */
import type { Message } from '../../renderer/types';

const QUESTION_CHARS = 220;
const ANSWER_CHARS = 280;

function firstText(message: Message): string {
  for (const block of message.content) {
    if (block.type === 'text' && block.text.trim()) return block.text;
  }
  return '';
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Newest-first digest of omitted turns, rendered oldest-first, within `charBudget`. */
export function buildOmittedTurnsDigest(omitted: Message[], charBudget: number): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = omitted.length - 1; i >= 0; i -= 1) {
    const message = omitted[i];
    const text = firstText(message);
    if (!text) continue;
    const line =
      message.role === 'user'
        ? `- User asked: ${oneLine(text, QUESTION_CHARS)}`
        : `  Answer began: ${oneLine(text, ANSWER_CHARS)}`;
    if (used + line.length > charBudget) break;
    used += line.length + 1;
    lines.unshift(line);
  }
  // Don't open the digest with a dangling answer whose question was cut.
  while (lines.length > 0 && lines[0].startsWith('  ')) lines.shift();
  return lines.join('\n');
}

export function buildColdStartRecap(input: {
  omitted: Message[];
  summary?: string | null;
  charBudget: number;
}): string {
  if (input.omitted.length === 0) return '';
  const summary = input.summary?.trim() || '';
  const summaryBudget = Math.floor(input.charBudget * 0.6);
  const clippedSummary =
    summary.length > summaryBudget ? `${summary.slice(0, summaryBudget)}…` : summary;
  const digest = buildOmittedTurnsDigest(
    input.omitted,
    Math.max(0, input.charBudget - clippedSummary.length)
  );
  if (!clippedSummary && !digest) return '';
  return [
    `<earlier_conversation omitted_messages="${input.omitted.length}">`,
    'Older turns of this chat are not shown verbatim. Treat this recap as what was already discussed; stay consistent with it.',
    clippedSummary ? `## Summary\n${clippedSummary}` : '',
    digest ? `## Earlier requests\n${digest}` : '',
    '</earlier_conversation>',
  ]
    .filter(Boolean)
    .join('\n');
}
