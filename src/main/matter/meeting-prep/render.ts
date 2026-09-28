import { MEETING_PREP_KIND_LABELS, MEETING_PREP_MARKER } from '../../../shared/matter';
import type {
  ActionStatus,
  ConnectorPrepStatus,
  MeetingKind,
  MeetingPrepContext,
  PrepBrief,
  PrepClaim,
  PrepEvidence,
} from './types';

const STATUS_LABELS: Record<ActionStatus, string> = {
  done: 'Done',
  in_progress: 'In progress',
  open: 'Still open',
  unknown: 'No update found',
};

/** `2026-09-28T10:00:00+05:30 → …` → `Mon, Sep 28, 10:00`. */
export function formatWhen(when: string, startIso: string | null): string {
  const start = startIso || when.split('→')[0]?.trim() || '';
  const ms = Date.parse(start);
  if (!Number.isFinite(ms)) return when.trim();
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(start);
  return new Date(ms).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(allDay ? {} : { hour: '2-digit', minute: '2-digit', hour12: false }),
  });
}

function sourceLine(e: PrepEvidence): string {
  const label = e.title.replace(/[[\]]/g, '');
  return e.url ? `[${label}](${e.url})` : label;
}

export function renderPrepBrief(input: {
  ctx: MeetingPrepContext;
  kind: MeetingKind;
  cadence: string | null;
  lastHeld: string | null;
  actionItemsFrom: string | null;
  brief: PrepBrief;
  evidence: PrepEvidence[];
  connectors: ConnectorPrepStatus[];
}): string {
  const { ctx, kind, cadence, lastHeld, actionItemsFrom, brief, connectors } = input;
  const byId = new Map(input.evidence.map((e) => [e.id, e]));
  const numbers = new Map<string, number>();
  const cited: PrepEvidence[] = [];

  const cite = (ids: string[]): string => {
    const refs: number[] = [];
    for (const id of ids) {
      const e = byId.get(id);
      if (!e) continue;
      let n = numbers.get(id);
      if (!n) {
        n = cited.length + 1;
        numbers.set(id, n);
        cited.push(e);
      }
      if (!refs.includes(n)) refs.push(n);
    }
    return refs.length ? ` ${refs.map((n) => `[${n}]`).join('')}` : '';
  };

  const section = (heading: string, lines: string[]): string[] =>
    lines.length ? [`### ${heading}`, ...lines, ''] : [];
  const claimLines = (items: PrepClaim[]): string[] =>
    items.map((c) => `- ${c.text}${cite(c.evidenceIds)}`);

  const kindLabel =
    kind === 'recurring'
      ? `${MEETING_PREP_KIND_LABELS.recurring}${cadence ? ` (${cadence})` : ''}`
      : MEETING_PREP_KIND_LABELS.one_off;
  const headerBits = [
    `**${ctx.title.trim() || 'Untitled meeting'}**`,
    formatWhen(ctx.when, ctx.startIso),
    kindLabel,
    kind === 'recurring' && lastHeld ? `last held ${lastHeld}` : '',
  ].filter(Boolean);

  const out: string[] = [MEETING_PREP_MARKER, '', headerBits.join(' · '), ''];
  out.push(`**Bottom line:** ${brief.bottomLine}`, '');

  if (kind === 'recurring') {
    out.push(...section('Since last time', claimLines(brief.whatChanged)));
    out.push(
      ...section(
        `Action items from ${actionItemsFrom || lastHeld || 'last time'}`,
        brief.actionReview.map((a) => {
          const owner = a.owner ? ` (${a.owner})` : '';
          const note = a.note ? `: ${a.note}` : '';
          return `- **${STATUS_LABELS[a.status]}:** ${a.item}${owner}${note}${cite(a.evidenceIds)}`;
        })
      )
    );
  } else {
    out.push(
      ...section(
        "Who you're meeting",
        brief.peopleNotes.map((p) => `- **${p.name}**: ${p.note}${cite(p.evidenceIds)}`)
      )
    );
    out.push(...section('Context so far', claimLines(brief.contextSoFar)));
  }

  out.push(
    ...section(
      'Agenda',
      brief.agenda.map((a, i) => {
        const meta = [a.minutes ? `${a.minutes} min` : '', a.owner || '']
          .filter(Boolean)
          .join(', ');
        const why = a.why ? ` - ${a.why}` : '';
        return `${i + 1}. **${a.topic}**${meta ? ` (${meta})` : ''}${why}${cite(a.evidenceIds)}`;
      })
    )
  );
  out.push(...section('Questions to ask', claimLines(brief.questionsToAsk)));
  out.push(...section('Risks / watch-outs', claimLines(brief.risks)));

  out.push('---', '', '**Sources**', '');
  cited.forEach((e, i) => out.push(`${i + 1}. ${sourceLine(e)}`));

  const checked = connectors.filter((c) => c.status !== 'skipped').map((c) => c.label);
  const disconnected = connectors
    .filter((c) => c.status === 'skipped' && c.reason === 'disconnected')
    .map((c) => c.label);
  const footer = [
    checked.length ? `Checked: ${checked.join(', ')}` : '',
    disconnected.length ? `Not connected: ${disconnected.join(', ')}` : '',
  ].filter(Boolean);
  if (footer.length) out.push('', `_${footer.join(' · ')}_`);

  return out.join('\n').trim();
}
