/**
 * Evidence sweep for last meeting's action items. Status is decided later by
 * synthesis; this only attaches what connectors say happened since.
 */

import { mapWithConcurrency } from './connectors';
import { searchDrive, searchGmail, searchJira, searchSlack, type GatherDeps } from './gather';
import type { PriorActionItem } from './types';

const ACTION_STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'into',
  'onto',
  'about',
  'will',
  'should',
  'need',
  'needs',
  'must',
  'can',
  'could',
  'would',
  'please',
  'next',
  'week',
  'today',
  'tomorrow',
  'team',
  'follow',
  'up',
  'send',
  'share',
  'check',
  'make',
  'sure',
  'get',
  'set',
  'review',
  'owner',
  'to',
  'on',
  'of',
  'in',
  'by',
  'a',
  'an',
  'is',
  'be',
  'it',
  'as',
  'at',
  'or',
  'all',
  'our',
  'we',
]);

/** Distinctive words from an action item for connector search (owner stripped). */
export function actionKeyPhrase(
  item: Pick<PriorActionItem, 'text' | 'owner'>,
  maxWords = 3
): string {
  let text = item.text;
  if (item.owner) text = text.replace(item.owner, ' ');
  const words = text
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !ACTION_STOP.has(w.toLowerCase()));
  const ranked = [...new Set(words)].sort((a, b) => {
    const aCap = /[A-Z0-9]/.test(a[0]) ? 0 : 1;
    const bCap = /[A-Z0-9]/.test(b[0]) ? 0 : 1;
    return aCap - bCap || b.length - a.length;
  });
  return ranked.slice(0, maxWords).join(' ');
}

/**
 * For each prior action item, search Slack / Gmail / Jira / Drive since the
 * last occurrence and attach evidence ids to `item.evidenceIds`.
 */
export async function gatherActionEvidence(input: {
  deps: GatherDeps;
  items: PriorActionItem[];
  sinceIso: string;
}): Promise<void> {
  const { deps, items, sinceIso } = input;
  const after = sinceIso.slice(0, 10);
  const days = Math.max(1, Math.ceil((Date.now() - Date.parse(sinceIso)) / 864e5));
  await mapWithConcurrency(items.slice(0, 8), 3, async (item, index) => {
    const phrase = actionKeyPhrase(item);
    if (!phrase) return;
    const tags = [`action:${index}`];
    const results = await Promise.all([
      searchSlack(deps, `${phrase} after:${after}`, { maxHits: 2, limit: 5, tags }),
      searchGmail(deps, `newer_than:${days}d ${phrase}`, { maxHits: 1, limit: 3, tags }),
      searchJira(deps, phrase, sinceIso, { maxHits: 2, limit: 3, tags }),
      searchDrive(deps, phrase, { maxHits: 1, limit: 3, tags }),
    ]);
    item.evidenceIds = [...new Set(results.flat())].filter((id) => id !== item.originEvidenceId);
  });
}
