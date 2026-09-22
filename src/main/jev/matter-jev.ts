/**
 * Matter max-Jev: parallel keep/severity/orbit/category/rank/confidence + lenses.
 * Narrative fields stay on the LLM for survivors only.
 */
import type { WelcomeProfile } from '../../shared/welcome-actions';
import {
  JEV_MATTER_KEEP_CONFIDENCE,
  JEV_MATTER_NOTIFY_NOUL,
} from '../../shared/jev';
import type {
  MatterCategory,
  MatterLensId,
  MatterLensStatus,
  MatterOrbit,
  MatterSeverity,
} from '../../shared/matter';
import { MATTER_LENS_IDS } from '../../shared/matter';
import { choice, noul, runJevDecision, score, type EntryType, type Questions } from './jev-client';
import type { RawMatterSignal } from '../matter/matter-collector';
import { log } from '../utils/logger';

export type MatterJevSignalDecision = {
  fingerprint: string;
  keep: boolean;
  keepConfidence: number;
  severity: MatterSeverity;
  orbit: MatterOrbit;
  category: MatterCategory;
  rankScore: number;
  confidence: number;
  titleOk: boolean;
  notify: boolean;
};

export type MatterJevLensDecision = {
  id: MatterLensId;
  status: MatterLensStatus;
};

export type MatterJevRankDecisions = {
  signals: MatterJevSignalDecision[];
  lenses: MatterJevLensDecision[];
};

const SEVERITY_CRITERIA = {
  critical: 'Blocker, manager escalation, or meeting within 2h needing prep',
  warning: 'Action due today',
  healthy: 'On track but still an action for this person',
  signal: 'Lighter action still worth surfacing',
} as const;

const ORBIT_CRITERIA = {
  now: 'Needs attention immediately / inner radar',
  today: 'Action expected today',
  week: 'This week',
  watching: 'Monitor only for now',
} as const;

const CATEGORY_CRITERIA = {
  delivery: 'Delivery / engineering / LaunchPad / Jira work',
  people: 'People, leave, kudos, team',
  client: 'Client-facing',
  comms: 'Slack / email communication',
  time: 'Calendar / meeting prep / schedule',
  admin: 'Admin / Hub timesheet / approvals',
} as const;

const LENS_STATUS_CRITERIA = {
  ACTIVE: 'Critical pressure in this lens',
  MONITORING: 'Items present but not critical',
  CLEAR: 'Nothing pressing',
  COORDINATING: 'Waiting on others / cross-team coordination',
} as const;

const RANK_CRITERIA = [
  'Drop or ignore — no personal action',
  'Low priority watching item',
  'Moderate action this week',
  'Important action today',
  'Urgent / must act now',
] as const;

const BATCH_SIZE = 8;

function asSeverity(value: string | undefined, fallback: MatterSeverity): MatterSeverity {
  if (value === 'critical' || value === 'warning' || value === 'healthy' || value === 'signal') {
    return value;
  }
  return fallback;
}

function asOrbit(value: string | undefined, fallback: MatterOrbit): MatterOrbit {
  if (value === 'now' || value === 'today' || value === 'week' || value === 'watching') {
    return value;
  }
  return fallback;
}

function asCategory(value: string | undefined, fallback: MatterCategory): MatterCategory {
  if (
    value === 'delivery' ||
    value === 'people' ||
    value === 'client' ||
    value === 'comms' ||
    value === 'time' ||
    value === 'admin'
  ) {
    return value;
  }
  return fallback;
}

function asLensStatus(value: string | undefined): MatterLensStatus {
  if (
    value === 'ACTIVE' ||
    value === 'MONITORING' ||
    value === 'CLEAR' ||
    value === 'COORDINATING'
  ) {
    return value;
  }
  return 'CLEAR';
}

function rankScoreFromJev(raw: number): number {
  // Rubric 0–4 → 0–100
  const clamped = Math.max(0, Math.min(4, raw));
  return Math.round((clamped / 4) * 100);
}

function signalStateSlice(signal: RawMatterSignal, profile: WelcomeProfile | null) {
  return {
    fingerprint: signal.fingerprint,
    source: signal.source,
    title: signal.title,
    summary: signal.summary,
    raw: (signal.rawExcerpt || signal.rawDetails || '').slice(0, 400),
    severityHint: signal.severityHint ?? null,
    orbitHint: signal.orbitHint ?? null,
    categoryHint: signal.categoryHint ?? null,
    dueAt: signal.dueAt ?? signal.occurredAt ?? null,
    profile: profile
      ? {
          title: profile.title ?? null,
          function: profile.functionName ?? null,
          squad: profile.squad ?? null,
          department: profile.department ?? null,
        }
      : null,
  };
}

async function decideSignalBatch(
  batch: RawMatterSignal[],
  profile: WelcomeProfile | null,
  batchIndex: number
): Promise<MatterJevSignalDecision[] | null> {
  const questions: Questions = {};
  for (let i = 0; i < batch.length; i += 1) {
    const prefix = `s${i}`;
    questions[`${prefix}_keep`] = noul(
      `Signal ${i}: Does THIS person need to act on this now (reply/approve/unblock/prep/complete)? Keep Slack unreads and Hub kudos/timesheet/approvals.`
    );
    questions[`${prefix}_severity`] = choice(`Signal ${i}: severity`, SEVERITY_CRITERIA);
    questions[`${prefix}_orbit`] = choice(`Signal ${i}: radar orbit`, ORBIT_CRITERIA);
    questions[`${prefix}_category`] = choice(`Signal ${i}: category`, CATEGORY_CRITERIA);
    questions[`${prefix}_rank`] = score(`Signal ${i}: action priority`, RANK_CRITERIA);
    questions[`${prefix}_title_ok`] = noul(
      `Signal ${i}: Is the existing title good enough to keep (not junk/rollup)?`
    );
    questions[`${prefix}_notify`] = noul(
      `Signal ${i}: Should we fire an OS notification for this if kept?`
    );
  }

  const state = {
    role: 'Matter personal action radar for York employee',
    signals: batch.map((s) => signalStateSlice(s, profile)),
  };

  const result = await runJevDecision(state as EntryType, questions, {
    label: `matter-batch-${batchIndex}`,
  });
  if (!result) return null;

  const decisions: MatterJevSignalDecision[] = [];
  for (let i = 0; i < batch.length; i += 1) {
    const signal = batch[i]!;
    const prefix = `s${i}`;
    const keepAns = result.answers[`${prefix}_keep`];
    const sevAns = result.answers[`${prefix}_severity`];
    const orbitAns = result.answers[`${prefix}_orbit`];
    const catAns = result.answers[`${prefix}_category`];
    const rankAns = result.answers[`${prefix}_rank`];
    const titleAns = result.answers[`${prefix}_title_ok`];
    const notifyAns = result.answers[`${prefix}_notify`];

    const keepNoul = keepAns?.type === 'noul' ? keepAns.noul : 0;
    const keepConf = sevAns?.type === 'choice' ? sevAns.confidence : keepNoul;
    const keep = keepNoul >= JEV_MATTER_KEEP_CONFIDENCE;

    decisions.push({
      fingerprint: signal.fingerprint,
      keep,
      keepConfidence: keepConf,
      severity: asSeverity(
        sevAns?.type === 'choice' ? sevAns.choice : undefined,
        signal.severityHint || 'signal'
      ),
      orbit: asOrbit(
        orbitAns?.type === 'choice' ? orbitAns.choice : undefined,
        signal.orbitHint || 'today'
      ),
      category: asCategory(
        catAns?.type === 'choice' ? catAns.choice : undefined,
        signal.categoryHint || 'comms'
      ),
      rankScore:
        rankAns?.type === 'score' ? rankScoreFromJev(rankAns.score) : keep ? 50 : 0,
      confidence: rankAns?.type === 'score' ? rankAns.confidence : keepConf,
      titleOk: titleAns?.type === 'noul' ? titleAns.noul >= 0.5 : true,
      notify: notifyAns?.type === 'noul' ? notifyAns.noul >= JEV_MATTER_NOTIFY_NOUL : false,
    });
  }
  return decisions;
}

async function decideLenses(
  kept: MatterJevSignalDecision[],
  profile: WelcomeProfile | null
): Promise<MatterJevLensDecision[] | null> {
  const questions: Questions = {};
  for (const id of MATTER_LENS_IDS) {
    questions[`lens_${id}`] = choice(`Lens ${id} status given kept items`, LENS_STATUS_CRITERIA);
  }
  const result = await runJevDecision(
    {
      profile: profile?.title ?? null,
      kept: kept.map((k) => ({
        severity: k.severity,
        category: k.category,
        rankScore: k.rankScore,
      })),
    },
    questions,
    { label: 'matter-lenses' }
  );
  if (!result) return null;
  return MATTER_LENS_IDS.map((id) => {
    const ans = result.answers[`lens_${id}`];
    return {
      id,
      status: asLensStatus(ans?.type === 'choice' ? ans.choice : undefined),
    };
  });
}

/**
 * Run max Matter Jev decisions over a signal pool.
 * Returns null when Jev is unavailable (caller uses LLM/heuristic path).
 */
export async function runMatterJevDecisions(options: {
  signals: RawMatterSignal[];
  profile: WelcomeProfile | null;
}): Promise<MatterJevRankDecisions | null> {
  const { signals, profile } = options;
  if (signals.length === 0) {
    return { signals: [], lenses: MATTER_LENS_IDS.map((id) => ({ id, status: 'CLEAR' })) };
  }

  const all: MatterJevSignalDecision[] = [];
  for (let i = 0; i < signals.length; i += BATCH_SIZE) {
    const batch = signals.slice(i, i + BATCH_SIZE);
    const decided = await decideSignalBatch(batch, profile, Math.floor(i / BATCH_SIZE));
    if (!decided) {
      log('[Jev/Matter] batch failed; aborting Jev Matter path');
      return null;
    }
    all.push(...decided);
  }

  const kept = all.filter((d) => d.keep);
  const lenses =
    (await decideLenses(kept, profile)) ??
    MATTER_LENS_IDS.map((id) => ({ id, status: 'CLEAR' as MatterLensStatus }));

  log(`[Jev/Matter] decided ${all.length} signals, kept ${kept.length}`);
  return { signals: all, lenses };
}
