/**
 * Brainstorm sessions: a facilitated idea board tied to a chat, not a plain thread.
 */

export const BRAINSTORM_PHASES = [
  'frame',
  'research',
  'diverge',
  'cluster',
  'converge',
  'wrapup',
] as const;

export type BrainstormPhase = (typeof BRAINSTORM_PHASES)[number];

export const BRAINSTORM_TECHNIQUES = [
  'auto',
  'hmw',
  'scamper',
  'reverse',
  'first-principles',
  'jtbd',
] as const;

export type BrainstormTechnique = (typeof BRAINSTORM_TECHNIQUES)[number];

export type BrainstormStatus = 'active' | 'wrapped';

export type BrainstormIdeaStatus = 'active' | 'discarded';

export type BrainstormIdeaAuthor = 'agent' | 'user';

export interface BrainstormProfileSnapshot {
  name: string;
  email: string;
  title: string | null;
  functionName: string | null;
  squad: string | null;
  department: string | null;
  /** Free-text role or context the user edited before starting. */
  roleNote: string | null;
}

export interface BrainstormSignal {
  id: string;
  title: string;
  summary: string;
  url?: string | null;
  source?: string | null;
  /** A file the group uploaded, a connected tool, or a web page. */
  kind?: 'web' | 'file' | 'tool';
  sourceId?: string | null;
  status?: 'indexing' | 'ready' | 'failed';
}

export const BRAINSTORM_ACTIVITY_KINDS = [
  'idea_added',
  'thought',
  'starred',
  'discarded',
  'edited',
  'phase',
  'joined',
  'brief_saved',
  'file_added',
] as const;

export type BrainstormActivityKind = (typeof BRAINSTORM_ACTIVITY_KINDS)[number];

export interface BrainstormActivity {
  id: string;
  brainstormId: string;
  ideaId: string | null;
  actorEmail: string;
  actorName: string;
  kind: BrainstormActivityKind;
  text: string | null;
  createdAt: number;
}

export interface BrainstormActor {
  email: string;
  name: string;
}

export interface BrainstormSource {
  title: string;
  url?: string | null;
}

export interface BrainstormIdea {
  id: string;
  brainstormId: string;
  cluster: string | null;
  title: string;
  body: string;
  rationale: string | null;
  tags: string[];
  impact: number | null;
  effort: number | null;
  starred: boolean;
  status: BrainstormIdeaStatus;
  sources: BrainstormSource[];
  author: BrainstormIdeaAuthor;
  authorEmail?: string | null;
  authorName?: string | null;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface BrainstormExperiment {
  ideaId?: string | null;
  title: string;
  steps: string;
}

export interface BrainstormBrief {
  summary: string;
  rankedIdeaIds: string[];
  experiments: BrainstormExperiment[];
  openQuestions: string[];
  sources: BrainstormSource[];
}

export interface Brainstorm {
  id: string;
  sessionId: string;
  topic: string;
  goal: string | null;
  technique: BrainstormTechnique;
  profileSnapshot: BrainstormProfileSnapshot;
  signals: BrainstormSignal[];
  phase: BrainstormPhase;
  status: BrainstormStatus;
  brief: BrainstormBrief | null;
  roomId?: string | null;
  role?: 'owner' | 'member' | null;
  createdAt: number;
  updatedAt: number;
}

export interface BrainstormDetail extends Brainstorm {
  ideas: BrainstormIdea[];
  activity?: BrainstormActivity[];
}

export interface BrainstormSummary {
  id: string;
  sessionId: string;
  topic: string;
  goal: string | null;
  technique: BrainstormTechnique;
  phase: BrainstormPhase;
  status: BrainstormStatus;
  ideaCount: number;
  starredCount: number;
  topIdeaTitles: string[];
  shared?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface BrainstormIdeaDraft {
  title: string;
  body?: string;
  rationale?: string | null;
  tags?: string[];
  impact?: number | null;
  effort?: number | null;
  cluster?: string | null;
  sources?: BrainstormSource[];
  starred?: boolean;
}

export type BrainstormIdeaPatch = Partial<
  Pick<
    BrainstormIdea,
    | 'title'
    | 'body'
    | 'rationale'
    | 'tags'
    | 'impact'
    | 'effort'
    | 'cluster'
    | 'sources'
    | 'starred'
    | 'status'
  >
>;

export interface BrainstormCreateInput {
  topic: string;
  goal?: string | null;
  technique?: BrainstormTechnique;
  profile?: Partial<BrainstormProfileSnapshot>;
  filePaths?: string[];
}

export interface BrainstormPerson {
  email: string;
  name: string;
  title: string | null;
  image: string | null;
}

export const BRAINSTORM_PHASE_LABELS: Record<BrainstormPhase, string> = {
  frame: 'Question',
  research: 'Research',
  diverge: 'Ideas',
  cluster: 'Group',
  converge: 'Shortlist',
  wrapup: 'Summary',
};

export const BRAINSTORM_TECHNIQUE_LABELS: Record<BrainstormTechnique, string> = {
  auto: 'Auto',
  hmw: 'How might we',
  scamper: 'SCAMPER',
  reverse: 'Reverse',
  'first-principles': 'First principles',
  jtbd: 'Jobs to be done',
};

export const BRAINSTORM_TECHNIQUE_DESCRIPTIONS: Record<BrainstormTechnique, string> = {
  auto: 'York picks the method that fits the topic.',
  hmw: 'Frames the problem as an open question and generates options.',
  scamper:
    'Pushes the idea by substituting, combining, adapting, modifying, putting it to another use, eliminating, or reversing it.',
  reverse: 'Starts from the opposite of the goal and works backward.',
  'first-principles': 'Strips the topic down to what is actually true, then builds up from there.',
  jtbd: 'Looks at the job someone is hiring this idea to do.',
};

export function isBrainstormPhase(value: string): value is BrainstormPhase {
  return (BRAINSTORM_PHASES as readonly string[]).includes(value);
}

export function isBrainstormTechnique(value: string): value is BrainstormTechnique {
  return (BRAINSTORM_TECHNIQUES as readonly string[]).includes(value);
}

export function emptyProfileSnapshot(): BrainstormProfileSnapshot {
  return {
    name: '',
    email: '',
    title: null,
    functionName: null,
    squad: null,
    department: null,
    roleNote: null,
  };
}

/** `/brainstorm` or `/brainstorm <topic>`. Null when the text is not that command. */
export function parseBrainstormCommand(text: string): string | null {
  const match = text.trim().match(/^\/brainstorm(?:\s+|$)([\s\S]*)$/i);
  if (!match) return null;
  return match[1].trim();
}

export function summaryFromDetail(detail: BrainstormDetail): BrainstormSummary {
  const ideas = detail.ideas || [];
  const active = ideas.filter((idea) => idea.status === 'active');
  const starred = active.filter((idea) => idea.starred);
  const titles = (starred.length > 0 ? starred : active).slice(0, 3).map((idea) => idea.title);
  return {
    id: detail.id,
    sessionId: detail.sessionId,
    topic: detail.topic,
    goal: detail.goal,
    technique: detail.technique,
    phase: detail.phase,
    status: detail.status,
    ideaCount: active.length,
    starredCount: ideas.filter((idea) => idea.starred && idea.status === 'active').length,
    topIdeaTitles: titles,
    shared: Boolean(detail.roomId),
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}

export function profileContextLine(profile: BrainstormProfileSnapshot): string {
  const role = [profile.title, profile.functionName || profile.department, profile.squad]
    .filter(Boolean)
    .join(', ');
  if (role) {
    return `Brainstorming as ${role}. Will research the latest news.`;
  }
  if (profile.name) {
    return `Brainstorming with ${profile.name}. Will research the latest news.`;
  }
  return 'Will research the latest news and how people in this field approach the problem.';
}
