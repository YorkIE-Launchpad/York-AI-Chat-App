import type { Message } from '../types';
import { splitSources, type Citation } from './citations';
import { extractMcpSourcesFromTurn } from './mcp-sources';

export interface TurnSources {
  userMessageId: string;
  question: string;
  sources: Citation[];
}

function messageText(message: Message): string {
  return message.content
    .map((block) => (block.type === 'text' ? (block as { text?: string }).text || '' : ''))
    .join('\n')
    .trim();
}

/** Sources per question in a chat: the answer's numbered list, else the tools it called. */
export function collectSessionSources(messages: Message[]): TurnSources[] {
  const turns: TurnSources[] = [];
  let current: TurnSources | null = null;

  const finish = () => {
    if (!current) return;
    if (current.sources.length === 0) {
      current.sources = extractMcpSourcesFromTurn(messages, current.userMessageId).map(
        (source, index) => ({
          n: index + 1,
          title: source.url ? source.title : `${source.title} · ${source.serverName}`,
          url: source.url,
        })
      );
    }
    if (current.sources.length > 0) turns.push(current);
  };

  for (const message of messages) {
    if (message.role === 'user') {
      finish();
      current = {
        userMessageId: message.id,
        question: messageText(message).split('\n')[0].slice(0, 120),
        sources: [],
      };
      continue;
    }
    if (!current || message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type !== 'text') continue;
      const { sources } = splitSources((block as { text?: string }).text || '');
      for (const source of sources) {
        if (source.url && current.sources.some((s) => s.url === source.url)) continue;
        current.sources.push({ ...source, n: current.sources.length + 1 });
      }
    }
  }
  finish();
  return turns;
}
