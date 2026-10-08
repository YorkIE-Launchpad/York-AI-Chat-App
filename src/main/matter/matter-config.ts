import {
  DEFAULT_MATTER_OPPORTUNITIES,
  DEFAULT_MATTER_RUNTIME,
  DEFAULT_MATTER_SOURCE_PROMPTS,
  MATTER_SOURCE_IDS,
  MATTER_SOURCE_PROMPT_MAX_CHARS,
  OPPORTUNITY_TARGETS,
  type MatterOpportunitiesConfig,
  type MatterRuntimeConfig,
  type MatterSourcePrompts,
  type OpportunityRoute,
  type OpportunityTarget,
} from '../../shared/matter';

const ROUTE_VALUE_MAX_CHARS = 120;

function normalizeRouteValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, ROUTE_VALUE_MAX_CHARS);
  return trimmed || undefined;
}

export function normalizeMatterOpportunitiesConfig(raw: unknown): MatterOpportunitiesConfig {
  const value =
    typeof raw === 'object' && raw !== null ? (raw as Partial<MatterOpportunitiesConfig>) : {};
  const routingIn =
    typeof value.routing === 'object' && value.routing !== null
      ? (value.routing as Partial<Record<OpportunityTarget, OpportunityRoute>>)
      : {};
  const routing = {} as Record<OpportunityTarget, OpportunityRoute>;
  for (const target of OPPORTUNITY_TARGETS) {
    const route = routingIn[target];
    const slackChannel = normalizeRouteValue(route?.slackChannel);
    const slackUserId = normalizeRouteValue(route?.slackUserId);
    routing[target] = {
      ...(slackChannel ? { slackChannel } : {}),
      ...(slackUserId ? { slackUserId } : {}),
    };
  }
  return {
    enabled: value.enabled !== false,
    minConfidence:
      typeof value.minConfidence === 'number' && Number.isFinite(value.minConfidence)
        ? Math.max(0, Math.min(1, Math.round(value.minConfidence * 100) / 100))
        : DEFAULT_MATTER_OPPORTUNITIES.minConfidence,
    notify: value.notify !== false,
    routing,
  };
}

export function normalizeMatterSourcePrompts(raw: unknown): MatterSourcePrompts {
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: MatterSourcePrompts = { ...DEFAULT_MATTER_SOURCE_PROMPTS };
  for (const key of MATTER_SOURCE_IDS) {
    const value = input[key];
    if (typeof value !== 'string') continue;
    out[key] = value.trim().slice(0, MATTER_SOURCE_PROMPT_MAX_CHARS);
  }
  return out;
}

export function normalizeMatterRuntimeConfig(raw: unknown): MatterRuntimeConfig {
  const value =
    typeof raw === 'object' && raw !== null ? (raw as Partial<MatterRuntimeConfig>) : {};
  const sourcesIn =
    typeof value.sources === 'object' && value.sources !== null
      ? (value.sources as Partial<MatterRuntimeConfig['sources']>)
      : {};
  const clampHour = (n: unknown, fallback: number) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(23, Math.round(n)));
  };
  return {
    enabled: value.enabled !== false,
    windowStartHour: clampHour(value.windowStartHour, DEFAULT_MATTER_RUNTIME.windowStartHour),
    windowEndHour: clampHour(value.windowEndHour, DEFAULT_MATTER_RUNTIME.windowEndHour),
    intervalMinutes:
      typeof value.intervalMinutes === 'number' && Number.isFinite(value.intervalMinutes)
        ? Math.max(15, Math.min(240, Math.round(value.intervalMinutes)))
        : DEFAULT_MATTER_RUNTIME.intervalMinutes,
    meetingsIntervalMinutes:
      typeof value.meetingsIntervalMinutes === 'number' &&
      Number.isFinite(value.meetingsIntervalMinutes)
        ? Math.max(5, Math.min(240, Math.round(value.meetingsIntervalMinutes)))
        : DEFAULT_MATTER_RUNTIME.meetingsIntervalMinutes,
    sensitivity:
      value.sensitivity === 'calm' ||
      value.sensitivity === 'hyper' ||
      value.sensitivity === 'balanced'
        ? value.sensitivity
        : 'balanced',
    minConfidence:
      typeof value.minConfidence === 'number' && Number.isFinite(value.minConfidence)
        ? Math.max(0, Math.min(1, Math.round(value.minConfidence * 100) / 100))
        : DEFAULT_MATTER_RUNTIME.minConfidence,
    maxActiveItems:
      typeof value.maxActiveItems === 'number' && Number.isFinite(value.maxActiveItems)
        ? Math.max(5, Math.min(80, Math.round(value.maxActiveItems)))
        : DEFAULT_MATTER_RUNTIME.maxActiveItems,
    morningBriefEnabled: value.morningBriefEnabled !== false,
    endOfDayWrapEnabled: value.endOfDayWrapEnabled === true,
    autoOpenOnLaunch: value.autoOpenOnLaunch === true,
    sources: {
      calendar: sourcesIn.calendar !== false,
      slack: sourcesIn.slack !== false,
      gmail: sourcesIn.gmail !== false,
      jira: sourcesIn.jira !== false,
      hub: sourcesIn.hub !== false,
      meeting: sourcesIn.meeting !== false,
      launchpad: sourcesIn.launchpad !== false,
    },
    sourcePrompts: normalizeMatterSourcePrompts(value.sourcePrompts),
    opportunities: normalizeMatterOpportunitiesConfig(value.opportunities),
  };
}
