/**
 * Auto model tier + skill/playbook intent via Jev.
 */
import type { AutoModelTier, PromptComplexityContext } from '../../shared/auto-model';
import { choice, isJevEnabled, noul, runJevDecision, score, type Questions } from './jev-client';

const TIER_CRITERIA = {
  fast: 'Routine chat, short Q&A, simple lookups',
  balanced: 'Multi-step work, light coding, moderate context',
  frontier: 'Hard reasoning, large refactors, architecture, long agentic tasks',
} as const;

const COMPLEXITY_RUBRIC = [
  'Trivial greeting or one-liner',
  'Simple factual or short task',
  'Moderate multi-step task',
  'Hard coding / analysis',
  'Frontier-level reasoning or long agent run',
] as const;

export type JevSkillIntent =
  | 'meeting_prep'
  | 'work_brief'
  | 'client_status'
  | 'project_status'
  | 'confluence'
  | 'launchpad'
  | 'html_artifact'
  | 'goal_runner'
  | 'york_os_core'
  | 'none';

const SKILL_CRITERIA: Record<JevSkillIntent, string> = {
  meeting_prep: 'Prepare for an upcoming meeting / agenda',
  work_brief: 'Catch me up / status brief / what is coming up',
  client_status: 'Client status or update on a client',
  project_status: 'Project status or how is project X',
  confluence: 'Confluence / wiki document work',
  launchpad: 'R&D LaunchPad delivery / release / preview',
  html_artifact: 'Create HTML presentation / one-pager / deck artifact',
  goal_runner: 'Goal runner / keep going until done / GOAL_STATUS',
  york_os_core: 'General York OS / Hub / multi-connector company question',
  none: 'No special skill injection',
};

export async function jevScoreAutoTier(options: {
  prompt: string;
  context?: PromptComplexityContext;
}): Promise<{ tier: AutoModelTier; score: number; confidence: number } | null> {
  if (!isJevEnabled() || !options.prompt.trim()) return null;

  const questions: Questions = {
    complexity: score('How complex is this user task?', COMPLEXITY_RUBRIC),
    tier: choice('Which compute tier should Auto pick?', TIER_CRITERIA),
    york_nudge: noul('Is this routine enough that a cheap/local model is fine?'),
  };

  const result = await runJevDecision(
    {
      prompt: options.prompt.slice(0, 4000),
      messageCount: options.context?.messageCount ?? 0,
      contextChars: options.context?.contextChars ?? 0,
      hasImages: Boolean(options.context?.hasImages),
    },
    questions,
    { label: 'auto-tier' }
  );
  if (!result) return null;

  const complexity = result.answers.complexity;
  const tierAns = result.answers.tier;
  const rawScore =
    complexity?.type === 'score' ? Math.round((complexity.score / 4) * 100) : 50;
  const tier =
    tierAns?.type === 'choice' &&
    (tierAns.choice === 'fast' || tierAns.choice === 'balanced' || tierAns.choice === 'frontier')
      ? tierAns.choice
      : rawScore < 35
        ? 'fast'
        : rawScore < 70
          ? 'balanced'
          : 'frontier';
  const confidence = tierAns?.type === 'choice' ? tierAns.confidence : 0.5;
  return { tier, score: rawScore, confidence };
}

export async function jevClassifySkillIntent(prompt: string): Promise<JevSkillIntent | null> {
  if (!isJevEnabled() || !prompt.trim()) return null;
  const result = await runJevDecision(
    { prompt: prompt.slice(0, 3000) },
    {
      intent: choice('Which York skill/playbook should be injected?', SKILL_CRITERIA),
    },
    { label: 'skill-intent' }
  );
  if (!result || result.answers.intent?.type !== 'choice') return null;
  const picked = result.answers.intent.choice as JevSkillIntent;
  return picked in SKILL_CRITERIA ? picked : 'none';
}
