/**
 * SuperContext — budgeted pre-turn local scout (wiki / Matter / meetings).
 */
import {
  DEFAULT_SUPER_CONTEXT_MODE,
  SUPER_CONTEXT_CHAR_BUDGET,
  SUPER_CONTEXT_SCOUT_TIMEOUT_MS,
  isBriefLikeIntent,
  type SuperContextMode,
} from '../../shared/supercontext';
import { configStore } from '../config/config-store';
import type { MatterService } from '../matter/matter-service';
import type { MeetingService } from '../meetings/meeting-service';
import type { WikiService } from '../wiki/wiki-service';
import { logWarn } from '../utils/logger';

export interface SuperContextScoutInput {
  prompt: string;
  isColdStart: boolean;
  mode?: SuperContextMode;
}

export interface SuperContextDependencies {
  wikiService: WikiService | null;
  matterService: MatterService | null;
  meetingService: MeetingService | null;
}

function trimBudget(text: string, budget = SUPER_CONTEXT_CHAR_BUDGET): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget - 20).trim()}\n…[truncated]`;
}

export function getSuperContextMode(): SuperContextMode {
  const raw = configStore.getAll().superContextMode;
  if (raw === 'off' || raw === 'always' || raw === 'cold_intent') {
    return raw;
  }
  return DEFAULT_SUPER_CONTEXT_MODE;
}

export function shouldRunSuperContext(
  input: SuperContextScoutInput,
  mode: SuperContextMode = getSuperContextMode()
): boolean {
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  // cold_intent (default)
  return input.isColdStart || isBriefLikeIntent(input.prompt);
}

export async function buildSuperContextPrefix(
  input: SuperContextScoutInput,
  deps: SuperContextDependencies
): Promise<string | undefined> {
  if (!shouldRunSuperContext(input)) {
    return undefined;
  }

  const start = Date.now();
  const query = input.prompt.trim().slice(0, 200) || 'status';
  const sections: string[] = ['[SuperContext scout — local sources only]'];

  try {
    if (deps.wikiService) {
      const hits = deps.wikiService.search(query, 5);
      if (hits.length) {
        sections.push('## Wiki');
        for (const hit of hits) {
          sections.push(`- ${hit.path}: ${hit.title} — ${hit.excerpt}`);
        }
      } else {
        const top = deps.wikiService.list(5);
        if (top.length) {
          sections.push('## Wiki (recent)');
          for (const page of top) {
            sections.push(`- ${page.path}: ${page.title}`);
          }
        }
      }
    }

    if (deps.matterService) {
      const snapshot = deps.matterService.getSnapshot();
      const items = snapshot.items
        .filter((i) => i.severity === 'critical' || i.severity === 'warning' || i.orbit === 'now')
        .slice(0, 6);
      if (items.length || snapshot.pulse) {
        sections.push('## Matter');
        sections.push(`Pulse: ${snapshot.pulse}`);
        for (const item of items) {
          sections.push(
            `- [${item.severity}] ${item.title} — ${item.summary.slice(0, 160)}`
          );
        }
      }
    }

    if (deps.meetingService && deps.meetingService.isChatReferenceAllowed()) {
      const meetings = deps.meetingService.search(query, 4);
      const todayKey = new Date().toISOString().slice(0, 10);
      const listed = meetings.length ? meetings : deps.meetingService.list();
      const todayish = listed
        .filter((m) => {
          const day = new Date(m.startedAt).toISOString().slice(0, 10);
          return day === todayKey || meetings.some((x) => x.id === m.id);
        })
        .slice(0, 4);

      if (todayish.length) {
        sections.push('## Meetings');
        for (const m of todayish) {
          sections.push(
            `- ${m.title} (${new Date(m.startedAt).toISOString().slice(0, 10)}): ${m.summary || '(no summary)'}`
          );
        }
      }
    }
  } catch (error) {
    logWarn('[SuperContext] Scout failed', error);
    return undefined;
  }

  if (sections.length <= 1) {
    return undefined;
  }

  const elapsed = Date.now() - start;
  if (elapsed > SUPER_CONTEXT_SCOUT_TIMEOUT_MS) {
    logWarn(`[SuperContext] Scout exceeded budget (${elapsed}ms)`);
  }
  sections.push(`(scout ${elapsed}ms)`);
  return trimBudget(sections.join('\n'));
}
