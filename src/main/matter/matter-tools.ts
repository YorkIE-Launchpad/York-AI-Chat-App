/**
 * First-party chat tools for Matter (operational radar + calendar meetings).
 */
import { Type } from '@sinclair/typebox';
import type { AgentRuntimeCustomTool } from '../extensions/agent-runtime-extension';
import type { MatterService } from './matter-service';
import type { MatterItem, MatterMeeting, MatterSnapshot } from '../../shared/matter';

function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined,
  };
}

function clip(text: string | null | undefined, max: number): string {
  const value = (text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function whenIso(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  return new Date(ms).toISOString();
}

export function formatMatterSignal(item: MatterItem, detailed = false): string {
  const lines = [
    `- id: ${item.id}`,
    `  title: ${item.title}`,
    `  severity: ${item.severity}`,
    `  orbit: ${item.orbit}`,
    `  category: ${item.category}`,
    `  source: ${item.source}`,
    `  status: ${item.status}`,
    `  summary: ${clip(item.summary, detailed ? 1200 : 280)}`,
  ];
  if (item.whyItMatters) lines.push(`  why: ${clip(item.whyItMatters, detailed ? 800 : 200)}`);
  if (item.suggestedAction) lines.push(`  suggestedAction: ${clip(item.suggestedAction, 240)}`);
  if (item.dueAt) lines.push(`  dueAt: ${whenIso(item.dueAt)}`);
  if (item.sourceRef.url) lines.push(`  url: ${item.sourceRef.url}`);
  if (detailed && item.rawDetails) {
    lines.push(`  rawDetails: ${clip(item.rawDetails, 4000)}`);
  }
  return lines.join('\n');
}

export function formatMatterMeeting(meeting: MatterMeeting, detailed = false): string {
  const lines = [
    `- id: ${meeting.id}`,
    `  title: ${meeting.title}`,
    `  when: ${meeting.when}`,
    meeting.startMs ? `  start: ${whenIso(meeting.startMs)}` : '',
    `  summary: ${clip(meeting.summary, detailed ? 800 : 240)}`,
  ].filter(Boolean);
  if (meeting.htmlLink) lines.push(`  url: ${meeting.htmlLink}`);
  if (detailed && meeting.rawDetails) {
    lines.push(`  details: ${clip(meeting.rawDetails, 6000)}`);
  }
  return lines.join('\n');
}

export function formatMatterList(snapshot: MatterSnapshot, limit: number): string {
  const items = snapshot.items.slice(0, limit);
  const header = [
    `pulse: ${snapshot.pulse}`,
    `focusScore: ${snapshot.focusScore}`,
    `critical: ${snapshot.criticalCount}  warning: ${snapshot.warningCount}`,
    `scanning: ${snapshot.scanning}`,
    snapshot.lastScan
      ? `lastScan: ${snapshot.lastScan.status} at ${whenIso(snapshot.lastScan.finishedAt ?? snapshot.lastScan.startedAt)}`
      : 'lastScan: none',
  ];
  if (!items.length) {
    return [...header, '', 'No active Matter signals.'].join('\n');
  }
  return [
    ...header,
    '',
    `Signals (${items.length}${snapshot.items.length > items.length ? ` of ${snapshot.items.length}` : ''}):`,
    ...items.map((item) => formatMatterSignal(item)),
  ].join('\n\n');
}

export function createMatterTools(matterService: MatterService): AgentRuntimeCustomTool[] {
  const listTool: AgentRuntimeCustomTool = {
    name: 'matter_list',
    label: 'matter_list',
    description:
      'List the current Matter radar: pulse, focus score, and active signals (what needs attention now). Prefer this over re-scanning connectors for "what matters" / "what\'s on my plate".',
    parameters: Type.Object({
      orbit: Type.Optional(
        Type.String({ description: 'Filter to now, today, week, or watching.' })
      ),
      severity: Type.Optional(
        Type.String({ description: 'Filter to critical, warning, healthy, or signal.' })
      ),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    }),
    async execute(_toolCallId, params) {
      const orbit = String((params as { orbit?: string }).orbit || '')
        .trim()
        .toLowerCase();
      const severity = String((params as { severity?: string }).severity || '')
        .trim()
        .toLowerCase();
      const limit = (params as { limit?: number }).limit ?? 15;
      const snapshot = matterService.getSnapshot();
      const filtered: MatterSnapshot = {
        ...snapshot,
        items: snapshot.items.filter((item) => {
          if (orbit && item.orbit !== orbit) return false;
          if (severity && item.severity !== severity) return false;
          return true;
        }),
      };
      return textResult(formatMatterList(filtered, limit));
    },
  };

  const readTool: AgentRuntimeCustomTool = {
    name: 'matter_read',
    label: 'matter_read',
    description: 'Read one Matter signal by id from matter_list, including raw source details.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: 'Signal id from matter_list.' }),
    }),
    async execute(_toolCallId, params) {
      const id = String((params as { id?: string }).id || '');
      const item = matterService.getSnapshot().items.find((entry) => entry.id === id);
      if (!item) {
        return textResult(`Matter signal not found: ${id}`);
      }
      return textResult(formatMatterSignal(item, true));
    },
  };

  const meetingsTool: AgentRuntimeCustomTool = {
    name: 'matter_meetings',
    label: 'matter_meetings',
    description:
      'List upcoming calendar meetings already collected on the Matter page (title, when, summary). Use matter_meeting for the prep note.',
    parameters: Type.Object({
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params) {
      const limit = (params as { limit?: number }).limit ?? 10;
      const meetings = matterService.getSnapshot().meetings.slice(0, limit);
      if (!meetings.length) {
        return textResult('No upcoming Matter calendar meetings.');
      }
      return textResult(meetings.map((meeting) => formatMatterMeeting(meeting)).join('\n\n'));
    },
  };

  const meetingTool: AgentRuntimeCustomTool = {
    name: 'matter_meeting',
    label: 'matter_meeting',
    description:
      'Read one Matter calendar meeting by id, including the prep note when one has been generated.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: 'Meeting id from matter_meetings.' }),
    }),
    async execute(_toolCallId, params) {
      const id = String((params as { id?: string }).id || '');
      const meeting = matterService.getSnapshot().meetings.find((entry) => entry.id === id);
      if (!meeting) {
        return textResult(`Matter meeting not found: ${id}`);
      }
      return textResult(formatMatterMeeting(meeting, true));
    },
  };

  const prepTool: AgentRuntimeCustomTool = {
    name: 'matter_prep',
    label: 'matter_prep',
    description:
      'Generate a meeting prep brief for a Matter calendar meeting id and store it on that meeting. Asks before running.',
    parameters: Type.Object({
      meetingId: Type.String({ minLength: 1, description: 'Meeting id from matter_meetings.' }),
    }),
    async execute(_toolCallId, params) {
      const meetingId = String((params as { meetingId?: string }).meetingId || '');
      try {
        const snapshot = await matterService.prepMeeting(meetingId);
        const meeting = snapshot.meetings.find((entry) => entry.id === meetingId);
        if (!meeting) return textResult('Prep finished, but the meeting was not in the snapshot.');
        return textResult(formatMatterMeeting(meeting, true));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`Matter prep failed: ${message}`);
      }
    },
  };

  const scanTool: AgentRuntimeCustomTool = {
    name: 'matter_scan',
    label: 'matter_scan',
    description:
      'Refresh the Matter radar now by collecting connected sources and re-ranking signals. Asks before running. Use matter_list when the current radar is enough.',
    parameters: Type.Object({}),
    async execute() {
      try {
        const snapshot = await matterService.runScan({
          reason: 'manual',
          notify: false,
          force: true,
        });
        return textResult(formatMatterList(snapshot, 15));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`Matter scan failed: ${message}`);
      }
    },
  };

  const actTool: AgentRuntimeCustomTool = {
    name: 'matter_act',
    label: 'matter_act',
    description:
      'Update a Matter signal: done, dismiss, snooze, pin, or unpin. Asks before running.',
    parameters: Type.Object({
      itemId: Type.String({ minLength: 1, description: 'Signal id from matter_list.' }),
      action: Type.String({ description: 'done, dismiss, snooze, pin, or unpin.' }),
      snoozeUntil: Type.Optional(
        Type.Number({ description: 'Epoch ms to snooze until. Defaults to 24 hours.' })
      ),
    }),
    async execute(_toolCallId, params) {
      const itemId = String((params as { itemId?: string }).itemId || '');
      const action = String((params as { action?: string }).action || '')
        .trim()
        .toLowerCase();
      const allowed = new Set(['done', 'dismiss', 'snooze', 'pin', 'unpin']);
      if (!allowed.has(action)) {
        return textResult(`Unsupported Matter action: ${action}`);
      }
      if (!matterService.getSnapshot().items.some((entry) => entry.id === itemId)) {
        return textResult(`Matter signal not found: ${itemId}`);
      }
      const snoozeUntil = (params as { snoozeUntil?: number }).snoozeUntil;
      const snapshot = matterService.applyItemAction({
        itemId,
        action: action as 'done' | 'dismiss' | 'snooze' | 'pin' | 'unpin',
        snoozeUntil,
      });
      const stillVisible = snapshot.items.find((entry) => entry.id === itemId);
      return textResult(
        stillVisible
          ? `Updated ${itemId} (${action}).\n\n${formatMatterSignal(stillVisible)}`
          : `Updated ${itemId} (${action}). It is no longer on the active radar.`
      );
    },
  };

  return [listTool, readTool, meetingsTool, meetingTool, prepTool, scanTool, actTool];
}
