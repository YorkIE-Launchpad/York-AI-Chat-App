import { DEFAULT_MATTER_RUNTIME, type MatterRuntimeConfig } from '../../shared/matter';

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
        ? Math.max(5, Math.min(50, Math.round(value.maxActiveItems)))
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
      drive: sourcesIn.drive !== false,
      launchpad: sourcesIn.launchpad !== false,
    },
  };
}
