/**
 * Same-ask collapse for Matter.
 * Terra groups paraphrases before Jev; this module is the deterministic backstop
 * and the source-priority picker used by both paths.
 */

import type { MatterSource } from '../../shared/matter';

/** Prefer the most actionable source when several signals are one ask. */
const SOURCE_PRIORITY: MatterSource[] = [
  'jira',
  'meeting',
  'gmail',
  'slack',
  'hub',
  'launchpad',
  'calendar',
  'fused',
];

/** Token overlap at or above this is the same ask. */
export const SAME_ASK_JACCARD = 0.5;

const TOKEN_STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'your',
  'you',
  'please',
  'this',
  'that',
  'from',
  'are',
  'was',
  'were',
  'have',
  'has',
  'had',
  'not',
  'but',
  'can',
  'could',
  'would',
  'should',
  'need',
  'needs',
  'into',
  'onto',
  'about',
  'before',
  'after',
  'than',
  'then',
  'just',
  'only',
  'also',
  'its',
  'our',
  'their',
]);

export function sameAskSourceRank(source: string): number {
  const index = SOURCE_PRIORITY.indexOf(source as MatterSource);
  return index < 0 ? SOURCE_PRIORITY.length : index;
}

export function sameAskTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !TOKEN_STOP.has(token));
  return new Set(tokens);
}

export function sameAskJaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

export function applySameAskGroups<T extends { fingerprint: string; source: string }>(
  signals: T[],
  groups: string[][]
): { kept: T[]; alsoSeenIn: Map<string, string[]> } {
  const byFingerprint = new Map(signals.map((signal) => [signal.fingerprint, signal]));
  const grouped = new Set<string>();
  const kept: T[] = [];
  const alsoSeenIn = new Map<string, string[]>();

  for (const group of groups) {
    const members = group
      .map((fingerprint) => byFingerprint.get(fingerprint))
      .filter((signal): signal is T => !!signal);
    if (!members.length) continue;
    const primary = [...members].sort(
      (a, b) => sameAskSourceRank(a.source) - sameAskSourceRank(b.source)
    )[0]!;
    kept.push(primary);
    const others = [
      ...new Set(
        members
          .filter((member) => member.fingerprint !== primary.fingerprint)
          .map((member) => member.source)
      ),
    ];
    if (others.length) alsoSeenIn.set(primary.fingerprint, others);
    for (const member of members) grouped.add(member.fingerprint);
  }

  for (const signal of signals) {
    if (!grouped.has(signal.fingerprint)) kept.push(signal);
  }
  return { kept, alsoSeenIn };
}

type Collapsible = {
  fingerprint: string;
  title: string;
  summary?: string | null;
  source: string;
  rankScore?: number;
};

function preferKept<T extends Collapsible>(candidate: T, current: T): boolean {
  const scoreDiff = (candidate.rankScore ?? 0) - (current.rankScore ?? 0);
  if (scoreDiff !== 0) return scoreDiff > 0;
  return sameAskSourceRank(candidate.source) < sameAskSourceRank(current.source);
}

/**
 * Drop later items that paraphrase an earlier one.
 * Highest rankScore wins; source priority breaks ties.
 */
export function collapseSameAskItems<T extends Collapsible>(items: T[]): T[] {
  const ordered = [...items].sort((a, b) => {
    const scoreDiff = (b.rankScore ?? 0) - (a.rankScore ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return sameAskSourceRank(a.source) - sameAskSourceRank(b.source);
  });
  const kept: T[] = [];
  const tokenSets: Array<Set<string>> = [];
  for (const item of ordered) {
    const tokens = sameAskTokens(`${item.title} ${item.summary || ''}`);
    const matchIndex = tokenSets.findIndex(
      (existing) => sameAskJaccard(tokens, existing) >= SAME_ASK_JACCARD
    );
    if (matchIndex < 0) {
      kept.push(item);
      tokenSets.push(tokens);
      continue;
    }
    if (preferKept(item, kept[matchIndex]!)) {
      kept[matchIndex] = item;
      tokenSets[matchIndex] = tokens;
    }
  }
  return kept;
}

/** Drop items that paraphrase a dismissed or done ask. */
export function omitSameAskAs<T extends { title: string; summary?: string | null }>(
  items: T[],
  suppressed: Array<{ title: string; summary?: string | null }>
): T[] {
  if (!suppressed.length) return items;
  const blocked = suppressed.map((item) => sameAskTokens(`${item.title} ${item.summary || ''}`));
  return items.filter((item) => {
    const tokens = sameAskTokens(`${item.title} ${item.summary || ''}`);
    return !blocked.some((existing) => sameAskJaccard(tokens, existing) >= SAME_ASK_JACCARD);
  });
}
