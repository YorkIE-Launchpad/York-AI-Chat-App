import type { AppConfig } from '../config/config-store';
import { resolveFreeModelForChild } from '../agent/free-model-resolve';
import { runPiAiOneShot } from '../agent/sdk-one-shot';
import { logWarn } from '../utils/logger';
import type { WelcomeProfile } from '../../shared/welcome-actions';
import type {
  MatterCategory,
  MatterItem,
  MatterOrbit,
  MatterSensitivity,
  MatterSeverity,
} from '../../shared/matter';
import type { RawMatterSignal } from './matter-collector';

const SYSTEM_PROMPT = `You are Matter Ranker for York IE VECOS — a personal operational intelligence engine.

Given the employee's Hub profile and raw signals from connected workplace tools, produce a ranked JSON list of what matters NOW.

Return ONLY valid JSON (no markdown):
{
  "pulse": "one short line about what needs attention",
  "brief": "2-3 sentence morning-style narrative",
  "items": [
    {
      "fingerprint": "MUST equal an input signal fingerprint exactly",
      "title": "prefer the signal title; shorten only if needed (<= 90 chars)",
      "summary": "one sentence about THIS specific item",
      "whyItMatters": "tie this one item to role/title/reporting/calendar pressure",
      "severity": "critical|warning|healthy|signal",
      "orbit": "now|today|week|watching",
      "category": "delivery|people|client|comms|time|admin",
      "source": "jira|slack|gmail|calendar|hub|meeting|launchpad|fused",
      "confidence": 0.0-1.0,
      "suggestedAction": "short next step for THIS item or null",
      "rankScore": 0-100,
      "sourceRef": { "externalId": "...", "url": null, "label": "..." },
      "expiresAt": null
    }
  ],
  "lenses": [
    {
      "id": "delivery|people|clients|comms|time|team",
      "status": "ACTIVE|MONITORING|CLEAR|COORDINATING",
      "summary": "1-2 sentences on this lens"
    }
  ]
}

Rules:
- ONE input signal = ONE output item. Never merge emails/events/messages into counts.
- FORBIDDEN titles: "N unread…", "N calendar events…", "threads that may need a reply", "messages need triage", or any count rollup.
- fingerprint MUST be copied exactly from an input signal. Do not invent fingerprints.
- Keep titles specific (subject line, event name, issue key, message preview).
- Only create items grounded in provided signals. Never invent finance drama or fake clients.
- Prefer fewer high-signal items over noise. Max items is provided.
- You may keep an existing fused signal if present; do not invent new rollups.
- critical = needs action before next meeting / blocker / manager escalation.
- warning = today pressure. healthy = good news / resolved. signal = awareness.
- Orbit: now (<2h or blocker), today, week, watching.
- whyItMatters must reference profile when possible (title, squad, manager/reports).
- If signals are empty, return empty items and a pulse explaining connectors are quiet or disconnected.`;

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('No JSON object in ranker response');
  }
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
      signal && (!item.title || isRollupTitle(item.title))
        ? signal.title.slice(0, 120)
        : item.title;
    const summary =
      signal && (!item.summary || isRollupTitle(item.summary)) ? signal.summary : item.summary;
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
  const items = signals
    .slice(0, maxItems)
    .map((s, index) => {
      const severity = s.severityHint || 'signal';
      return {
        fingerprint: s.fingerprint,
        title: s.title.slice(0, 90),
        summary: s.summary,
        whyItMatters:
          s.whyHint ||
          (profile?.title
            ? `Relevant to your role as ${profile.title}.`
            : 'Surfaced from your connected work tools.'),
        severity,
        orbit: s.orbitHint || (severity === 'critical' ? 'now' : 'today'),
        category: s.categoryHint || 'comms',
        source: s.source,
        confidence: 0.55,
        suggestedAction: s.suggestedAction || null,
        rankScore: severityBoost[severity] + Math.max(0, 20 - index),
        sourceRef: enrichSourceRef(s.sourceRef || {}, s.rawDetails || s.rawExcerpt),
        rawDetails: s.rawDetails || s.rawExcerpt || null,
        expiresAt: null,
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore);

  const critical = items.filter((i) => i.severity === 'critical').length;
  const warning = items.filter((i) => i.severity === 'warning').length;
  const pulse =
    items.length === 0
      ? 'Radar is clear — connectors quiet or still warming up.'
      : critical > 0
        ? `${critical} need you now${warning ? `, ${warning} warning` : ''}.`
        : `${items.length} signals on your radar.`;

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
    const free = await resolveFreeModelForChild({
      parent: {
        model: config.model,
        provider: config.provider,
        customProtocol: config.customProtocol,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        autoModelPreference: config.autoModelPreference,
      },
    });
    const oneShotConfig: AppConfig = {
      ...config,
      model: free.modelId,
      provider: free.provider as AppConfig['provider'],
      customProtocol: free.customProtocol,
      baseUrl: free.baseUrl || config.baseUrl,
      apiKey: free.apiKey || config.apiKey,
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
        })),
      },
      null,
      2
    );

    const result = await runPiAiOneShot(userPrompt, SYSTEM_PROMPT, oneShotConfig, {
      temperature: 0.2,
      maxTokens: 2500,
    });

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
      llmByFp.set(fingerprint, item);
    }

    // Overlay LLM ranking/why onto concrete heuristic items (never invent rollups).
    const items = base.items.map((baseItem) => {
      const item = llmByFp.get(baseItem.fingerprint);
      if (!item) return baseItem;
      const title =
        typeof item.title === 'string' && item.title.trim() && !isRollupTitle(item.title)
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
          typeof item.summary === 'string' && item.summary.trim() ? item.summary : baseItem.summary,
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
