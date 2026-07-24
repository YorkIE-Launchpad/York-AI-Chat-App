import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { MCPManager, MCPTool } from '../../main/mcp/mcp-manager';
import {
  MCP_CALL_TOOL_NAME,
  MCP_SEARCH_TOOLS_NAME,
  OPENAI_MAX_TOOLS,
  buildMcpMetaTools,
  needsOpenAIToolBudget,
  searchMcpTools,
  selectCustomToolsForModel,
} from '../../main/agent/mcp-tool-budget';

function makeMcpTool(overrides: Partial<MCPTool> & Pick<MCPTool, 'name'>): MCPTool {
  return {
    name: overrides.name,
    originalName: overrides.originalName ?? overrides.name.replace(/^mcp__[^_]+__/, ''),
    description: overrides.description ?? `Description for ${overrides.name}`,
    inputSchema: overrides.inputSchema ?? {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    },
    serverId: overrides.serverId ?? 'server-1',
    serverName: overrides.serverName ?? 'Launchpad',
  };
}

const emptyExtensionCtx = {} as never;

function makeToolDef(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} } as unknown as ToolDefinition['parameters'],
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: undefined }),
  } as ToolDefinition;
}

function makeMcpManager(tools: MCPTool[]): MCPManager {
  const map = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    getTools: () => Array.from(map.values()),
    getTool: (name: string) => map.get(name),
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => ({
      content: [{ type: 'text', text: `called:${name}:${JSON.stringify(args)}` }],
    })),
  } as unknown as MCPManager;
}

describe('needsOpenAIToolBudget', () => {
  it('detects OpenAI-compatible APIs only', () => {
    expect(needsOpenAIToolBudget('openai-completions')).toBe(true);
    expect(needsOpenAIToolBudget('openai-responses')).toBe(true);
    expect(needsOpenAIToolBudget('anthropic-messages')).toBe(false);
    expect(needsOpenAIToolBudget(undefined)).toBe(false);
  });
});

describe('searchMcpTools', () => {
  const tools = [
    makeMcpTool({
      name: 'mcp__Launchpad__list_features',
      originalName: 'list_features',
      serverName: 'Launchpad',
      description: 'List product features',
    }),
    makeMcpTool({
      name: 'mcp__Hub__get_employee',
      originalName: 'get_employee',
      serverName: 'Hub',
      description: 'Fetch an employee profile',
    }),
    makeMcpTool({
      name: 'mcp__Chrome__navigate',
      originalName: 'navigate',
      serverName: 'Chrome',
      description: 'Navigate the browser',
    }),
  ];

  it('filters by query and ranks name matches first', () => {
    const matches = searchMcpTools(tools, { query: 'employee' });
    expect(matches.map((m) => m.name)).toEqual(['mcp__Hub__get_employee']);
  });

  it('filters by server substring', () => {
    const matches = searchMcpTools(tools, { server: 'chrome' });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe('mcp__Chrome__navigate');
  });

  it('respects limit', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      makeMcpTool({ name: `mcp__Launchpad__tool_${i}`, serverName: 'Launchpad' })
    );
    expect(searchMcpTools(many, { limit: 5 })).toHaveLength(5);
  });
});

describe('selectCustomToolsForModel', () => {
  const extensionTools = [makeToolDef('webfetch'), makeToolDef('spawn_subagent')];

  it('passes through flat tools when under the OpenAI budget', () => {
    const mcpTools = Array.from({ length: 10 }, (_, i) => makeToolDef(`mcp__Hub__t${i}`));
    const manager = makeMcpManager(
      mcpTools.map((t) => makeMcpTool({ name: t.name, serverName: 'Hub' }))
    );

    const result = selectCustomToolsForModel({
      api: 'openai-completions',
      builtInToolCount: 4,
      mcpManager: manager,
      mcpTools,
      extensionTools,
    });

    expect(result.mode).toBe('flat');
    expect(result.customTools.map((t) => t.name)).toEqual([
      ...mcpTools.map((t) => t.name),
      ...extensionTools.map((t) => t.name),
    ]);
  });

  it('switches to meta tools when over OpenAI 128 budget', () => {
    const flatCount = OPENAI_MAX_TOOLS; // 4 built-ins + extensions(2) + this => over
    const mcpTools = Array.from({ length: flatCount }, (_, i) =>
      makeToolDef(`mcp__Launchpad__t${i}`)
    );
    const manager = makeMcpManager(
      mcpTools.map((t) => makeMcpTool({ name: t.name, serverName: 'Launchpad' }))
    );

    const result = selectCustomToolsForModel({
      api: 'openai-completions',
      builtInToolCount: 4,
      mcpManager: manager,
      mcpTools,
      extensionTools,
    });

    expect(result.mode).toBe('meta');
    expect(result.customTools.map((t) => t.name)).toEqual([
      MCP_SEARCH_TOOLS_NAME,
      MCP_CALL_TOOL_NAME,
      'webfetch',
      'spawn_subagent',
    ]);
    expect(4 + result.customTools.length).toBeLessThanOrEqual(OPENAI_MAX_TOOLS);
  });

  it('keeps flat tools on Anthropic even when over 128', () => {
    const mcpTools = Array.from({ length: 400 }, (_, i) => makeToolDef(`mcp__Launchpad__t${i}`));
    const manager = makeMcpManager(
      mcpTools.map((t) => makeMcpTool({ name: t.name, serverName: 'Launchpad' }))
    );

    const result = selectCustomToolsForModel({
      api: 'anthropic-messages',
      builtInToolCount: 4,
      mcpManager: manager,
      mcpTools,
      extensionTools,
    });

    expect(result.mode).toBe('flat');
    expect(result.customTools).toHaveLength(402);
  });
});

describe('buildMcpMetaTools', () => {
  let manager: MCPManager;
  let callTool: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const tools = [
      makeMcpTool({
        name: 'mcp__Launchpad__list_features',
        originalName: 'list_features',
        serverName: 'Launchpad',
        description: 'List product features',
      }),
      makeMcpTool({
        name: 'mcp__Hub__get_employee',
        originalName: 'get_employee',
        serverName: 'Hub',
        description: 'Fetch an employee profile',
      }),
    ];
    manager = makeMcpManager(tools);
    callTool = manager.callTool as unknown as ReturnType<typeof vi.fn>;
  });

  it('searches tools via mcp_search_tools', async () => {
    const [searchTool] = buildMcpMetaTools(manager);
    expect(searchTool?.name).toBe(MCP_SEARCH_TOOLS_NAME);
    const result = await searchTool!.execute(
      '1',
      { query: 'features' },
      undefined,
      undefined,
      emptyExtensionCtx
    );
    const text = (result.content[0] as { text: string }).text;
    const payload = JSON.parse(text) as { returned: number; tools: Array<{ name: string }> };
    expect(payload.returned).toBe(1);
    expect(payload.tools[0]?.name).toBe('mcp__Launchpad__list_features');
  });

  it('calls through mcp_call_tool', async () => {
    const tools = buildMcpMetaTools(manager);
    const callMeta = tools.find((t) => t.name === MCP_CALL_TOOL_NAME)!;
    const result = await callMeta.execute(
      '1',
      { tool_name: 'mcp__Hub__get_employee', arguments: { id: '42' } },
      undefined,
      undefined,
      emptyExtensionCtx
    );
    expect(callTool).toHaveBeenCalledWith('mcp__Hub__get_employee', { id: '42' });
    expect((result.content[0] as { text: string }).text).toContain('called:mcp__Hub__get_employee');
  });

  it('surfaces missing-tool errors from mcp_call_tool', async () => {
    const tools = buildMcpMetaTools(manager);
    const callMeta = tools.find((t) => t.name === MCP_CALL_TOOL_NAME)!;
    const result = await callMeta.execute(
      '1',
      { tool_name: 'mcp__Missing__nope', arguments: {} },
      undefined,
      undefined,
      emptyExtensionCtx
    );
    expect(callTool).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain('MCP tool not found');
  });

  it('respects allowlist for search and call', async () => {
    const allow = new Set(['mcp__Hub__get_employee']);
    const tools = buildMcpMetaTools(manager, allow);
    const searchTool = tools.find((t) => t.name === MCP_SEARCH_TOOLS_NAME)!;
    const callMeta = tools.find((t) => t.name === MCP_CALL_TOOL_NAME)!;

    const searchResult = await searchTool.execute(
      '1',
      { query: 'list' },
      undefined,
      undefined,
      emptyExtensionCtx
    );
    const searchPayload = JSON.parse((searchResult.content[0] as { text: string }).text) as {
      returned: number;
    };
    expect(searchPayload.returned).toBe(0);

    const denied = await callMeta.execute(
      '1',
      { tool_name: 'mcp__Launchpad__list_features', arguments: {} },
      undefined,
      undefined,
      emptyExtensionCtx
    );
    expect((denied.content[0] as { text: string }).text).toContain('MCP tool not found');

    const allowed = await callMeta.execute(
      '1',
      { tool_name: 'mcp__Hub__get_employee', arguments: {} },
      undefined,
      undefined,
      emptyExtensionCtx
    );
    expect(callTool).toHaveBeenCalledWith('mcp__Hub__get_employee', {});
    expect((allowed.content[0] as { text: string }).text).toContain(
      'called:mcp__Hub__get_employee'
    );
  });
});
