import { describe, expect, it, vi } from 'vitest';
import type { Loop } from '../../shared/loops';
import { createLoopTools } from '../../main/loops/loop-tools';
import type { LoopService } from '../../main/loops/loop-service';

function loop(partial: Partial<Loop> = {}): Loop {
  return {
    id: 'loop-1',
    fingerprint: 'fp',
    title: 'Send the proposal',
    notes: 'Promised in standup',
    researchNote: null,
    researchSources: [],
    researchStatus: 'idle',
    researchError: null,
    researchedAt: null,
    origin: 'manual',
    sourceRef: {},
    owner: 'me',
    counterpart: 'Ava',
    dueAt: null,
    priority: 'high',
    status: 'open',
    autoCaptured: false,
    createdAt: 10,
    updatedAt: 10,
    closedAt: null,
    ...partial,
  };
}

function service(loops: Loop[], extra: Partial<LoopService> = {}): LoopService {
  return {
    getSnapshot: () => ({
      loops,
      dueCount: 0,
      settings: {
        captureFromMeetings: true,
        captureFromMatter: true,
        matterConfidenceThreshold: 0.7,
        screenedVersion: 0,
        capturePrompt: '',
      },
    }),
    ...extra,
  } as unknown as LoopService;
}

async function run(
  tool: ReturnType<typeof createLoopTools>[number],
  params: Record<string, unknown>
): Promise<string> {
  const result = await (
    tool.execute as (...args: unknown[]) => Promise<{ content: Array<{ text?: string }> }>
  )('1', params);
  return result.content[0]?.text || '';
}

describe('loop tools', () => {
  it('lists open loops and reads one', async () => {
    const tools = createLoopTools(
      service([loop(), loop({ id: 'loop-2', status: 'done', title: 'Old' })])
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      'loop_list',
      'loop_read',
      'loop_create',
      'loop_close',
      'loop_drop',
      'loop_research',
    ]);
    const listed = await run(tools[0], {});
    expect(listed).toContain('Send the proposal');
    expect(listed).not.toContain('Old');
    const read = await run(tools[1], { id: 'loop-1' });
    expect(read).toContain('Ava');
    expect(read).toContain('Promised in standup');
  });

  it('creates and closes a loop', async () => {
    const created = loop({ id: 'loop-new', title: 'Call Raj', createdAt: 50 });
    const create = vi.fn(() => ({
      loops: [loop(), created],
      dueCount: 0,
      settings: {} as never,
    }));
    const close = vi.fn();
    const tools = createLoopTools(service([loop()], { create, close } as never));
    const text = await run(tools[2], { title: 'Call Raj', owner: 'me' });
    expect(create).toHaveBeenCalled();
    expect(text).toContain('loop-new');
    await run(tools[3], { id: 'loop-1' });
    expect(close).toHaveBeenCalledWith('loop-1');
  });

  it('returns a finished research note without waiting', async () => {
    const researched = loop({
      researchStatus: 'done',
      researchNote: 'Ava confirmed Friday.',
    });
    const research = vi.fn();
    const tools = createLoopTools(service([researched], { research } as never));
    const text = await run(tools[5], { id: 'loop-1' });
    expect(research).toHaveBeenCalledWith('loop-1');
    expect(text).toContain('Ava confirmed Friday');
  });
});
