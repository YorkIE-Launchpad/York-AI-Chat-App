/**
 * Live-assist Jev gates: answerable Noul + tool plan Choice from lean catalog.
 */
import { JEV_LIVE_ANSWERABLE_NOUL } from '../../shared/jev';
import { choice, isJevEnabled, noul, runJevDecision, type Questions } from './jev-client';

export async function jevClassifyLiveAnswerable(options: {
  transcriptWindow: string;
  candidateLine: string;
}): Promise<{ answerable: boolean; confidence: number } | null> {
  if (!isJevEnabled()) return null;
  const result = await runJevDecision(
    {
      transcript: options.transcriptWindow.slice(-2000),
      candidate: options.candidateLine,
    },
    {
      answerable: noul(
        'Is this an answerable factual/work question for a live meeting assistant (not rhetorical/small-talk/unclear)?'
      ),
    },
    { label: 'live-answerable' }
  );
  if (!result || result.answers.answerable?.type !== 'noul') return null;
  const n = result.answers.answerable.noul;
  return { answerable: n >= JEV_LIVE_ANSWERABLE_NOUL, confidence: n };
}

/**
 * Pick up to 2 tools from a lean catalog for live research.
 * Returns null when Jev unavailable — caller uses LLM planner.
 */
export async function jevPickLiveAssistTools(options: {
  question: string;
  catalog: Array<{ name: string; server: string; description: string }>;
}): Promise<{ toolNames: string[]; researchNeeded: boolean } | null> {
  if (!isJevEnabled() || options.catalog.length === 0) return null;

  const slice = options.catalog.slice(0, 15);
  const criteria: Record<string, string> = {
    none: 'No tool call needed — answer from context',
  };
  for (const tool of slice) {
    criteria[tool.name] = `${tool.server}: ${(tool.description || '').slice(0, 100)}`;
  }

  const questions: Questions = {
    research: noul('Does answering this live question need a connector/tool lookup?'),
    tool_a: choice('Best first tool (or none)', criteria),
    tool_b: choice('Optional second tool (or none)', criteria),
  };

  const result = await runJevDecision(
    { question: options.question, catalog: slice },
    questions,
    { label: 'live-tools' }
  );
  if (!result) return null;

  const researchNeeded =
    result.answers.research?.type === 'noul' ? result.answers.research.noul >= 0.5 : false;
  const names: string[] = [];
  for (const key of ['tool_a', 'tool_b'] as const) {
    const ans = result.answers[key];
    if (ans?.type === 'choice' && ans.choice !== 'none' && !names.includes(ans.choice)) {
      names.push(ans.choice);
    }
  }
  return { toolNames: researchNeeded ? names : [], researchNeeded };
}
