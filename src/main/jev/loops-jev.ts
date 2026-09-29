/**
 * Loops Jev: decides which candidate action items become loops.
 * An item is kept only when it has a specific output, enough context to stand alone,
 * and involves this user. Counterpart / due extraction stays on the LLM for survivors.
 */
import {
  JEV_LOOP_CONTEXT_NOUL,
  JEV_LOOP_INVOLVES_NOUL,
  JEV_LOOP_OUTPUT_NOUL,
} from '../../shared/jev';
import type { LoopOwner } from '../../shared/loops';
import type { WelcomeProfile } from '../../shared/welcome-actions';
import { choice, noul, runJevDecision, type EntryType, type Questions } from './jev-client';
import { log } from '../utils/logger';

export interface LoopJevCandidate {
  text: string;
  /** Extra per-item detail (e.g. Matter summary / suggested action). */
  detail?: string | null;
}

export interface LoopJevSource {
  kind: 'meeting' | 'matter';
  title: string;
  date: string | null;
  summary?: string | null;
  attendees?: unknown[];
}

export interface LoopJevDecision {
  keep: boolean;
  output: number;
  context: number;
  involves: number;
  owner: LoopOwner;
}

const OWNER_CRITERIA = {
  me: 'This user must do it (or it is unassigned but clearly theirs)',
  other: 'A named person owes it to this user',
} as const;

const BATCH_SIZE = 8;

async function decideBatch(
  source: LoopJevSource,
  batch: LoopJevCandidate[],
  profile: WelcomeProfile | null,
  batchIndex: number
): Promise<LoopJevDecision[] | null> {
  const questions: Questions = {};
  for (let i = 0; i < batch.length; i += 1) {
    const p = `a${i}`;
    questions[`${p}_output`] = noul(
      `Item ${i}: Does it name a SPECIFIC output that will exist once done — e.g. an email sent to a named person, access granted to a named account, a named doc shared, a named bug fixed? Vague intentions (clarify, ensure, align, discuss, confirm what, review generally, follow the process) are NO.`
    );
    questions[`${p}_context`] = noul(
      `Item ${i}: Could someone understand exactly what to do from the item alone (what, for whom, about which thing), without reading the meeting transcript or source? References like "which issue", "the tasks mentioned", "what is scheduled" are NO.`
    );
    questions[`${p}_involves`] = noul(
      `Item ${i}: Does THIS user personally have to do it, or does a named person explicitly owe it to this user? Actions purely between other people are NO.`
    );
    questions[`${p}_owner`] = choice(`Item ${i}: who owes it`, OWNER_CRITERIA);
  }

  const state = {
    role: 'Loops — personal commitments tracker for a York employee. Be strict: most candidate action items are NOT worth tracking.',
    user: profile
      ? {
          name: profile.name ?? null,
          title: profile.title ?? null,
          function: profile.functionName ?? null,
        }
      : null,
    source: {
      kind: source.kind,
      title: source.title,
      date: source.date,
      summary: source.summary ? source.summary.slice(0, 600) : null,
      attendees: (source.attendees || []).slice(0, 12),
    },
    items: batch.map((c, index) => ({
      index,
      text: c.text,
      detail: c.detail ? c.detail.slice(0, 300) : null,
    })),
  };

  const result = await runJevDecision(state as EntryType, questions, {
    label: `loops-${source.kind}-${batchIndex}`,
  });
  if (!result) return null;

  return batch.map((_, i) => {
    const p = `a${i}`;
    const read = (id: string) => {
      const ans = result.answers[`${p}_${id}`];
      return ans?.type === 'noul' ? ans.noul : 0;
    };
    const ownerAns = result.answers[`${p}_owner`];
    const output = read('output');
    const context = read('context');
    const involves = read('involves');
    return {
      keep:
        output >= JEV_LOOP_OUTPUT_NOUL &&
        context >= JEV_LOOP_CONTEXT_NOUL &&
        involves >= JEV_LOOP_INVOLVES_NOUL,
      output,
      context,
      involves,
      owner: ownerAns?.type === 'choice' && ownerAns.choice === 'other' ? 'other' : 'me',
    };
  });
}

/**
 * Decide which candidates are loop-worthy. Returns null when Jev is unavailable or any
 * batch fails, so the caller can fall back to its LLM screen.
 */
export async function runLoopActionJev(options: {
  source: LoopJevSource;
  candidates: LoopJevCandidate[];
  profile: WelcomeProfile | null;
}): Promise<LoopJevDecision[] | null> {
  const { source, candidates, profile } = options;
  if (candidates.length === 0) return [];
  const all: LoopJevDecision[] = [];
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const decided = await decideBatch(
      source,
      candidates.slice(i, i + BATCH_SIZE),
      profile,
      Math.floor(i / BATCH_SIZE)
    );
    if (!decided) {
      log('[Jev/Loops] batch failed; falling back to LLM screen');
      return null;
    }
    all.push(...decided);
  }
  log(
    `[Jev/Loops] ${source.kind} "${source.title}": kept ${all.filter((d) => d.keep).length}/${all.length}`
  );
  return all;
}
