/**
 * Memory / watch / workflow Jev gates.
 */
import {
  JEV_BRIEF_INTENT_NOUL,
  JEV_MEMORY_DURABLE_NOUL,
  JEV_MEMORY_SUFFICIENT_NOUL,
  JEV_WATCH_CHANGED_NOUL,
  JEV_WORKFLOW_FLAG_NOUL,
  JEV_ACTIONABLE_NOUL,
} from '../../shared/jev';
import { choice, isJevEnabled, noul, runJevDecision, score, type Questions } from './jev-client';

export async function jevMemorySufficient(options: {
  question: string;
  visibleContext: string;
}): Promise<{ sufficient: boolean; noul: number } | null> {
  if (!isJevEnabled()) return null;
  const result = await runJevDecision(
    {
      question: options.question.slice(0, 2000),
      context: options.visibleContext.slice(0, 4000),
    },
    {
      sufficient: noul(
        'Is the visible memory/context enough to answer without expanding more chunks/sessions?'
      ),
    },
    { label: 'memory-sufficient' }
  );
  if (!result || result.answers.sufficient?.type !== 'noul') return null;
  const n = result.answers.sufficient.noul;
  return { sufficient: n >= JEV_MEMORY_SUFFICIENT_NOUL, noul: n };
}

export async function jevMemoryRelevanceScore(options: {
  query: string;
  chunk: string;
}): Promise<number | null> {
  if (!isJevEnabled()) return null;
  const result = await runJevDecision(
    {
      query: options.query.slice(0, 1000),
      chunk: options.chunk.slice(0, 2000),
    },
    {
      relevance: score('How relevant is this memory chunk to the query?', [
        'Irrelevant',
        'Weakly related',
        'Somewhat useful',
        'Highly relevant',
        'Exact match for the question',
      ]),
    },
    { label: 'memory-relevance' }
  );
  if (!result || result.answers.relevance?.type !== 'score') return null;
  return result.answers.relevance.score / 4;
}

export async function jevMemoryDurable(options: {
  candidate: string;
}): Promise<boolean | null> {
  if (!isJevEnabled()) return null;
  const result = await runJevDecision(
    { candidate: options.candidate.slice(0, 1500) },
    {
      durable: noul('Is this a stable durable fact worth storing in core memory?'),
    },
    { label: 'memory-durable' }
  );
  if (!result || result.answers.durable?.type !== 'noul') return null;
  return result.answers.durable.noul >= JEV_MEMORY_DURABLE_NOUL;
}

export async function jevWatchChanged(options: {
  checkPrompt: string;
  previous: string;
  current: string;
}): Promise<{ changed: boolean; noul: number } | null> {
  if (!isJevEnabled()) return null;
  const result = await runJevDecision(
    {
      check: options.checkPrompt.slice(0, 1000),
      previous: options.previous.slice(0, 3000),
      current: options.current.slice(0, 3000),
    },
    {
      changed: noul('Has the watched condition materially changed vs previous?'),
    },
    { label: 'watch-changed' }
  );
  if (!result || result.answers.changed?.type !== 'noul') return null;
  const n = result.answers.changed.noul;
  return { changed: n >= JEV_WATCH_CHANGED_NOUL, noul: n };
}

export async function jevWorkflowFlags(description: string): Promise<{
  wantsApproval: boolean;
  wantsNotify: boolean;
  wantsUserInput: boolean;
  channel: 'slack' | 'email' | 'calendar' | 'hub' | 'other' | null;
} | null> {
  if (!isJevEnabled() || !description.trim()) return null;
  const questions: Questions = {
    approval: noul('Does this workflow involve side effects needing human approval?'),
    notify: noul('Should this workflow notify someone when done?'),
    user_input: noul('Does this workflow need structured user input mid-run?'),
    channel: choice('Primary channel', {
      slack: 'Slack',
      email: 'Email',
      calendar: 'Calendar',
      hub: 'York Hub',
      other: 'Other / none',
    }),
  };
  const result = await runJevDecision(
    { description: description.slice(0, 3000) },
    questions,
    { label: 'workflow-flags' }
  );
  if (!result) return null;
  const channelRaw =
    result.answers.channel?.type === 'choice' ? result.answers.channel.choice : 'other';
  return {
    wantsApproval:
      result.answers.approval?.type === 'noul'
        ? result.answers.approval.noul >= JEV_WORKFLOW_FLAG_NOUL
        : false,
    wantsNotify:
      result.answers.notify?.type === 'noul'
        ? result.answers.notify.noul >= JEV_WORKFLOW_FLAG_NOUL
        : false,
    wantsUserInput:
      result.answers.user_input?.type === 'noul'
        ? result.answers.user_input.noul >= JEV_WORKFLOW_FLAG_NOUL
        : false,
    channel:
      channelRaw === 'slack' ||
      channelRaw === 'email' ||
      channelRaw === 'calendar' ||
      channelRaw === 'hub' ||
      channelRaw === 'other'
        ? channelRaw
        : null,
  };
}

export async function jevIsActionablePrompt(prompt: string): Promise<boolean | null> {
  if (!isJevEnabled() || !prompt.trim()) return null;
  const result = await runJevDecision(
    { prompt: prompt.slice(0, 2000) },
    {
      actionable: noul(
        'Does this user request require executing tools (not chat-only Q&A)?'
      ),
    },
    { label: 'actionable-prompt' }
  );
  if (!result || result.answers.actionable?.type !== 'noul') return null;
  return result.answers.actionable.noul >= JEV_ACTIONABLE_NOUL;
}

export async function jevIsBriefLikeIntent(prompt: string): Promise<boolean | null> {
  if (!isJevEnabled() || !prompt.trim()) return null;
  const result = await runJevDecision(
    { prompt: prompt.slice(0, 1500) },
    {
      brief: noul('Is this a status/brief/catch-me-up / what is coming up ask?'),
    },
    { label: 'brief-intent' }
  );
  if (!result || result.answers.brief?.type !== 'noul') return null;
  return result.answers.brief.noul >= JEV_BRIEF_INTENT_NOUL;
}
