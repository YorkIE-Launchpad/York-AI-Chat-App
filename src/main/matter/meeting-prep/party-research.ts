/**
 * One-off meeting party research: who each attendee is (Hub for York people,
 * Hub clients + company site + long-window threads for external parties).
 */

import { fetchWebPage } from '../../tools/web-fetch';
import { logWarn } from '../../utils/logger';
import { YORK_EMAIL_RE, displayName, summarizeHubEmployee } from '../matter-calendar-enrichment';
import {
  envelopeBody,
  findToolName,
  htmlToPlainSnippet,
  mapWithConcurrency,
  resolveHubServerId,
  safeCallTool,
} from './connectors';
import { otherAttendees, searchGmail, searchSlack, type GatherDeps } from './gather';
import type { CalendarAttendee, MeetingPrepContext, PartyProfile } from './types';

export const PARTY_LOOKBACK_DAYS = 180;

const FREEMAIL_RE =
  /^(gmail|googlemail|yahoo|outlook|hotmail|live|icloud|me|aol|proton|protonmail|zoho)\.[a-z.]+$/i;

export function splitAttendees(
  attendees: CalendarAttendee[],
  selfEmail: string | null
): { internal: CalendarAttendee[]; external: CalendarAttendee[] } {
  const others = otherAttendees(attendees, selfEmail);
  return {
    internal: others.filter((a) => !a.email || YORK_EMAIL_RE.test(a.email)),
    external: others.filter((a) => a.email && !YORK_EMAIL_RE.test(a.email)),
  };
}

/** Company domains of external attendees (freemail excluded), most frequent first. */
export function externalDomains(external: CalendarAttendee[]): string[] {
  const counts = new Map<string, number>();
  for (const a of external) {
    const domain = a.email.split('@')[1]?.toLowerCase();
    if (!domain || FREEMAIL_RE.test(domain)) continue;
    counts.set(domain, (counts.get(domain) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d);
}

/** `acme-labs.co.uk` → `Acme Labs`. */
export function companyNameFromDomain(domain: string): string {
  const parts = domain.toLowerCase().split('.');
  const secondLevel = new Set(['co', 'com', 'org', 'net', 'ac', 'gov']);
  let root = parts[0] || domain;
  if (parts.length >= 3 && secondLevel.has(parts[parts.length - 2])) {
    root = parts[parts.length - 3];
  } else if (parts.length >= 2) {
    root = parts[parts.length - 2];
  }
  return root
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

async function researchInternal(
  deps: GatherDeps,
  people: CalendarAttendee[]
): Promise<PartyProfile[]> {
  const hubId = resolveHubServerId(deps.mcp);
  const empTool = hubId
    ? findToolName(deps.mcp, hubId, ['search_employees', 'list_employees', 'get_employee'])
    : null;
  return mapWithConcurrency(people.slice(0, 5), 3, async (a) => {
    const profile: PartyProfile = {
      name: a.name && !a.name.includes('@') ? a.name : displayName(a),
      email: a.email,
      internal: true,
      org: 'York IE',
      evidenceIds: [],
    };
    if (!empTool || !a.email) return profile;
    const text = await safeCallTool(deps.mcp, empTool, {
      email: a.email,
      query: a.email,
      search: a.email,
      limit: 3,
    });
    const summary = text ? summarizeHubEmployee(text, a.email) : null;
    if (summary) {
      profile.evidenceIds.push(
        deps.pool.add({
          source: 'hub',
          title: `Hub profile: ${profile.name}`,
          excerpt: summary,
          people: [a.email],
          tags: [`party:${a.email}`],
        })
      );
      deps.connectors.hit('hub');
    }
    return profile;
  });
}

async function researchDomain(
  deps: GatherDeps,
  domain: string,
  people: CalendarAttendee[]
): Promise<string[]> {
  const company = companyNameFromDomain(domain);
  const tags = [`party:${domain}`];
  const ids: string[] = [];
  const after = new Date(Date.now() - PARTY_LOOKBACK_DAYS * 864e5).toISOString().slice(0, 10);

  const hubId = resolveHubServerId(deps.mcp);
  const clientTool = hubId
    ? findToolName(deps.mcp, hubId, ['list_clients', 'search_clients'])
    : null;
  const jobs: Array<Promise<unknown>> = [];

  if (clientTool) {
    jobs.push(
      (async () => {
        const text = await safeCallTool(deps.mcp, clientTool, {
          search: company,
          query: company,
          limit: 20,
        });
        if (!text) return;
        const body = envelopeBody(text);
        const needle = company.toLowerCase().split(' ')[0];
        const idx = body.toLowerCase().indexOf(needle);
        if (idx < 0) return;
        ids.push(
          deps.pool.add({
            source: 'hub',
            title: `Hub client record: ${company}`,
            excerpt: body.slice(Math.max(0, idx - 80), idx + 500),
            tags,
          })
        );
        deps.connectors.hit('hub');
      })()
    );
  }

  jobs.push(
    (async () => {
      deps.connectors.mark('web', 'Web', 'checked');
      const url = `https://${domain}`;
      try {
        const fetched = await fetchWebPage(url);
        const snippet = htmlToPlainSnippet(fetched, 500);
        if (snippet && snippet !== '(no readable text)') {
          ids.push(
            deps.pool.add({
              source: 'web',
              title: `${company} website`,
              excerpt: snippet,
              url,
              tags,
            })
          );
          deps.connectors.hit('web');
        }
      } catch (error) {
        logWarn('[Matter] Prep domain fetch failed:', url, error);
      }
    })()
  );

  jobs.push(
    (async () => {
      const found = await searchGmail(
        deps,
        `newer_than:${PARTY_LOOKBACK_DAYS}d (from:@${domain} OR to:@${domain})`,
        { maxHits: 4, limit: 8, tags }
      );
      ids.push(...found);
    })()
  );

  const fullNames = people
    .map((p) => (p.name && !p.name.includes('@') ? p.name.trim() : ''))
    .filter((n) => n.includes(' '));
  // Slack search has no OR: one query per company / person name.
  const slackQueries = [...new Set([company, ...fullNames.slice(0, 2)])]
    .filter((t) => t.length >= 3)
    .map((t) => (t.includes(' ') ? `"${t}"` : t))
    .map((t) => `${t} after:${after}`);
  jobs.push(
    (async () => {
      const found = await mapWithConcurrency(slackQueries, 3, (q) =>
        searchSlack(deps, q, { maxHits: 3, limit: 8, tags, deepenThreads: 1 })
      );
      ids.push(...found.flat());
    })()
  );

  await Promise.all(jobs);
  return ids;
}

/** Build profiles for everyone in a one-off meeting and collect their evidence. */
export async function researchParties(input: {
  deps: GatherDeps;
  ctx: MeetingPrepContext;
}): Promise<PartyProfile[]> {
  const { deps, ctx } = input;
  const { internal, external } = splitAttendees(ctx.attendees, ctx.selfEmail);
  const domains = externalDomains(external).slice(0, 2);

  const [internalProfiles, domainIds] = await Promise.all([
    researchInternal(deps, internal),
    mapWithConcurrency(domains, 2, (domain) =>
      researchDomain(
        deps,
        domain,
        external.filter((a) => a.email.toLowerCase().endsWith(`@${domain}`))
      )
    ),
  ]);

  const byDomain = new Map(domains.map((d, i) => [d, domainIds[i] || []]));
  const externalProfiles: PartyProfile[] = await mapWithConcurrency(
    external.slice(0, 6),
    2,
    async (a) => {
      const domain = a.email.split('@')[1]?.toLowerCase() || '';
      const evidenceIds = [...(byDomain.get(domain) || [])];
      if (!byDomain.has(domain)) {
        // Freemail or beyond the domain cap: fall back to person-level threads.
        evidenceIds.push(
          ...(await searchGmail(
            deps,
            `newer_than:${PARTY_LOOKBACK_DAYS}d (from:${a.email} OR to:${a.email})`,
            { maxHits: 2, limit: 5, tags: [`party:${a.email}`] }
          ))
        );
      }
      return {
        name: a.name && !a.name.includes('@') ? a.name : displayName(a),
        email: a.email,
        internal: false,
        org: domain && !FREEMAIL_RE.test(domain) ? companyNameFromDomain(domain) : undefined,
        evidenceIds,
      };
    }
  );

  return [...externalProfiles, ...internalProfiles];
}
