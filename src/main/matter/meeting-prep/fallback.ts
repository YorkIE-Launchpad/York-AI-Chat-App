/**
 * Deterministic brief used when synthesis is unavailable. Same shape as the
 * LLM brief so rendering stays identical; action statuses are all `unknown`.
 */

import type {
  MeetingKind,
  MeetingPrepContext,
  PartyProfile,
  PrepAgendaItem,
  PrepBrief,
  PrepEvidence,
  SeriesHistory,
} from './types';

function firstSentence(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const sentence = clean.split(/(?<=[.!?])\s/)[0] || clean;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

export function buildFallbackBrief(input: {
  ctx: MeetingPrepContext;
  kind: MeetingKind;
  evidence: PrepEvidence[];
  history: SeriesHistory | null;
  parties: PartyProfile[];
  inviteEvidenceId: string;
}): PrepBrief {
  const { ctx, kind, evidence, history, parties, inviteEvidenceId } = input;
  const invite = [inviteEvidenceId];
  const context = evidence.filter(
    (e) =>
      ['slack', 'gmail', 'jira', 'drive', 'confluence'].includes(e.source) &&
      !e.tags?.some((t) => t.startsWith('action:'))
  );
  const agenda: PrepAgendaItem[] = [];

  if (kind === 'recurring') {
    const priorNotes = evidence.find((e) => e.tags?.includes('prior-meeting'));
    if (history?.actionItems.length) {
      agenda.push({
        topic: `Review action items from ${history.actionItemsFrom || 'last time'}`,
        why: `${history.actionItems.length} item(s) were assigned; no automated status check was possible.`,
        minutes: 10,
        evidenceIds: [history.actionItems[0].originEvidenceId],
      });
    } else if (priorNotes) {
      agenda.push({
        topic: 'Follow up on last session',
        why: firstSentence(priorNotes.excerpt),
        minutes: 10,
        evidenceIds: [priorNotes.id],
      });
    }
  } else {
    agenda.push({
      topic: 'Introductions and goals for this meeting',
      why: 'Align on why everyone is here and what a good outcome looks like.',
      minutes: 5,
      evidenceIds: invite,
    });
  }

  for (const e of context.slice(0, 2)) {
    agenda.push({
      topic: e.title.replace(/^(Email|Slack|Jira|Drive|Confluence):?\s*/i, '').slice(0, 100),
      why: firstSentence(e.excerpt),
      minutes: 10,
      evidenceIds: [e.id],
    });
  }
  agenda.push({
    topic: 'Agree next steps and owners',
    why: 'Leave with named owners and dates.',
    minutes: 5,
    evidenceIds: invite,
  });

  const claims = context.slice(0, 3).map((e) => ({
    text: `${e.title}: ${firstSentence(e.excerpt, 160)}`,
    evidenceIds: [e.id],
  }));

  return {
    purpose: ctx.title,
    bottomLine:
      'Automatic summary was unavailable, so this is a basic brief built from the invite and the sources found.',
    whatChanged: kind === 'recurring' ? claims : [],
    contextSoFar: kind === 'one_off' ? claims : [],
    actionReview: (history?.actionItems || []).map((a) => ({
      item: a.text,
      owner: a.owner,
      status: 'unknown' as const,
      evidenceIds: [],
    })),
    agenda,
    questionsToAsk: [],
    risks: [],
    peopleNotes: parties
      .filter((p) => p.evidenceIds.length)
      .slice(0, 4)
      .map((p) => ({
        name: p.name,
        note: [p.org, p.internal ? 'internal' : 'external'].filter(Boolean).join(' · '),
        evidenceIds: p.evidenceIds.slice(0, 1),
      })),
  };
}
