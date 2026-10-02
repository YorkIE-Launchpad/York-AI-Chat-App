/**
 * First-party chat tools for Loops (persistent commitments).
 */
import { Type } from '@sinclair/typebox';
import type { AgentRuntimeCustomTool } from '../extensions/agent-runtime-extension';
import type { LoopService } from './loop-service';
import { isLoopDue, loopDueBucket, type Loop } from '../../shared/loops';

function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: undefined,
  };
}

function clip(text: string | null | undefined, max: number): string {
  const value = (text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function whenIso(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  return new Date(ms).toISOString();
}

export function formatLoop(loop: Loop, detailed = false): string {
  const lines = [
    `- id: ${loop.id}`,
    `  title: ${loop.title}`,
    `  status: ${loop.status}`,
    `  owner: ${loop.owner}`,
    `  priority: ${loop.priority}`,
    `  origin: ${loop.origin}`,
    `  due: ${loop.dueAt ? `${whenIso(loop.dueAt)} (${loopDueBucket(loop.dueAt)})` : 'none'}`,
    `  dueNow: ${isLoopDue(loop)}`,
  ];
  if (loop.counterpart) lines.push(`  counterpart: ${loop.counterpart}`);
  if (loop.notes) lines.push(`  notes: ${clip(loop.notes, detailed ? 1200 : 280)}`);
  lines.push(`  researchStatus: ${loop.researchStatus}`);
  if (detailed && loop.researchNote) {
    lines.push(`  researchNote: ${clip(loop.researchNote, 4000)}`);
  } else if (loop.researchNote) {
    lines.push(`  researchNote: ${clip(loop.researchNote, 280)}`);
  }
  if (loop.researchError) lines.push(`  researchError: ${clip(loop.researchError, 240)}`);
  if (loop.sourceRef.matterItemId) lines.push(`  matterItemId: ${loop.sourceRef.matterItemId}`);
  if (loop.sourceRef.meetingId) lines.push(`  meetingId: ${loop.sourceRef.meetingId}`);
  if (loop.sourceRef.url) lines.push(`  url: ${loop.sourceRef.url}`);
  return lines.join('\n');
}

const RESEARCH_WAIT_MS = 20_000;
const RESEARCH_POLL_MS = 400;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createLoopTools(loopService: LoopService): AgentRuntimeCustomTool[] {
  const listTool: AgentRuntimeCustomTool = {
    name: 'loop_list',
    label: 'loop_list',
    description:
      'List persistent Loops (commitments that stay until closed). Default is open loops. Use this for "open loops", "what did I commit to", or "what am I waiting on".',
    parameters: Type.Object({
      status: Type.Optional(
        Type.String({ description: 'open (default), done, dropped, ignored, or all.' })
      ),
      owner: Type.Optional(Type.String({ description: 'me or other (waiting on someone).' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
    }),
    async execute(_toolCallId, params) {
      const status = String((params as { status?: string }).status || 'open')
        .trim()
        .toLowerCase();
      const owner = String((params as { owner?: string }).owner || '')
        .trim()
        .toLowerCase();
      const limit = (params as { limit?: number }).limit ?? 20;
      const snapshot = loopService.getSnapshot();
      const loops = snapshot.loops
        .filter((loop) => (status === 'all' ? true : loop.status === status))
        .filter((loop) => (owner ? loop.owner === owner : true))
        .slice(0, limit);
      if (!loops.length) {
        return textResult(`No loops matched (status=${status}${owner ? `, owner=${owner}` : ''}).`);
      }
      return textResult(
        [
          `dueCount: ${snapshot.dueCount}`,
          `showing: ${loops.length}`,
          '',
          ...loops.map((loop) => formatLoop(loop)),
        ].join('\n')
      );
    },
  };

  const readTool: AgentRuntimeCustomTool = {
    name: 'loop_read',
    label: 'loop_read',
    description: 'Read one Loop by id, including its research note and sources when present.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: 'Loop id from loop_list.' }),
    }),
    async execute(_toolCallId, params) {
      const id = String((params as { id?: string }).id || '');
      const loop = loopService.getSnapshot().loops.find((entry) => entry.id === id);
      if (!loop) return textResult(`Loop not found: ${id}`);
      const sources = loop.researchSources
        .map(
          (source) =>
            `- [${source.id}] ${source.source}: ${source.title}${source.url ? ` ${source.url}` : ''}`
        )
        .join('\n');
      const body = formatLoop(loop, true);
      return textResult(sources ? `${body}\n  sources:\n${sources}` : body);
    },
  };

  const createTool: AgentRuntimeCustomTool = {
    name: 'loop_create',
    label: 'loop_create',
    description:
      'Create a Loop the user owns (a commitment to track). Asks before running. Set research=false to skip the source sweep.',
    parameters: Type.Object({
      title: Type.String({ minLength: 1, description: 'What was committed.' }),
      notes: Type.Optional(Type.String()),
      owner: Type.Optional(Type.String({ description: 'me (default) or other.' })),
      counterpart: Type.Optional(Type.String({ description: 'Person this loop is with.' })),
      dueAt: Type.Optional(Type.Number({ description: 'Due time as epoch milliseconds.' })),
      priority: Type.Optional(Type.String({ description: 'high, normal, or low.' })),
      research: Type.Optional(
        Type.Boolean({ description: 'Sweep sources after create. Default true.' })
      ),
    }),
    async execute(_toolCallId, params) {
      const input = params as {
        title?: string;
        notes?: string;
        owner?: string;
        counterpart?: string;
        dueAt?: number;
        priority?: string;
        research?: boolean;
      };
      const owner = input.owner === 'other' ? 'other' : 'me';
      const priority =
        input.priority === 'high' || input.priority === 'low' ? input.priority : 'normal';
      try {
        const snapshot = loopService.create({
          title: String(input.title || ''),
          notes: input.notes,
          owner,
          counterpart: input.counterpart,
          dueAt: input.dueAt,
          priority,
          research: input.research,
        });
        const created = [...snapshot.loops].sort((a, b) => b.createdAt - a.createdAt)[0];
        return textResult(created ? `Created loop.\n\n${formatLoop(created)}` : 'Created loop.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`Could not create loop: ${message}`);
      }
    },
  };

  const closeTool: AgentRuntimeCustomTool = {
    name: 'loop_close',
    label: 'loop_close',
    description: 'Mark a Loop done. Asks before running.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: 'Loop id from loop_list.' }),
    }),
    async execute(_toolCallId, params) {
      const id = String((params as { id?: string }).id || '');
      loopService.close(id);
      return textResult(`Closed loop ${id}.`);
    },
  };

  const dropTool: AgentRuntimeCustomTool = {
    name: 'loop_drop',
    label: 'loop_drop',
    description: 'Drop a Loop (no longer tracking it). Asks before running.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: 'Loop id from loop_list.' }),
    }),
    async execute(_toolCallId, params) {
      const id = String((params as { id?: string }).id || '');
      loopService.drop(id);
      return textResult(`Dropped loop ${id}.`);
    },
  };

  const researchTool: AgentRuntimeCustomTool = {
    name: 'loop_research',
    label: 'loop_research',
    description:
      'Sweep connected sources for context on one Loop and store a cited research note. Returns the note when it finishes within a short wait.',
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: 'Loop id from loop_list.' }),
    }),
    async execute(_toolCallId, params) {
      const id = String((params as { id?: string }).id || '');
      try {
        loopService.research(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`Loop research failed: ${message}`);
      }
      const deadline = Date.now() + RESEARCH_WAIT_MS;
      let loop = loopService.getSnapshot().loops.find((entry) => entry.id === id);
      while (loop && loop.researchStatus === 'running' && Date.now() < deadline) {
        await delay(RESEARCH_POLL_MS);
        loop = loopService.getSnapshot().loops.find((entry) => entry.id === id);
      }
      if (!loop) return textResult(`Loop not found: ${id}`);
      if (loop.researchStatus === 'running') {
        return textResult(
          `Research still running for ${id}. Call loop_read in a moment.\n\n${formatLoop(loop, true)}`
        );
      }
      return textResult(formatLoop(loop, true));
    },
  };

  return [listTool, readTool, createTool, closeTool, dropTool, researchTool];
}
