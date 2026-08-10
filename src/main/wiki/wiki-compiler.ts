/**
 * Compress Matter items / meetings / connector artifacts into wiki pages.
 */
import type { MatterItem } from '../../shared/matter';
import type { WikiPageInput, WikiSourceRef } from '../../shared/wiki';
import { buildWikiPath } from './wiki-store';

function categoryFolder(item: MatterItem): string {
  switch (item.category) {
    case 'client':
      return 'clients';
    case 'people':
      return 'people';
    case 'delivery':
      return 'projects';
    case 'comms':
      return 'threads';
    case 'time':
      return 'time';
    default:
      return 'ops';
  }
}

export function compileMatterItemToWikiPage(item: MatterItem): WikiPageInput {
  const folder = categoryFolder(item);
  const sources: WikiSourceRef[] = [
    {
      kind: 'matter',
      id: item.id,
      label: item.source,
      fingerprint: item.fingerprint,
    },
  ];
  const body = [
    item.summary,
    '',
    item.whyItMatters ? `**Why it matters:** ${item.whyItMatters}` : '',
    item.suggestedAction ? `**Suggested:** ${item.suggestedAction}` : '',
    item.rawDetails ? `\n### Source excerpt\n\n${item.rawDetails.slice(0, 2000)}` : '',
    '',
    `Severity: ${item.severity} · Orbit: ${item.orbit} · Source: ${item.source}`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    path: buildWikiPath(folder, item.title),
    title: item.title,
    body,
    score: item.rankScore,
    sources,
    divisionKey: null,
  };
}

export function compileMeetingToWikiPage(meeting: {
  id: string;
  title: string;
  startedAt: number;
  notes: { title?: string; summary?: string; actionItems?: string[]; keyTopics?: string[] };
}): WikiPageInput {
  const title = (meeting.notes.title || meeting.title || 'Meeting').trim();
  const dateKey = new Date(meeting.startedAt).toISOString().slice(0, 10);
  const actions = meeting.notes.actionItems || [];
  const topics = meeting.notes.keyTopics || [];
  const body = [
    meeting.notes.summary || '',
    topics.length ? `**Topics:** ${topics.join('; ')}` : '',
    actions.length ? `**Action items:**\n${actions.map((a) => `- ${a}`).join('\n')}` : '',
    '',
    `Date: ${dateKey}`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    path: buildWikiPath('meetings', `${dateKey}-${title}`),
    title,
    body,
    score: 50,
    sources: [{ kind: 'meeting', id: meeting.id, label: title }],
    divisionKey: null,
  };
}

export function compileConnectorArtifactToWikiPage(input: {
  connectorId: string;
  externalId: string;
  title: string;
  summary: string;
  content: string;
}): WikiPageInput {
  return {
    path: buildWikiPath(input.connectorId, `${input.title}-${input.externalId}`),
    title: input.title,
    body: [input.summary, '', input.content.slice(0, 4000)].filter(Boolean).join('\n'),
    score: 40,
    sources: [
      {
        kind: 'connector',
        id: input.externalId,
        label: input.connectorId,
      },
    ],
    divisionKey: null,
  };
}
