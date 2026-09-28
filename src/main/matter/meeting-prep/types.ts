import type { CalendarAttendee, ConnectorPrepStatus } from '../matter-calendar-enrichment';

export type MeetingKind = 'recurring' | 'one_off';

export type PrepSource =
  | 'calendar'
  | 'slack'
  | 'gmail'
  | 'meeting'
  | 'hub'
  | 'drive'
  | 'jira'
  | 'launchpad'
  | 'confluence'
  | 'web';

export interface PrepEvidence {
  /** Stable id the LLM cites, e.g. `E3`. */
  id: string;
  source: PrepSource;
  /** Short human label used in the Sources list. */
  title: string;
  excerpt: string;
  url?: string;
  /** ISO date or human date when known. */
  when?: string;
  people?: string[];
  /** Routing tags, e.g. `action:0`, `party:acme.com`, `invite`. */
  tags?: string[];
}

export type NewPrepEvidence = Omit<PrepEvidence, 'id'>;

const EXCERPT_MAX = 600;

/** Deduplicating evidence collector that hands out `E<n>` ids. */
export class EvidencePool {
  private readonly items: PrepEvidence[] = [];
  private readonly keys = new Map<string, string>();

  add(input: NewPrepEvidence): string {
    const excerpt = input.excerpt.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX);
    const key = input.url
      ? `url:${input.url}`
      : `${input.source}:${input.title.toLowerCase()}:${excerpt.slice(0, 60).toLowerCase()}`;
    const existing = this.keys.get(key);
    if (existing) {
      if (input.tags?.length) {
        const item = this.items.find((e) => e.id === existing);
        if (item) item.tags = [...new Set([...(item.tags || []), ...input.tags])];
      }
      return existing;
    }
    const id = `E${this.items.length + 1}`;
    this.items.push({ ...input, excerpt, id });
    this.keys.set(key, id);
    return id;
  }

  get(id: string): PrepEvidence | undefined {
    return this.items.find((e) => e.id === id);
  }

  list(): PrepEvidence[] {
    return [...this.items];
  }

  withTag(tag: string): PrepEvidence[] {
    return this.items.filter((e) => e.tags?.includes(tag));
  }
}

export interface CalendarInstance {
  id: string;
  title: string;
  start: string;
  end?: string;
  htmlLink?: string | null;
  recurringEventId?: string | null;
}

export interface PriorActionItem {
  text: string;
  owner?: string;
  /** Evidence id of the meeting notes the item came from. */
  originEvidenceId: string;
  fromDate?: string;
  /** Evidence gathered while verifying the item (excludes origin). */
  evidenceIds: string[];
}

export interface SeriesHistory {
  seriesId: string | null;
  cadence: string | null;
  pastInstances: CalendarInstance[];
  /** ISO date (YYYY-MM-DD) of the most recent past occurrence. */
  lastHeld: string | null;
  actionItems: PriorActionItem[];
  /** Date the action items were captured (the prior meeting with notes). */
  actionItemsFrom: string | null;
}

export interface PartyProfile {
  name: string;
  email: string;
  internal: boolean;
  org?: string;
  evidenceIds: string[];
}

export type ActionStatus = 'done' | 'in_progress' | 'open' | 'unknown';

export interface PrepClaim {
  text: string;
  evidenceIds: string[];
}

export interface PrepAgendaItem {
  topic: string;
  why: string;
  owner?: string;
  minutes?: number;
  evidenceIds: string[];
}

export interface PrepActionReview {
  item: string;
  owner?: string;
  status: ActionStatus;
  note?: string;
  evidenceIds: string[];
}

export interface PrepPeopleNote {
  name: string;
  note: string;
  evidenceIds: string[];
}

export interface PrepBrief {
  purpose: string;
  bottomLine: string;
  whatChanged: PrepClaim[];
  contextSoFar: PrepClaim[];
  actionReview: PrepActionReview[];
  agenda: PrepAgendaItem[];
  questionsToAsk: PrepClaim[];
  risks: PrepClaim[];
  peopleNotes: PrepPeopleNote[];
}

export interface MeetingPrepContext {
  eventId: string | null;
  title: string;
  /** Raw `start → end` label from the calendar. */
  when: string;
  startIso: string | null;
  attendees: CalendarAttendee[];
  eventUrl?: string;
  inviteBody: string;
  selfEmail: string | null;
}

export type { CalendarAttendee, ConnectorPrepStatus };
