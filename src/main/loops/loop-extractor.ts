/**
 * Loop extraction — turns meeting action items and Matter signals into loop candidates.
 */
import { MemoryLLMClient, type MemoryLLMClientLike } from '../memory/memory-llm-client';
import type { MeetingSession } from '../meetings/meeting-types';
import type { MatterItem } from '../../shared/matter';
import type { LoopOwner, LoopsRuntimeConfig } from '../../shared/loops';
import type { WelcomeProfile } from '../../shared/welcome-actions';
import { meetingActionFingerprint } from '../matter/matter-collector';
import { logWarn } from '../utils/logger';
import type { LoopUpsertInput } from './loop-store';

interface ActionClassification {
  owner: LoopOwner;
  counterpart: string | null;
  dueAt: number | null;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function parseDue(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * One LLM call classifies every action item: is it mine or am I waiting on someone,
 * who is the counterpart, and is there an explicit deadline. Falls back to `me`.
 */
export async function classifyMeetingActions(
  meeting: MeetingSession,
  actions: string[],
  profile: WelcomeProfile | null,
  llm: MemoryLLMClientLike = new MemoryLLMClient()
): Promise<ActionClassification[]> {
  const fallback = actions.map<ActionClassification>(() => ({
    owner: 'me',
    counterpart: null,
    dueAt: null,
  }));
  if (actions.length === 0) return fallback;
  try {
    const response = await llm.complete({
      systemPrompt: [
        'You classify meeting action items for one user.',
        'For each item decide owner: "me" if the user must do it (or it is unassigned), "other" if someone else owes it to the user.',
        'counterpart: the other person named in the item, or null.',
        'due: ISO 8601 datetime only if the item states an explicit deadline, else null. Resolve relative dates against the meeting date.',
        'Return ONLY JSON: {"items":[{"index":0,"owner":"me","counterpart":null,"due":null}]}.',
      ].join(' '),
      userPrompt: JSON.stringify({
        user: profile ? { name: profile.name, email: profile.email } : null,
        meetingTitle: meeting.title,
        meetingDate: new Date(meeting.startedAt).toISOString(),
        attendees: meeting.attendees || [],
        items: actions.map((text, index) => ({ index, text })),
      }),
      temperature: 0,
    });
    const parsed = extractJsonObject(response.text);
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    const out = [...fallback];
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const index = typeof item.index === 'number' ? item.index : -1;
      if (index < 0 || index >= out.length) continue;
      out[index] = {
        owner: item.owner === 'other' ? 'other' : 'me',
        counterpart:
          typeof item.counterpart === 'string' && item.counterpart.trim()
            ? item.counterpart.trim()
            : null,
        dueAt: parseDue(item.due),
      };
    }
    return out;
  } catch (error) {
    logWarn('[Loops] Action classification failed; defaulting owner to me', error);
    return fallback;
  }
}

export async function extractMeetingLoops(
  meeting: MeetingSession,
  profile: WelcomeProfile | null,
  llm?: MemoryLLMClientLike
): Promise<LoopUpsertInput[]> {
  const actions = (meeting.notes?.actionItems || []).map((a) => String(a).trim()).filter(Boolean);
  if (actions.length === 0) return [];
  const classified = await classifyMeetingActions(meeting, actions, profile, llm);
  return actions.map((text, i) => ({
    fingerprint: meetingActionFingerprint(meeting.id, text),
    title: text,
    notes: null,
    origin: 'meeting',
    sourceRef: { meetingId: meeting.id, label: meeting.title || 'Meeting' },
    owner: classified[i].owner,
    counterpart: classified[i].counterpart,
    dueAt: classified[i].dueAt,
    autoCaptured: true,
  }));
}

export function matterItemToLoop(item: MatterItem, autoCaptured: boolean): LoopUpsertInput {
  const meetingId = item.source === 'meeting' ? item.sourceRef.externalId || null : null;
  return {
    fingerprint: item.fingerprint,
    title: item.title,
    notes: item.suggestedAction || item.summary || null,
    origin: item.source === 'meeting' ? 'meeting' : 'matter',
    sourceRef: {
      matterItemId: item.id,
      meetingId,
      url: item.sourceRef.url || null,
      label: item.sourceRef.label || null,
    },
    owner: 'me',
    dueAt: item.dueAt,
    priority: item.severity === 'critical' ? 'high' : 'normal',
    autoCaptured,
  };
}

/** Matter items worth auto-tracking as loops after a scan. */
export function selectMatterLoopCandidates(
  items: MatterItem[],
  runtime: LoopsRuntimeConfig
): MatterItem[] {
  return items.filter((item) => {
    if (item.status !== 'active' && item.status !== 'resurfaced') return false;
    if (item.source === 'meeting') return true;
    return (
      Boolean(item.suggestedAction?.trim()) &&
      (item.orbit === 'now' || item.orbit === 'today') &&
      item.confidence >= runtime.matterConfidenceThreshold
    );
  });
}
