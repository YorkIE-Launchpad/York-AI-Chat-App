import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

type ToolSchema = {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
};

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export function extractText(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  return JSON.stringify(result, null, 2);
}

export async function startConnectorMcpServer(options: {
  serverName: string;
  version?: string;
  tools: ToolSchema[];
  handlers: Record<string, ToolHandler>;
}): Promise<void> {
  const server = new Server(
    {
      name: options.serverName,
      version: options.version ?? '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const handler = options.handlers[toolName];
    if (!handler) {
      throw new Error(`Unknown tool: ${toolName}`);
    }
    const result = await handler((request.params.arguments ?? {}) as Record<string, unknown>);
    return {
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result),
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
