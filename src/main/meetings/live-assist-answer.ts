import { configStore } from '../config/config-store';
import { runPiAiOneShot } from '../agent/sdk-one-shot';
import { searchMcpTools, type McpSearchToolHit } from '../agent/mcp-tool-budget';
import { compressToolResultTextForModel } from '../agent/mcp-tool-payload';
import { MCP_PINBOARD_SERVER_KEYS } from '../agent/mcp-tool-pinboard';
import { normalizeMcpToolResultForModel } from '../agent/tool-result-utils';
import type { MCPManager } from '../mcp/mcp-manager';
import { logWarn } from '../utils/logger';
import { truncateTranscriptWindow } from './live-assist-service';

export const MAX_MCP_CALLS = 3;
export const MCP_CALL_TIMEOUT_MS = 15_000;
export const PIPELINE_TIMEOUT_MS = 30_000;
const RESULT_MAX_CHARS = 3_000;

export interface LiveAssistAnswerOptions {
  question: string;
  transcriptWindow: string;
  meetingTitle: string;
  prepContext?: string | null;
  customInstructions?: string;
  mcpManager: MCPManager;
}

export interface LiveAssistMcpCall {
  tool_name: string;
  arguments: Record<string, unknown>;
}

function extractKeywords(question: string): string {
  return question
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .slice(0, 8)
    .join(' ');
}

function buildLeanToolCatalog(mcpManager: MCPManager, question: string): McpSearchToolHit[] {
  const allTools = mcpManager.getTools();
  const pinboardTools = allTools.filter((tool) => {
    const serverKey = tool.serverName.toLowerCase().replace(/[^a-z0-9]/g, '');
    return MCP_PINBOARD_SERVER_KEYS.has(serverKey);
  });
  const query = extractKeywords(question);
  return searchMcpTools(pinboardTools.length > 0 ? pinboardTools : allTools, {
    query: query || undefined,
    limit: 25,
  });
}

function formatToolCatalogForPrompt(tools: McpSearchToolHit[]): string {
  if (tools.length === 0) {
    return '(no MCP tools connected)';
  }
  return tools
    .map((tool) => {
      const params = tool.parameters
        .map((param) => `${param.name}${param.required ? '*' : ''}`)
        .join(', ');
      const description = tool.description.slice(0, 120);
      return `- ${tool.name} (${tool.server}): ${description}${params ? ` [${params}]` : ''}`;
    })
    .join('\n');
}

export function buildLiveAssistAnswerPlanPrompt(
  options: LiveAssistAnswerOptions,
  catalogText: string
): string {
  const sections = [
    'Plan MCP tool calls to answer a live meeting question.',
    'Return JSON only: {"calls":[{"tool_name":string,"arguments":object}]}',
    `Pick at most ${MAX_MCP_CALLS} tools from the catalog. Use exact tool_name values.`,
    'Prefer Hub, Slack, Gmail, Calendar, Jira, LaunchPad for company/work questions.',
    'Use tight limits/filters in arguments to keep results small.',
    '',
    `Meeting: ${options.meetingTitle}`,
    `Question: ${options.question}`,
  ];

  if (options.prepContext?.trim()) {
    sections.push('', 'Meeting prep:', options.prepContext.trim());
  }

  if (options.customInstructions?.trim()) {
    sections.push('', 'User instructions:', options.customInstructions.trim());
  }

  sections.push(
    '',
    'Recent transcript:',
    truncateTranscriptWindow(options.transcriptWindow),
    '',
    'Available MCP tools:',
    catalogText
  );

  return sections.join('\n');
}

export function buildLiveAssistSummarizePrompt(
  options: LiveAssistAnswerOptions,
  toolResults: Array<{ tool: string; text: string }>
): string {
  const sections = [
    'Answer a live meeting question using the research below.',
    'Be concise (at most 8 sentences). Do not invent facts.',
    'If data is insufficient, say what is known and what is missing.',
    '',
    `Meeting: ${options.meetingTitle}`,
    `Question: ${options.question}`,
  ];

  if (options.prepContext?.trim()) {
    sections.push('', 'Meeting prep:', options.prepContext.trim());
  }

  if (options.customInstructions?.trim()) {
    sections.push('', 'User instructions:', options.customInstructions.trim());
  }

  sections.push('', 'Recent transcript:', truncateTranscriptWindow(options.transcriptWindow));

  if (toolResults.length > 0) {
    sections.push('', 'Research results:');
    for (const result of toolResults) {
      sections.push('', `--- ${result.tool} ---`, result.text);
    }
  } else {
    sections.push('', 'Research results: (none — answer from prep/transcript only if possible)');
  }

  return sections.join('\n');
}

function parsePlanJson(text: string): LiveAssistMcpCall[] {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return [];
  }
  const parsed = JSON.parse(jsonMatch[0]) as {
    calls?: Array<{ tool_name?: string; arguments?: Record<string, unknown> }>;
  };
  if (!Array.isArray(parsed.calls)) {
    return [];
  }
  return parsed.calls
    .map((call) => ({
      tool_name: typeof call.tool_name === 'string' ? call.tool_name.trim() : '',
      arguments:
        call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
          ? call.arguments
          : {},
    }))
    .filter((call) => call.tool_name.length > 0);
}

async function callToolWithTimeout(
  mcpManager: MCPManager,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<string | null> {
  try {
    const result = await Promise.race([
      mcpManager.callTool(toolName, args),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`MCP call timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    const normalized = normalizeMcpToolResultForModel(result, { compress: false });
    return normalized.text.trim() || null;
  } catch (error) {
    logWarn(`[LiveAssist] MCP call ${toolName} failed:`, error);
    return null;
  }
}

export async function answerLiveAssistQuestion(
  options: LiveAssistAnswerOptions
): Promise<string | null> {
  const config = configStore.getAll();
  const catalog = buildLeanToolCatalog(options.mcpManager, options.question);
  const catalogText = formatToolCatalogForPrompt(catalog);
  const availableNames = new Set(options.mcpManager.getTools().map((tool) => tool.name));

  let calls: LiveAssistMcpCall[] = [];
  try {
    const planResult = await runPiAiOneShot(
      buildLiveAssistAnswerPlanPrompt(options, catalogText),
      'Return JSON only.',
      config,
      { maxTokens: 256, temperature: 0 }
    );
    calls = parsePlanJson(planResult.text)
      .slice(0, MAX_MCP_CALLS)
      .filter((call) => availableNames.has(call.tool_name));
  } catch (error) {
    logWarn('[LiveAssist] Answer plan failed:', error);
  }

  const pipelineDeadline = Date.now() + PIPELINE_TIMEOUT_MS;
  const toolResults: Array<{ tool: string; text: string }> = [];

  if (calls.length > 0) {
    const remainingMs = Math.max(1_000, pipelineDeadline - Date.now());
    const perCallTimeout = Math.min(MCP_CALL_TIMEOUT_MS, remainingMs);

    const settled = await Promise.allSettled(
      calls.map(async (call) => {
        const text = await callToolWithTimeout(
          options.mcpManager,
          call.tool_name,
          call.arguments,
          perCallTimeout
        );
        if (!text) {
          return null;
        }
        return {
          tool: call.tool_name,
          text: compressToolResultTextForModel(text, { maxChars: RESULT_MAX_CHARS }),
        };
      })
    );

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled' && outcome.value) {
        toolResults.push(outcome.value);
      }
    }
  }

  try {
    const answerResult = await runPiAiOneShot(
      buildLiveAssistSummarizePrompt(options, toolResults),
      'Answer concisely in at most 8 sentences. Do not invent facts.',
      config,
      { maxTokens: 512, temperature: 0 }
    );
    const answer = answerResult.text.trim();
    return answer || null;
  } catch (error) {
    logWarn('[LiveAssist] Answer summarize failed:', error);
    return null;
  }
}
