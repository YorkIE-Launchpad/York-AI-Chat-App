import {
  DEFAULT_MATTER_RUNTIME,
  DEFAULT_MATTER_SOURCE_PROMPTS,
  MATTER_SOURCE_IDS,
  MATTER_SOURCE_PROMPT_MAX_CHARS,
  type MatterRuntimeConfig,
  type MatterSourcePrompts,
} from '../../shared/matter';

export function normalizeMatterSourcePrompts(raw: unknown): MatterSourcePrompts {
  const input =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
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
    sensitivity:
      value.sensitivity === 'calm' ||
      value.sensitivity === 'hyper' ||
      value.sensitivity === 'balanced'
        ? value.sensitivity
        : 'balanced',
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
  };
}
