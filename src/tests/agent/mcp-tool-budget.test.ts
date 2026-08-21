import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { MCPManager, MCPTool } from '../../main/mcp/mcp-manager';
import {
  ANTHROPIC_MCP_META_THRESHOLD,
  MCP_CALL_TOOL_NAME,
  MCP_RUN_TOOL_NAME,
  MCP_SEARCH_TOOLS_NAME,
  OPENAI_MAX_TOOLS,
  buildMcpMetaTools,
  needsAnthropicToolBudget,
  needsOpenAIToolBudget,
  searchMcpTools,
  selectCustomToolsForModel,
  toolBudgetLimitForApi,
} from '../../main/agent/mcp-tool-budget';
import {
  MCP_WRITE_DISABLED_MESSAGE,
  setMcpWriteAccessEnabled,
  setMcpWriteAccessServerSource,
} from '../../main/config/mcp-write-access-store';

function makeMcpTool(overrides: Partial<MCPTool> & Pick<MCPTool, 'name'>): MCPTool {
  const inputSchema = overrides.inputSchema ?? {
    type: 'object' as const,
    properties: { q: { type: 'string' } },
    required: ['q'],
  };
  const originalName = overrides.originalName ?? overrides.name.replace(/^mcp__[^_]+__/, '');
  return {
    name: overrides.name,
    originalName,
    description: overrides.description ?? `Description for ${overrides.name}`,
    inputSchema,
    outputSchema: overrides.outputSchema,
    toolDefinition:
      overrides.toolDefinition ??
      ({
        name: originalName,
        description: overrides.description ?? `Description for ${overrides.name}`,
        inputSchema,
      } as MCPTool['toolDefinition']),
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

describe('needsAnthropicToolBudget / toolBudgetLimitForApi', () => {
  it('detects Anthropic Messages API', () => {
    expect(needsAnthropicToolBudget('anthropic-messages')).toBe(true);
    expect(needsAnthropicToolBudget('openai-completions')).toBe(false);
  });

  it('returns the right flat-tool threshold per API', () => {
    expect(toolBudgetLimitForApi('openai-completions')).toBe(OPENAI_MAX_TOOLS);
    expect(toolBudgetLimitForApi('openai-responses')).toBe(OPENAI_MAX_TOOLS);
    expect(toolBudgetLimitForApi('anthropic-messages')).toBe(ANTHROPIC_MCP_META_THRESHOLD);
    expect(toolBudgetLimitForApi('google-generative-ai')).toBeNull();
    expect(toolBudgetLimitForApi(undefined)).toBeNull();
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

  it('returns lean parameter summaries by default without full schemas', () => {
    const withParams = [
      makeMcpTool({
        name: 'mcp__Hub__get_employee',
        originalName: 'get_employee',
        serverName: 'Hub',
        description: 'Fetch an employee profile',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' }, limit: { type: 'number' } },
          required: ['q'],
        },
      }),
    ];
    const matches = searchMcpTools(withParams, { query: 'employee' });
    expect(matches[0]?.parameters).toEqual([
      { name: 'limit', required: false },
      { name: 'q', required: true },
    ]);
    expect(matches[0]?.inputSchema).toBeUndefined();
  });

  it('includes full inputSchema when includeSchema is true', () => {
    const withParams = [
      makeMcpTool({
        name: 'mcp__Hub__get_employee',
        originalName: 'get_employee',
        serverName: 'Hub',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' }, limit: { type: 'number' } },
          required: ['q'],
        },
      }),
    ];
    const matches = searchMcpTools(withParams, { query: 'employee', includeSchema: true });
    expect(matches[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { q: { type: 'string' }, limit: { type: 'number' } },
      required: ['q'],
    });
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

  it('exposes search+call meta tools (not mcp_run) when over OpenAI budget', () => {
    const flatCount = OPENAI_MAX_TOOLS;
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
      useSearchCallMeta: true,
    });

    expect(result.mode).toBe('meta');
    expect(result.customTools.map((t) => t.name)).toEqual([
      MCP_SEARCH_TOOLS_NAME,
      MCP_CALL_TOOL_NAME,
      'webfetch',
      'spawn_subagent',
    ]);
    expect(result.customTools.map((t) => t.name)).not.toContain(MCP_RUN_TOOL_NAME);
    expect(4 + result.customTools.length).toBeLessThanOrEqual(OPENAI_MAX_TOOLS);
  });

  it('uses search+call meta tools when useSearchCallMeta is set (child path)', () => {
    const flatCount = OPENAI_MAX_TOOLS;
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
      extensionTools: [],
      useSearchCallMeta: true,
    });

    expect(result.mode).toBe('meta');
    expect(result.customTools.map((t) => t.name)).toEqual([
      MCP_SEARCH_TOOLS_NAME,
      MCP_CALL_TOOL_NAME,
    ]);
  });

  it('keeps flat tools on Anthropic when under the schema budget', () => {
    const mcpTools = Array.from({ length: 10 }, (_, i) => makeToolDef(`mcp__Launchpad__t${i}`));
    const manager = makeMcpManager(
      mcpTools.map((t) => makeMcpTool({ name: t.name, serverName: 'Launchpad' }))
    );

    const result = selectCustomToolsForModel({
      api: 'anthropic-messages',
      builtInToolCount: 4,
      mcpManager: manager,
      mcpTools,
      extensionTools: [],
    });

    expect(result.mode).toBe('flat');
    expect(result.customTools).toHaveLength(10);
  });

  it('switches to meta tools on Anthropic when over the schema budget', () => {
    const overBudget = ANTHROPIC_MCP_META_THRESHOLD; // 4 built-ins + N mcp > 32 when N >= 29
    const mcpCount = overBudget; // 4 + mcpCount > 32 when mcpCount > 28
    const mcpTools = Array.from({ length: mcpCount }, (_, i) =>
      makeToolDef(`mcp__Launchpad__t${i}`)
    );
    const manager = makeMcpManager(
      mcpTools.map((t) => makeMcpTool({ name: t.name, serverName: 'Launchpad' }))
    );

    const result = selectCustomToolsForModel({
      api: 'anthropic-messages',
      builtInToolCount: 4,
      mcpManager: manager,
      mcpTools,
      extensionTools: [],
      useSearchCallMeta: true,
    });

    expect(result.mode).toBe('meta');
    expect(result.customTools.map((t) => t.name)).toEqual([
      MCP_SEARCH_TOOLS_NAME,
      MCP_CALL_TOOL_NAME,
    ]);
  });
});

describe('buildMcpMetaTools', () => {
  let manager: MCPManager;
  let callTool: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setMcpWriteAccessEnabled(true);
    setMcpWriteAccessServerSource(() => []);
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
        name: 'mcp__Slack__post_message',
        originalName: 'post_message',
        serverName: 'Slack',
        description: 'Post a Slack message',
        inputSchema: {
          type: 'object',
          properties: { channel: { type: 'string' }, text: { type: 'string' } },
          required: ['channel', 'text'],
        },
      }),
      makeMcpTool({
        name: 'mcp__York_IE_HUB__create_announcement',
        originalName: 'create_announcement',
        serverName: 'York IE HUB',
        description: 'Create an announcement',
      }),
    ];
    manager = makeMcpManager(tools);
    callTool = manager.callTool as unknown as ReturnType<typeof vi.fn>;
  });

  it('searches tools via mcp_search_tools with lean payloads', async () => {
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
    const payload = JSON.parse(text) as {
      returned: number;
      tools: Array<{ name: string; parameters: unknown[]; inputSchema?: unknown }>;
    };
    expect(payload.returned).toBe(1);
    expect(payload.tools[0]?.name).toBe('mcp__Launchpad__list_features');
    expect(payload.tools[0]?.parameters).toBeDefined();
    expect(payload.tools[0]?.inputSchema).toBeUndefined();
  });

  it('includes schemas when include_schema is true', async () => {
    const [searchTool] = buildMcpMetaTools(manager);
    const result = await searchTool!.execute(
      '1',
      { query: 'features', include_schema: true },
      undefined,
      undefined,
      emptyExtensionCtx
    );
    const payload = JSON.parse((result.content[0] as { text: string }).text) as {
      tools: Array<{ inputSchema?: unknown }>;
    };
    expect(payload.tools[0]?.inputSchema).toBeDefined();
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

  it('blocks write tools via mcp_call_tool when global write access is off', async () => {
    setMcpWriteAccessEnabled(false);
    const tools = buildMcpMetaTools(manager);
    const callMeta = tools.find((t) => t.name === MCP_CALL_TOOL_NAME)!;
    const result = await callMeta.execute(
      '1',
      {
        tool_name: 'mcp__Slack__post_message',
        arguments: { channel: 'general', text: 'hi' },
      },
      undefined,
      undefined,
      emptyExtensionCtx
    );
    expect(callTool).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain(MCP_WRITE_DISABLED_MESSAGE);
  });

  it('blocks Hub writes via mcp_call_tool when write access is off', async () => {
    setMcpWriteAccessEnabled(false);
    const tools = buildMcpMetaTools(manager);
    const callMeta = tools.find((t) => t.name === MCP_CALL_TOOL_NAME)!;
    const result = await callMeta.execute(
      '1',
      { tool_name: 'mcp__York_IE_HUB__create_announcement', arguments: { title: 'Hi' } },
      undefined,
      undefined,
      emptyExtensionCtx
    );
    expect(callTool).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain(MCP_WRITE_DISABLED_MESSAGE);
  });

  it('still allows read tools via mcp_call_tool when write access is off', async () => {
    setMcpWriteAccessEnabled(false);
    const tools = buildMcpMetaTools(manager);
    const callMeta = tools.find((t) => t.name === MCP_CALL_TOOL_NAME)!;
    await callMeta.execute(
      '1',
      { tool_name: 'mcp__Hub__get_employee', arguments: { id: '42' } },
      undefined,
      undefined,
      emptyExtensionCtx
    );
    expect(callTool).toHaveBeenCalledWith('mcp__Hub__get_employee', { id: '42' });
  });

  it('injects locked project id on Hub get_project in project division', async () => {
    const hubTools = [
      makeMcpTool({
        name: 'mcp__York_IE_HUB__get_project',
        originalName: 'get_project',
        serverName: 'York IE HUB',
        description: 'Get one Hub project',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      }),
    ];
    const hubManager = makeMcpManager(hubTools);
    const tools = buildMcpMetaTools(hubManager, null, {
      division: 'project',
      hubProjectId: 'coach-uuid',
      hubProjectName: 'Coachmetrix',
    });
    const callMeta = tools.find((t) => t.name === MCP_CALL_TOOL_NAME)!;
    await callMeta.execute(
      '1',
      { tool_name: 'mcp__York_IE_HUB__get_project', arguments: {} },
      undefined,
      undefined,
      emptyExtensionCtx
    );
    expect(hubManager.callTool).toHaveBeenCalledWith('mcp__York_IE_HUB__get_project', {
      projectId: 'coach-uuid',
    });
  });

  it('blocks Hub get_project for a different project id in project division', async () => {
    const hubTools = [
      makeMcpTool({
        name: 'mcp__York_IE_HUB__get_project',
        originalName: 'get_project',
        serverName: 'York IE HUB',
        description: 'Get one Hub project',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      }),
    ];
    const hubManager = makeMcpManager(hubTools);
    const onViolation = vi.fn();
    const tools = buildMcpMetaTools(
      hubManager,
      null,
      {
        division: 'project',
        hubProjectId: 'coach-uuid',
        hubProjectName: 'Coachmetrix',
      },
      onViolation,
      'session-1'
    );
    const callMeta = tools.find((t) => t.name === MCP_CALL_TOOL_NAME)!;
    const result = await callMeta.execute(
      '1',
      { tool_name: 'mcp__York_IE_HUB__get_project', arguments: { id: 'medical-ease-uuid' } },
      undefined,
      undefined,
      emptyExtensionCtx
    );
    expect(hubManager.callTool).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain('Incorrect use');
    expect((result.content[0] as { text: string }).text).toContain('will be reported');
    expect((result.content[0] as { text: string }).text).toContain('Coachmetrix');
    expect(onViolation).toHaveBeenCalledTimes(1);
    expect(onViolation).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'mcp__York_IE_HUB__get_project',
        attemptedProjectId: 'medical-ease-uuid',
        sessionId: 'session-1',
        hubProjectId: 'coach-uuid',
        hubProjectName: 'Coachmetrix',
      })
    );
  });

  it('filters Hub list_projects results in project division', async () => {
    const hubTools = [
      makeMcpTool({
        name: 'mcp__York_IE_HUB__list_projects',
        originalName: 'list_projects',
        serverName: 'York IE HUB',
        description: 'List Hub projects',
        inputSchema: { type: 'object', properties: {} },
      }),
    ];
    const hubManager = {
      getTools: () => hubTools,
      getTool: (name: string) => hubTools.find((t) => t.name === name),
      callTool: vi.fn(async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify([
              { id: 'medical-ease-uuid', title: 'MedicalEase' },
              { id: 'coach-uuid', title: 'Coachmetrix' },
            ]),
          },
        ],
      })),
    } as unknown as MCPManager;
    const tools = buildMcpMetaTools(hubManager, null, {
      division: 'project',
      hubProjectId: 'coach-uuid',
      hubProjectName: 'Coachmetrix',
    });
    const callMeta = tools.find((t) => t.name === MCP_CALL_TOOL_NAME)!;
    const result = await callMeta.execute(
      '1',
      { tool_name: 'mcp__York_IE_HUB__list_projects', arguments: {} },
      undefined,
      undefined,
      emptyExtensionCtx
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('coach-uuid');
    expect(text).toContain('Coachmetrix');
    expect(text).not.toContain('MedicalEase');
    expect(text).not.toContain('medical-ease-uuid');
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
