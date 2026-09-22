/**
 * Rank composer skill picker candidates with Jev Score.
 * Lexical prefilter + parallel scores; falls back to lexical order when Jev is off.
 */
import { score, runJevDecision, isJevEnabled, type Questions } from './jev-client';
import { log } from '../utils/logger';

export type SkillRankCandidate = {
  name: string;
  description?: string;
};

const RANK_RUBRIC = [
  'Irrelevant to the query',
  'Weak / tangential',
  'Plausible match',
  'Strong match',
  'Best skill for this query',
] as const;

const CANDIDATE_LIMIT = 20;

/** Lexical score for prefilter (name hits weigh more than description). */
export function lexicalSkillScore(query: string, skill: SkillRankCandidate): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const name = skill.name.toLowerCase();
  const description = (skill.description ?? '').toLowerCase();
  let s = 0;
  if (name === q) s += 100;
  if (name.startsWith(q)) s += 50;
  if (name.includes(q)) s += 30;
  if (description.includes(q)) s += 10;
  const tokens = q.split(/[\s_-]+/).filter((t) => t.length > 1);
  for (const token of tokens) {
    if (name.includes(token)) s += 8;
    if (description.includes(token)) s += 2;
  }
  return s;
}

export function lexicalRankSkills(
  query: string,
  skills: SkillRankCandidate[]
): SkillRankCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...skills];
  return [...skills]
    .map((skill) => ({ skill, score: lexicalSkillScore(q, skill) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .map((e) => e.skill);
}

/**
 * Rank skills for a composer query. Returns ordered names, or null when Jev unavailable
 * (caller should use lexicalRankSkills).
 */
export async function jevRankSkills(options: {
  query: string;
  skills: SkillRankCandidate[];
}): Promise<string[] | null> {
  const query = options.query.trim();
  if (!query || options.skills.length === 0) return null;
  if (!isJevEnabled()) return null;

  const lexical = lexicalRankSkills(query, options.skills).slice(0, CANDIDATE_LIMIT);
  if (lexical.length === 0) return [];
  if (lexical.length === 1) return [lexical[0]!.name];

  const questions: Questions = {};
  for (let i = 0; i < lexical.length; i += 1) {
    const skill = lexical[i]!;
    questions[`s${i}`] = score(
      `How relevant is skill "${skill.name}" (${(skill.description || '').slice(0, 120)}) to the user query?`,
      RANK_RUBRIC
    );
  }

  const result = await runJevDecision(
    {
      query,
      skills: lexical.map((s) => ({
        name: s.name,
        description: (s.description || '').slice(0, 160),
      })),
    },
    questions,
    { label: 'skill-select' }
  );
  if (!result) return null;

  const ranked = lexical
    .map((skill, i) => {
      const ans = result.answers[`s${i}`];
      const jevScore = ans?.type === 'score' ? ans.score : 0;
      const confidence = ans?.type === 'score' ? ans.confidence : 0;
      return { name: skill.name, score: jevScore, confidence };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  // If Jev is broadly unsure, keep lexical order.
  const avgConf =
    ranked.reduce((sum, r) => sum + r.confidence, 0) / Math.max(1, ranked.length);
  if (avgConf < 0.35) {
    log('[Jev/SkillSelect] low confidence; using lexical order');
    return lexical.map((s) => s.name);
  }

  log(`[Jev/SkillSelect] ranked ${ranked.length} skills for query="${query}"`);
  return ranked.map((r) => r.name);
}
