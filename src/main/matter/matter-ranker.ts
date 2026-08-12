import type { AppConfig } from '../config/config-store';
import { runPiAiOneShot } from '../agent/sdk-one-shot';
import { applyBackendManagedCredentials } from '../../shared/backend-config';
import { logWarn } from '../utils/logger';
import type { WelcomeProfile } from '../../shared/welcome-actions';
import type {
  MatterCategory,
  MatterItem,
  MatterOrbit,
  MatterSensitivity,
  MatterSeverity,
} from '../../shared/matter';
import { deriveMatterTimeFields, urgencyFromDueAt } from '../../shared/matter-time';
import type { RawMatterSignal } from './matter-collector';
import {
  isAllDayCalendarEvent,
  isDailySeriesMeeting,
  isPersonalCalendarHold,
  looksLikeJunkTitle,
} from './matter-collector';

/** Fixed model for Matter ranking (OpenAI via backend proxy). */
const MATTER_RANKER_MODEL = 'gpt-5.6-luna';

const SYSTEM_PROMPT = `You are Matter Ranker for York IE VECOS — personal ACTION radar only.

Given the employee's Hub profile and raw signals, keep ONLY items that need THIS person's action now.
People triage their own unreads / feeds in Slack, Gmail, Calendar — Matter is not an unread inbox.

Return ONLY valid JSON (no markdown):
{
  "pulse": "one short line about what needs THEIR action",
  "brief": "2-3 sentence narrative of actions only",
  "items": [
    {
      "fingerprint": "MUST equal an input signal fingerprint exactly",
      "title": "prefer the signal title (especially enriched calendar titles with people/topic); shorten only if needed (<= 90 chars). Never rewrite an enriched meeting title back to a bare invite like Sync/Meeting/Catch up",
      "summary": "one sentence about the action required",
      "whyItMatters": "why THIS person must act, tied to role/title when possible",
      "severity": "critical|warning|healthy|signal",
      "orbit": "now|today|week|watching",
      "category": "delivery|people|client|comms|time|admin",
      "source": "jira|slack|gmail|calendar|hub|meeting|launchpad|fused",
      "confidence": 0.0-1.0,
      "suggestedAction": "concrete next step THEY should take",
      "rankScore": 0-100,
      "sourceRef": { "externalId": "...", "url": null, "label": "..." }
    }
  ],
  "lenses": [
    {
      "id": "delivery|people|clients|comms|time|team",
      "status": "ACTIVE|MONITORING|CLEAR|COORDINATING",
      "summary": "1-2 sentences on action pressure in this lens"
    }
  ]
}

Rules:
- KEEP only action-needed items: reply/approve/unblock/prep-for-imminent-meeting/complete assigned work.
- DROP awareness-only: unread counts, FYI, OOO lists, "on your calendar this week", generic triage.
- DROP personal calendar holds: Break, block, focus/OOO/lunch/PTO and similar solo holds — Matter is not a calendar reminder for free time.
- DROP daily recurring series (daily standup/sync, RRULE FREQ=DAILY) — not one-off action items.
- DROP anything the person can casually discover in the native app with no ask on them.
- Prefer role relevance (title/squad/department): if an item is not for them, omit it.
- ONE input signal = ONE output item. Never merge into counts.
- FORBIDDEN titles: unread rollups, "threads that may need a reply", calendar count titles.
- fingerprint MUST be copied exactly from an input signal.
- Prefer fewer high-action items. Max items is provided.
- critical = blocker / manager escalation / meeting in <2h needing prep.
- warning = action due today. signal = lighter but still an action.
- For calendar items with a "## Meeting prep" rawDetails / prep note: KEEP them as prep-for-imminent-meeting actions; use that prep context for summary and whyItMatters; keep the collector title when it already names people or a topic.
- rankScore and confidence MUST be JSON numbers (e.g. 60, 0.7), never words like "sixty".
- Never use JSON keys, schema fragments, or path arrays as titles.
- If nothing needs action, return empty items and a calm pulse.`;

const WORD_NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

/** Repair common LLM JSON mistakes before parse (word numbers, trailing commas). */
export function repairMatterRankerJson(text: string): string {
  let out = text.trim();
  // Strip markdown fences if present
  const fenced = out.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced) out = fenced[1].trim();

  // "rankScore": sixty  / "confidence": point-seven-ish → numbers
  out = out.replace(
    /"(rankScore|confidence)"\s*:\s*([A-Za-z][A-Za-z-]*)\b/g,
    (_m, key: string, word: string) => {
      const normalized = word.toLowerCase().replace(/-/g, '');
      const n = WORD_NUMBERS[word.toLowerCase()] ?? WORD_NUMBERS[normalized];
      if (n != null) return `"${key}": ${n}`;
      // Unknown word — fall back to safe defaults
      return key === 'confidence' ? `"${key}": 0.5` : `"${key}": 50`;
    }
  );

  // "rankScore": "60" → number
  out = out.replace(
    /"(rankScore|confidence)"\s*:\s*"(-?\d+(?:\.\d+)?)"/g,
    (_m, key: string, num: string) => `"${key}": ${num}`
  );

  // Trailing commas before } or ]
  out = out.replace(/,\s*([}\]])/g, '$1');
  return out;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const candidates = [trimmed, repairMatterRankerJson(trimmed)];
  // Also try substring object extraction on repaired text
  const repaired = repairMatterRankerJson(trimmed);
  const start = repaired.indexOf('{');
  const end = repaired.lastIndexOf('}');
  if (start >= 0 && end > start) {
    candidates.push(repaired.slice(start, end + 1));
  }
  const startRaw = trimmed.indexOf('{');
  const endRaw = trimmed.lastIndexOf('}');
  if (startRaw >= 0 && endRaw > startRaw) {
    candidates.push(repairMatterRankerJson(trimmed.slice(startRaw, endRaw + 1)));
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('No JSON object in ranker response');
}

function asSeverity(v: unknown): MatterSeverity {
  if (v === 'critical' || v === 'warning' || v === 'healthy' || v === 'signal') return v;
  return 'signal';
}

function asOrbit(v: unknown): MatterOrbit {
  if (v === 'now' || v === 'today' || v === 'week' || v === 'watching') return v;
  return 'watching';
}

function asCategory(v: unknown): MatterCategory {
  if (
    v === 'delivery' ||
    v === 'people' ||
    v === 'client' ||
    v === 'comms' ||
    v === 'time' ||
    v === 'admin'
  ) {
    return v;
  }
  return 'comms';
}

function extractFirstUrl(text?: string | null): string | null {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s"'<>)\\]]+/i);
  if (!match) return null;
  return match[0].replace(/[.,;:]+$/, '');
}

function enrichSourceRef(
  ref: MatterItem['sourceRef'] | Record<string, unknown>,
  rawExcerpt?: string | null
): MatterItem['sourceRef'] {
  const base = {
    connectorId: typeof ref.connectorId === 'string' ? ref.connectorId : null,
    toolName: typeof ref.toolName === 'string' ? ref.toolName : null,
    externalId: typeof ref.externalId === 'string' ? ref.externalId : null,
    url: typeof ref.url === 'string' ? ref.url : null,
    label: typeof ref.label === 'string' ? ref.label : null,
  };
  if (!base.url) {
    base.url = extractFirstUrl(rawExcerpt);
  }
  return base;
}

function isRollupTitle(title: string): boolean {
  const t = title.trim();
  return (
    /^\d+\s+(unread|calendar|emails?|messages?|events?|threads?|items?)\b/i.test(t) ||
    /\b(need|needs)\s+triage\b/i.test(t) ||
    /\bthreads that may need\b/i.test(t) ||
    /\bevents scheduled\b/i.test(t) ||
    /\bmessages need\b/i.test(t) ||
    /\bthat may need a reply\b/i.test(t)
  );
}

function attachRawFromSignals(
  items: RankedMatterResult['items'],
  signals: RawMatterSignal[]
): RankedMatterResult['items'] {
  const byFingerprint = new Map(signals.map((s) => [s.fingerprint, s]));
  return items.map((item) => {
    const signal = byFingerprint.get(item.fingerprint);
    const rawDetails = signal?.rawDetails || item.rawDetails || signal?.rawExcerpt || null;
    const title =
      signal &&
      (!item.title || isRollupTitle(item.title) || looksLikeJunkTitle(item.title)) &&
      !looksLikeJunkTitle(signal.title)
        ? signal.title.slice(0, 120)
        : looksLikeJunkTitle(item.title) && signal && !looksLikeJunkTitle(signal.title)
          ? signal.title.slice(0, 120)
          : item.title;
    const summary =
      signal &&
      (!item.summary || isRollupTitle(item.summary) || looksLikeJunkTitle(item.summary)) &&
      !looksLikeJunkTitle(signal.summary)
        ? signal.summary
        : item.summary;
    return {
      ...item,
      title,
      summary,
      source: signal?.source || item.source,
      rawDetails,
      sourceRef: enrichSourceRef(
        { ...(signal?.sourceRef || {}), ...(item.sourceRef || {}) },
        rawDetails
      ),
    };
  });
}

export interface RankedMatterResult {
  pulse: string;
  brief: string | null;
  items: Array<
    Omit<
      MatterItem,
      | 'id'
      | 'createdAt'
      | 'updatedAt'
      | 'lastSeenAt'
      | 'resolvedAt'
      | 'status'
      | 'pinned'
      | 'snoozeUntil'
      | 'reminderNotifiedAt'
      | 'expiredNotifiedAt'
    >
  >;
  lenses: Array<{
    id: 'delivery' | 'people' | 'clients' | 'comms' | 'time' | 'team';
    status: 'ACTIVE' | 'MONITORING' | 'CLEAR' | 'COORDINATING';
    summary: string;
  }>;
}

function heuristicRank(
  signals: RawMatterSignal[],
  profile: WelcomeProfile | null,
  maxItems: number
): RankedMatterResult {
  const severityBoost: Record<string, number> = {
    critical: 40,
    warning: 25,
    healthy: 5,
    signal: 10,
  };
  // Collectors already bias to action; still drop pure awareness leftovers.
  const actionable = signals.filter((s) => {
    if (looksLikeJunkTitle(s.title)) return false;
    if (s.source === 'calendar' && isPersonalCalendarHold(s.title)) return false;
    if (s.source === 'calendar') {
      const calText = s.rawDetails || s.rawExcerpt || '';
      // Independent of personal holds — daily series and all-day never become Matter items.
      if (isDailySeriesMeeting(s.title, calText)) return false;
      if (isAllDayCalendarEvent(s.summary || '', calText)) return false;
    }
    if (s.source === 'meeting' || s.source === 'fused' || s.source === 'jira') return true;
    if (s.severityHint === 'critical' || s.severityHint === 'warning') return true;
    const blob = `${s.title} ${s.summary} ${s.suggestedAction || ''} ${s.whyHint || ''}`;
    return (
      /\b(reply|approve|confirm|prep|unblock|complete|update status|act on|ask|need)\b/i.test(
        blob
      ) || /\?/.test(blob)
    );
  });

  const items = actionable
    .slice(0, maxItems)
    .map((s, index) => {
      const dueAt = s.dueAt ?? s.occurredAt ?? null;
      const times = deriveMatterTimeFields({
        dueAt,
        expiresAt: s.expiresAt ?? null,
        source: s.source,
      });
      const urgency = urgencyFromDueAt(times.dueAt);
      const severity = urgency?.severity || s.severityHint || 'signal';
      const orbit = urgency?.orbit || s.orbitHint || (severity === 'critical' ? 'now' : 'today');
      const rankBoost = urgency?.rankBoost ?? 0;
      return {
        fingerprint: s.fingerprint,
        title: s.title.slice(0, 90),
        summary: s.summary,
        whyItMatters:
          s.whyHint ||
          (profile?.title
            ? `Needs your action as ${profile.title}.`
            : 'Needs your action from connected work tools.'),
        severity,
        orbit,
        category: s.categoryHint || 'comms',
        source: s.source,
        confidence: 0.55,
        suggestedAction: s.suggestedAction || null,
        rankScore: (severityBoost[severity] ?? 10) + Math.max(0, 20 - index) + rankBoost * 0.25,
        sourceRef: enrichSourceRef(s.sourceRef || {}, s.rawDetails || s.rawExcerpt),
        rawDetails: s.rawDetails || s.rawExcerpt || null,
        dueAt: times.dueAt,
        remindAt: times.remindAt,
        expiresAt: times.expiresAt,
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore);

  const critical = items.filter((i) => i.severity === 'critical').length;
  const warning = items.filter((i) => i.severity === 'warning').length;
  const pulse =
    items.length === 0
      ? 'Nothing needs your action right now.'
      : critical > 0
        ? `${critical} need you now${warning ? `, ${warning} more today` : ''}.`
        : `${items.length} action${items.length === 1 ? '' : 's'} on your radar.`;

  const byCat = (cat: string) =>
    items.filter((i) => i.category === cat || (cat === 'clients' && i.category === 'client'));
  const lens = (
    id: RankedMatterResult['lenses'][number]['id'],
    cat: string
  ): RankedMatterResult['lenses'][number] => {
    const group = byCat(cat);
    return {
      id,
      status: group.some((g) => g.severity === 'critical')
        ? 'ACTIVE'
        : group.length
          ? 'MONITORING'
          : 'CLEAR',
      summary:
        group[0]?.summary ||
        (group.length ? `${group.length} items in focus.` : 'Nothing pressing in this lens.'),
    };
  };

  return {
    pulse,
    brief: items.length
      ? `You have ${items.length} items ranked for attention. Start with: ${items[0].title}.`
      : null,
    items,
    lenses: [
      lens('delivery', 'delivery'),
      lens('people', 'people'),
      lens('clients', 'client'),
      lens('comms', 'comms'),
      lens('time', 'time'),
      {
        id: 'team',
        status: items.some((i) => i.category === 'people') ? 'MONITORING' : 'CLEAR',
        summary: items.some((i) => i.category === 'people')
          ? 'People/team signals present on your radar.'
          : 'No team heat right now.',
      },
    ],
  };
}

export async function rankMatterSignals(options: {
  config: AppConfig;
  profile: WelcomeProfile | null;
  signals: RawMatterSignal[];
  maxItems: number;
  sensitivity: MatterSensitivity;
}): Promise<RankedMatterResult> {
  const { config, profile, signals, maxItems, sensitivity } = options;
  if (signals.length === 0) {
    return heuristicRank([], profile, maxItems);
  }

  const softMax =
    sensitivity === 'calm'
      ? Math.min(maxItems, 12)
      : sensitivity === 'hyper'
        ? maxItems
        : Math.min(maxItems, 18);

  try {
    const creds = applyBackendManagedCredentials({
      provider: 'openai',
      apiKey: '',
      baseUrl: '',
    });
    const oneShotConfig: AppConfig = {
      ...config,
      model: MATTER_RANKER_MODEL,
      provider: 'openai',
      customProtocol: 'openai',
      baseUrl: creds.baseUrl || config.baseUrl,
      apiKey: creds.apiKey || config.apiKey,
    };
    const userPrompt = JSON.stringify(
      {
        maxItems: softMax,
        sensitivity,
        profile: profile
          ? {
              name: profile.name,
              email: profile.email,
              title: profile.title,
              function: profile.functionName,
              squad: profile.squad,
              department: profile.department,
            }
          : null,
        signals: signals.slice(0, 40).map((s) => ({
          fingerprint: s.fingerprint,
          source: s.source,
          title: s.title,
          summary: s.summary,
          raw: s.rawExcerpt?.slice(0, 500),
          severityHint: s.severityHint,
          orbitHint: s.orbitHint,
          categoryHint: s.categoryHint,
          sourceRef: s.sourceRef,
          dueAt: s.dueAt ?? s.occurredAt ?? null,
          expiresAt: s.expiresAt ?? null,
        })),
      },
      null,
      2
    );

    // No temperature / maxTokens — model defaults only.
    const result = await runPiAiOneShot(userPrompt, SYSTEM_PROMPT, oneShotConfig);

    const parsed = extractJsonObject(result.text) as {
      pulse?: unknown;
      brief?: unknown;
      items?: unknown;
      lenses?: unknown;
    };

    const known = new Map(signals.map((s) => [s.fingerprint, s]));
    const base = heuristicRank(signals, profile, softMax);
    const itemsRaw = Array.isArray(parsed.items) ? parsed.items : [];
    const llmByFp = new Map<string, Record<string, unknown>>();
    for (const raw of itemsRaw) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const fingerprint =
        typeof item.fingerprint === 'string' && item.fingerprint.trim()
          ? item.fingerprint.trim()
          : null;
      if (!fingerprint || !known.has(fingerprint)) continue;
      if (typeof item.title === 'string' && isRollupTitle(item.title)) continue;
      if (typeof item.title === 'string' && looksLikeJunkTitle(item.title)) continue;
      llmByFp.set(fingerprint, item);
    }

    // Overlay LLM ranking/why onto concrete heuristic items (never invent rollups).
    const items = base.items.map((baseItem) => {
      const item = llmByFp.get(baseItem.fingerprint);
      if (!item) return baseItem;
      const title =
        typeof item.title === 'string' &&
        item.title.trim() &&
        !isRollupTitle(item.title) &&
        !looksLikeJunkTitle(item.title)
          ? item.title.trim().slice(0, 120)
          : baseItem.title;
      const sourceRef =
        typeof item.sourceRef === 'object' && item.sourceRef !== null
          ? (item.sourceRef as MatterItem['sourceRef'])
          : baseItem.sourceRef;
      return {
        ...baseItem,
        title,
        summary:
          typeof item.summary === 'string' &&
          item.summary.trim() &&
          !looksLikeJunkTitle(item.summary)
            ? item.summary
            : baseItem.summary,
        whyItMatters:
          typeof item.whyItMatters === 'string' && item.whyItMatters.trim()
            ? item.whyItMatters
            : baseItem.whyItMatters,
        severity: item.severity != null ? asSeverity(item.severity) : baseItem.severity,
        orbit: item.orbit != null ? asOrbit(item.orbit) : baseItem.orbit,
        category: item.category != null ? asCategory(item.category) : baseItem.category,
        confidence:
          typeof item.confidence === 'number' && Number.isFinite(item.confidence)
            ? Math.max(0, Math.min(1, item.confidence))
            : baseItem.confidence,
        suggestedAction:
          typeof item.suggestedAction === 'string'
            ? item.suggestedAction
            : baseItem.suggestedAction,
        rankScore:
          typeof item.rankScore === 'number' && Number.isFinite(item.rankScore)
            ? item.rankScore
            : baseItem.rankScore,
        sourceRef,
        // Preserve collector-derived times; never let LLM override deadlines.
        dueAt: baseItem.dueAt,
        remindAt: baseItem.remindAt,
        expiresAt: baseItem.expiresAt,
      };
    });

    if (items.length === 0) {
      return heuristicRank(signals, profile, softMax);
    }

    const itemsWithRaw = attachRawFromSignals(
      items.sort((a, b) => b.rankScore - a.rankScore),
      signals
    );

    const lensesRaw = Array.isArray(parsed.lenses) ? parsed.lenses : [];
    const lenses = heuristicRank(signals, profile, softMax).lenses.map((fallback) => {
      const match = lensesRaw.find(
        (l) => typeof l === 'object' && l && (l as { id?: string }).id === fallback.id
      ) as { status?: string; summary?: string } | undefined;
      return {
        id: fallback.id,
        status:
          match?.status === 'ACTIVE' ||
          match?.status === 'MONITORING' ||
          match?.status === 'CLEAR' ||
          match?.status === 'COORDINATING'
            ? match.status
            : fallback.status,
        summary:
          typeof match?.summary === 'string' && match.summary.trim()
            ? match.summary.trim()
            : fallback.summary,
      };
    });

    return {
      pulse:
        typeof parsed.pulse === 'string' && parsed.pulse.trim()
          ? parsed.pulse.trim()
          : heuristicRank(signals, profile, softMax).pulse,
      brief: typeof parsed.brief === 'string' ? parsed.brief.trim() : null,
      items: itemsWithRaw,
      lenses,
    };
  } catch (error) {
    logWarn('[Matter] Ranker LLM failed, using heuristic:', error);
    return heuristicRank(signals, profile, softMax);
  }
}
