import { type CallToolResult, type ListToolsResult, Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

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
  const createServer = (): Server => {
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

    server.setRequestHandler(
      'tools/list',
      async (): Promise<ListToolsResult> => ({
        tools: options.tools,
      })
    );

    server.setRequestHandler('tools/call', async (request): Promise<CallToolResult> => {
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

    return server;
  };

  const stdioHandle = serveStdio(() => createServer());

  process.on('SIGINT', () => {
    void stdioHandle.close().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void stdioHandle.close().finally(() => process.exit(0));
  });
}
