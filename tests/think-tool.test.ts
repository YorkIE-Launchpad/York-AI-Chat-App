import { describe, expect, it } from 'vitest';

import {
  THINK_TOOL_NAME,
  createThinkTool,
  withThinkToolIfEnabled,
} from '../src/main/tools/think-tool';

describe('think-tool', () => {
  it('defines think tool with thought parameter', () => {
    const tool = createThinkTool();
    expect(tool.name).toBe(THINK_TOOL_NAME);
    expect(tool.description).toMatch(/scratchpad|reasoning/i);
  });

  it('execute acknowledges a thought without mutating state', async () => {
    const tool = createThinkTool();
    const result = await tool.execute('call-1', { thought: 'Goal: cover projects\nNext: page 2' });
    expect(result.content).toEqual([{ type: 'text', text: 'Thought logged.' }]);
    expect(result.details).toEqual({
      thought: 'Goal: cover projects\nNext: page 2',
    });
  });

  it('execute handles empty thought', async () => {
    const tool = createThinkTool();
    const result = await tool.execute('call-2', { thought: '  ' });
    expect(result.content).toEqual([{ type: 'text', text: 'Thought logged (empty).' }]);
  });

  it('withThinkToolIfEnabled appends think and bumps signature only when on', () => {
    const base = [createThinkTool()];
    // Use a stand-in tool shape via createThinkTool rename for the base list
    const other = { ...createThinkTool(), name: 'other' };
    expect(withThinkToolIfEnabled(false, [other], 'flat:a')).toEqual({
      customTools: [other],
      toolsSignature: 'flat:a',
    });
    const on = withThinkToolIfEnabled(true, [other], 'flat:a');
    expect(on.toolsSignature).toBe(`flat:a|${THINK_TOOL_NAME}`);
    expect(on.customTools.map((t) => t.name)).toEqual(['other', THINK_TOOL_NAME]);
    expect(base[0].name).toBe(THINK_TOOL_NAME);
  });

  it('withThinkToolIfEnabled dedupes an existing think tool', () => {
    const other = { ...createThinkTool(), name: 'other' };
    const base = [other, createThinkTool()];
    const on = withThinkToolIfEnabled(true, base, 'meta:x');
    expect(on.customTools.filter((t) => t.name === THINK_TOOL_NAME)).toHaveLength(1);
  });
});
