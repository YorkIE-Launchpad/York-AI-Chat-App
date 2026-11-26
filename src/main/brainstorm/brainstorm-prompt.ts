/**
 * Facilitation playbook injected into brainstorm sessions.
 * Role lenses describe how strong practitioners in that seat brainstorm,
 * not a script the model should recite.
 */
import type {
  BrainstormDetail,
  BrainstormProfileSnapshot,
  BrainstormTechnique,
} from '../../shared/brainstorm-types';
import {
  BRAINSTORM_PHASE_LABELS,
  BRAINSTORM_TECHNIQUE_LABELS,
} from '../../shared/brainstorm-types';

export interface RoleLens {
  id: string;
  label: string;
  guidance: string;
}

const LENSES: Array<RoleLens & { test: RegExp }> = [
  {
    id: 'revops',
    label: 'RevOps',
    test: /revops|revenue operations|revenue ops|sales ops|sales operations|gtm ops|go-to-market ops/,
    guidance:
      'Think like a RevOps lead: funnel stages, pipeline velocity, handoffs between marketing, SDR, AE, and CS, data hygiene, tooling (CRM, enrichment, sequencing), forecast integrity, and which process change moves revenue this quarter versus next year. Prefer operable plays over slogans.',
  },
  {
    id: 'product',
    label: 'Product',
    test: /product manager|\bpm\b|product management|product owner|head of product|chief product|cpo/,
    guidance:
      'Think like a strong product manager: start from the job to be done and the underserved outcome, frame how-might-we questions, separate problem from solution, and spread bets across opportunity-tree branches (core, adjacent, disruptive). Name the user, the current workaround, and what would make the idea worth building.',
  },
  {
    id: 'marketing',
    label: 'Marketing',
    test: /marketing|demand gen|growth market|brand|content|communications|pmm|product marketing/,
    guidance:
      'Think like a marketer: audience, channel, positioning, offer, message, and the metric that would move (pipeline, activation, retention, share of voice). Include at least one campaign-shaped idea and one positioning or narrative idea.',
  },
  {
    id: 'engineering',
    label: 'Engineering',
    test: /engineer|engineering|developer|software|architect|cto|platform|infrastructure/,
    guidance:
      'Think like an engineering lead: build vs buy, leverage of the current stack, reliability and cost, time-to-first-value, and what a thin slice could prove. Include one idea that is mostly process or tooling, not a new system.',
  },
  {
    id: 'design',
    label: 'Design',
    test: /\bdesign\b|ux|ui\b|research ops|service design/,
    guidance:
      'Think like a design lead: the moment of friction, the job in context, and ideas that change the experience rather than adding a feature. Include one idea that removes something.',
  },
  {
    id: 'sales',
    label: 'Sales',
    test: /\bsales\b|account executive|account manager|business development|\bae\b|cro\b/,
    guidance:
      'Think like a sales lead: where deals stall, what buyers ask for, competitive traps, and plays a rep can run this month. Tie ideas to a stage of the deal, not a generic growth slogan.',
  },
  {
    id: 'people',
    label: 'People',
    test: /\bhr\b|people team|\bpeople\b|talent|recruit|people ops|human resources/,
    guidance:
      'Think like a people lead: hiring, onboarding, manager habits, and culture mechanisms that change behavior. Prefer small operating rituals over new programs.',
  },
];

export function roleLensFor(profile: BrainstormProfileSnapshot): RoleLens {
  const haystack = [
    profile.title,
    profile.department,
    profile.functionName,
    profile.squad,
    profile.roleNote,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const match = LENSES.find((lens) => lens.test.test(haystack));
  if (match) {
    return { id: match.id, label: match.label, guidance: match.guidance };
  }
  return {
    id: 'general',
    label: 'General',
    guidance:
      'The person did not match a specialty. Brainstorm the way a sharp operator in their stated role would: name the outcome, the constraint, what peers in that seat are doing right now, and a mix of safe, bold, and contrarian ideas. Do not assume they are a product manager.',
  };
}

const TECHNIQUE_NOTES: Record<BrainstormTechnique, string> = {
  auto: 'Pick the technique that fits the topic after framing. Say which one you are using.',
  hmw: 'Phrase the problem as How-might-we questions, then generate ideas against the sharpest one.',
  scamper:
    'Run SCAMPER: substitute, combine, adapt, modify, put to another use, eliminate, reverse. Tag ideas with the letter you used.',
  reverse:
    'First list how to make the problem worse or guarantee failure, then flip each into a constructive idea.',
  'first-principles':
    'Strip assumptions. State what must be true, then generate ideas that do not depend on the usual playbook.',
  jtbd: 'Anchor on the job, the struggling moment, and the outcome the person hires a solution to achieve.',
};

export interface ConnectedToolRef {
  serverName: string;
  name: string;
}

const BROWSER_SERVER = /^(chrome|chrome devtools)$/i;

function isLookupTool(name: string): boolean {
  const base = name.split('__').pop() || name;
  return /search|list|get|read|find|query|fetch|lookup/i.test(base);
}

/** Servers the user has connected, so research can query them instead of only the web. */
export function formatConnectedToolSources(tools: ConnectedToolRef[]): string {
  const byServer = new Map<string, string[]>();
  for (const tool of tools) {
    const server = String(tool.serverName || '').trim();
    const name = String(tool.name || '').trim();
    if (!server || !name || BROWSER_SERVER.test(server)) continue;
    const names = byServer.get(server) || [];
    if (names.includes(name) || names.length >= 8) continue;
    names.push(name);
    byServer.set(server, names);
  }
  if (byServer.size === 0) {
    return 'Connected tools: none are connected. Uploaded files and the web are the only sources.';
  }
  const lines = ['Connected tools (these are sources — check them, not only the web):'];
  for (const [server, names] of [...byServer.entries()].slice(0, 16)) {
    const picked = [
      ...names.filter(isLookupTool),
      ...names.filter((name) => !isLookupTool(name)),
    ].slice(0, 6);
    lines.push(`- ${server}: ${picked.join(', ')}`);
  }
  return lines.join('\n');
}

function clip(text: string, max: number): string {
  const value = text.replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export function buildBoardSnapshot(detail: BrainstormDetail): string {
  const lines = detail.ideas.map((idea) => {
    const flags = [
      idea.starred ? 'starred' : '',
      idea.status === 'discarded' ? 'discarded' : '',
      idea.author === 'user' ? 'added by user' : '',
      idea.cluster ? `cluster=${idea.cluster}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    return `- ${idea.id} ${idea.title}${flags ? ` (${flags})` : ''}: ${clip(idea.body, 160)}`;
  });
  const thoughts = (detail.activity || [])
    .filter((row) => row.kind === 'thought' || row.kind === 'idea_added')
    .slice(-15)
    .map((row) => `- ${row.actorName || 'Someone'}: ${clip(row.text || '', 160)}`);
  const files = detail.signals
    .filter((signal) => signal.kind === 'file')
    .map((signal) => `- ${signal.title} (source id ${signal.sourceId || 'unknown'})`);
  return [
    lines.length ? 'Board:' : 'Board: empty.',
    ...lines,
    thoughts.length ? 'Recent thoughts from the group:' : '',
    ...thoughts,
    files.length ? 'Uploaded sources (read these before connected tools and the web):' : '',
    ...files,
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildBrainstormPlaybook(
  detail: BrainstormDetail,
  connectedTools: ConnectedToolRef[] = []
): string {
  const lens = roleLensFor(detail.profileSnapshot);
  const profile = detail.profileSnapshot;
  const who = [
    profile.name,
    profile.title,
    profile.department,
    profile.functionName,
    profile.squad ? `squad ${profile.squad}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const signalLines = detail.signals.length
    ? detail.signals
        .map(
          (signal) =>
            `- ${signal.title}: ${clip(signal.summary, 180)}${signal.url ? ` (${signal.url})` : ''}`
        )
        .join('\n')
    : 'None recorded yet.';

  return [
    'You are facilitating a brainstorm, not answering a normal chat. The live idea board is the artifact. Keep messages short.',
    'Their role is private context for you. Never mention their name, title, function, squad, or background, and never say you looked them up. Shape the questions and ideas for that seat without announcing it.',
    'Teammates may add thoughts and files. Build on the thoughts, and credit the person on the board (idea author or thought text), not by announcing their job. Read uploaded files with sources_read before other research and treat them as the primary facts, numbers, and constraints. Cite the file name on ideas that use it.',
    '',
    `Topic: ${detail.topic}`,
    detail.goal ? `Goal: ${detail.goal}` : '',
    `Technique: ${BRAINSTORM_TECHNIQUE_LABELS[detail.technique]}. ${TECHNIQUE_NOTES[detail.technique]}`,
    `Phase: ${BRAINSTORM_PHASE_LABELS[detail.phase]} (${detail.phase}).`,
    who
      ? `Who you are brainstorming with: ${who}.`
      : 'No role was on file. Ask what seat they are brainstorming from if it changes the ideas.',
    profile.roleNote ? `They added this context: ${profile.roleNote}` : '',
    `Role lens (${lens.label}): ${lens.guidance}`,
    '',
    'How to run it:',
    '- Frame: ask 1–2 sharp questions with AskUserQuestion before you suggest ideas. Do not dump a list in the first turn.',
    "- Research: sources are uploaded files, then the person's own tools, then the web. Read the files first. Then search each connected tool that can hold facts for this topic. Check them by name: Slack, Gmail, Google Drive, Google Calendar, Jira, Confluence, Zoom or meeting notes, and Hub. Skip one only when it is not connected. When a tool is not already named below, use mcp_search_tools and then mcp_call_tool in the same turn. Do this even when web search fails or returns nothing. A failed web search is not a source and is not a reason to stop. Use websearch and webfetch after the tools, for public news, competitors, and practitioner moves. Record each useful finding with brainstorm_set_context. For Slack, Gmail, Drive, Calendar, Jira, or any other connected tool, set kind to tool and source to that name. A URL is only for a web page.",
    formatConnectedToolSources(connectedTools),
    '- Diverge: add 8–15 varied ideas with brainstorm_add_ideas. Include at least one bold idea and one contrarian idea. Each idea needs a title, a one- or two-sentence pitch, why it is worth trying, and sources when the research supports it. Put impact and effort from 1 to 5 when you can defend them.',
    '- Cluster: group ideas with brainstorm_cluster once there are enough to group.',
    '- Converge: react to what they starred, discarded, or added on the board. Update scores with brainstorm_update_idea. Ask which ideas they want to push.',
    '- Wrap-up: call brainstorm_save_brief with a short summary, ranked idea ids (best first), 2–4 first experiments, open questions, and sources. Then brainstorm_set_phase wrapup if the brief tool did not already move you there.',
    '- Move phases with brainstorm_set_phase. Do not skip research.',
    '- Never paste the whole board back into chat. The tools update the board. A message should ask a question, name what just changed, or close the loop.',
    '- If they say expand or combine, do that to the named ideas and update the board.',
    '',
    'Signals already on the board:',
    signalLines,
    '',
    buildBoardSnapshot(detail),
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function buildKickoffPrompt(detail: BrainstormDetail): string {
  const lens = roleLensFor(detail.profileSnapshot);
  return [
    `Start a brainstorm on: ${detail.topic}`,
    detail.goal ? `Goal: ${detail.goal}` : '',
    `Use the ${lens.label} lens privately. Do not name their role.`,
    'Open in the Frame phase. Call brainstorm_set_phase with phase "frame", then ask one or two framing questions with AskUserQuestion. Do not research or add ideas until they answer.',
  ]
    .filter(Boolean)
    .join('\n');
}
