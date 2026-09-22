/**
 * MCP tool search cascade via Jev:
 * Noul(need MCP) → Choice(server) → Score(tools) → Choice(winner).
 */
import {
  JEV_MCP_NEED_NOUL,
  JEV_MCP_SERVERS,
  JEV_MCP_WRITE_ASK_NOUL,
  type JevMcpServer,
} from '../../shared/jev';
import type { MCPTool } from '../mcp/mcp-manager';
import { choice, isJevEnabled, noul, runJevDecision, score, type Questions } from './jev-client';
import { log } from '../utils/logger';

export type McpJevSearchResult = {
  needMcp: boolean;
  server: JevMcpServer | null;
  /** Tool names sorted by Jev relevance (best first). */
  rankedToolNames: string[];
  winner: string | null;
  needsWriteAsk: boolean;
};

const RANK_RUBRIC = [
  'Irrelevant to the query',
  'Weak / tangential match',
  'Plausible but not ideal',
  'Strong match',
  'Best tool for this intent',
] as const;

/** Lexical fallback — mirrors mcp-tool-budget scoreToolMatch. */
export function lexicalToolScore(tool: MCPTool, query: string): number {
  const q = query.toLowerCase();
  const name = tool.name.toLowerCase();
  const original = (tool.originalName || '').toLowerCase();
  const server = tool.serverName.toLowerCase();
  const description = (tool.description || '').toLowerCase();

  let scoreVal = 0;
  if (name === q || original === q) scoreVal += 100;
  if (name.includes(q) || original.includes(q)) scoreVal += 40;
  if (server.includes(q)) scoreVal += 20;
  if (description.includes(q)) scoreVal += 10;

  const tokens = q.split(/[\s_/.-]+/).filter((t) => t.length > 1);
  for (const token of tokens) {
    if (name.includes(token) || original.includes(token)) scoreVal += 8;
    if (server.includes(token)) scoreVal += 4;
    if (description.includes(token)) scoreVal += 2;
  }
  return scoreVal;
}

/**
 * Score and optionally disambiguate MCP tools for a user query.
 * Returns null when Jev is off — caller uses lexical scoring.
 */
export async function runMcpJevSearch(options: {
  query: string;
  tools: MCPTool[];
  /** Pre-filter candidate count before Jev scoring. */
  candidateLimit?: number;
  topK?: number;
}): Promise<McpJevSearchResult | null> {
  if (!isJevEnabled()) return null;
  const query = options.query.trim();
  if (!query || options.tools.length === 0) {
    return {
      needMcp: false,
      server: null,
      rankedToolNames: [],
      winner: null,
      needsWriteAsk: false,
    };
  }

  const candidateLimit = options.candidateLimit ?? 24;
  const topK = options.topK ?? 8;

  // Pre-filter with lexical score so we don't send the entire catalog.
  const candidates = [...options.tools]
    .map((tool) => ({ tool, score: lexicalToolScore(tool, query) }))
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, candidateLimit)
    .map((e) => e.tool);

  if (candidates.length === 0) {
    return {
      needMcp: false,
      server: null,
      rankedToolNames: [],
      winner: null,
      needsWriteAsk: false,
    };
  }

  const gateQuestions: Questions = {
    need_mcp: noul('Does this request need an MCP / connector tool call?'),
    server: choice('Which MCP server family is most relevant?', JEV_MCP_SERVERS),
  };

  const gate = await runJevDecision(
    { query, candidateCount: candidates.length },
    gateQuestions,
    { label: 'mcp-gate' }
  );
  if (!gate) return null;

  const needNoul = gate.answers.need_mcp?.type === 'noul' ? gate.answers.need_mcp.noul : 0;
  const needMcp = needNoul >= JEV_MCP_NEED_NOUL;
  const serverChoice =
    gate.answers.server?.type === 'choice'
      ? (gate.answers.server.choice as JevMcpServer)
      : null;

  if (!needMcp) {
    return {
      needMcp: false,
      server: serverChoice,
      rankedToolNames: [],
      winner: null,
      needsWriteAsk: false,
    };
  }

  let pool = candidates;
  if (serverChoice && serverChoice !== 'other') {
    const filtered = candidates.filter((t) =>
      t.serverName.toLowerCase().includes(serverChoice === 'calendar' ? 'calendar' : serverChoice)
    );
    if (filtered.length > 0) pool = filtered;
  }

  const scoreQuestions: Questions = {};
  const scoreSlice = pool.slice(0, topK);
  for (let i = 0; i < scoreSlice.length; i += 1) {
    scoreQuestions[`t${i}`] = score(
      `How relevant is tool ${scoreSlice[i]!.name} (${scoreSlice[i]!.serverName}) for the query?`,
      RANK_RUBRIC
    );
  }
  scoreQuestions.winner = choice(
    'Which single tool should be called first (or none)?',
    Object.fromEntries([
      ...scoreSlice.map((t) => [t.name, t.description?.slice(0, 120) || t.name]),
      ['none', 'No suitable tool'],
    ])
  );
  scoreQuestions.write_ask = noul(
    'Would calling the winner mutate data or need user permission (write/send/post/delete)?'
  );

  const scored = await runJevDecision(
    {
      query,
      tools: scoreSlice.map((t) => ({
        name: t.name,
        server: t.serverName,
        description: (t.description || '').slice(0, 200),
      })),
    },
    scoreQuestions,
    { label: 'mcp-score' }
  );
  if (!scored) return null;

  const ranked = scoreSlice
    .map((tool, i) => {
      const ans = scored.answers[`t${i}`];
      const jevScore = ans?.type === 'score' ? ans.score : 0;
      return { name: tool.name, score: jevScore };
    })
    .sort((a, b) => b.score - a.score)
    .map((e) => e.name);

  const winnerRaw =
    scored.answers.winner?.type === 'choice' ? scored.answers.winner.choice : null;
  const winner = winnerRaw && winnerRaw !== 'none' ? winnerRaw : ranked[0] ?? null;
  const writeNoul =
    scored.answers.write_ask?.type === 'noul' ? scored.answers.write_ask.noul : 0;

  log(
    `[Jev/MCP] need=${needMcp} server=${serverChoice} winner=${winner} ranked=${ranked.length}`
  );

  return {
    needMcp: true,
    server: serverChoice,
    rankedToolNames: ranked,
    winner,
    needsWriteAsk: writeNoul >= JEV_MCP_WRITE_ASK_NOUL,
  };
}

/**
 * Dynamic pinboard: which high-value tools should stay flat for this prompt.
 * Falls back to null (use static pinboard).
 */
export async function runMcpJevPinboardPick(options: {
  prompt: string;
  pinboardCandidates: MCPTool[];
  maxPick: number;
}): Promise<string[] | null> {
  if (!isJevEnabled() || !options.prompt.trim() || options.pinboardCandidates.length === 0) {
    return null;
  }

  const slice = options.pinboardCandidates.slice(0, 40);
  const questions: Questions = {};
  for (let i = 0; i < slice.length; i += 1) {
    questions[`p${i}`] = noul(
      `Should tool ${slice[i]!.name} stay listed flat for this user prompt?`
    );
  }

  const result = await runJevDecision(
    { prompt: options.prompt.slice(0, 2000), maxPick: options.maxPick },
    questions,
    { label: 'mcp-pinboard' }
  );
  if (!result) return null;

  const scored = slice
    .map((tool, i) => {
      const ans = result.answers[`p${i}`];
      return {
        name: tool.name,
        noul: ans?.type === 'noul' ? ans.noul : 0,
      };
    })
    .sort((a, b) => b.noul - a.noul)
    .filter((e) => e.noul >= 0.45)
    .slice(0, options.maxPick)
    .map((e) => e.name);

  return scored.length > 0 ? scored : null;
}
