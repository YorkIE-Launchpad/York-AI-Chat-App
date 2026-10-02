/**
 * Employee source-prompt overrides from Matter settings.
 * Shared by the LLM ranker and the Jev keep/rank path.
 */
import {
  MATTER_SOURCE_IDS,
  type MatterConfigurableSource,
  type MatterSource,
  type MatterSourcePrompts,
} from '../../shared/matter';

const SOURCE_PROMPT_LABELS: Record<MatterConfigurableSource, string> = {
  calendar: 'Google Calendar',
  slack: 'Slack',
  gmail: 'Gmail',
  jira: 'Jira',
  hub: 'York Hub',
  meeting: 'Meetings',
  launchpad: 'R&D Launchpad',
};

/**
 * Lines for non-empty overrides. When `sourcesInPool` is set, only sources in
 * that pool are included so unused prompts are not applied.
 */
export function formatMatterSourceOverrides(
  sourcePrompts?: MatterSourcePrompts | null,
  sourcesInPool?: Iterable<MatterSource>
): string {
  const present = sourcesInPool ? new Set(sourcesInPool) : null;
  const lines: string[] = [];
  for (const key of MATTER_SOURCE_IDS) {
    const text = sourcePrompts?.[key]?.trim();
    if (!text) continue;
    if (present && !present.has(key)) continue;
    lines.push(`- ${SOURCE_PROMPT_LABELS[key]}: ${text}`);
  }
  return lines.join('\n');
}
