import type { BrainstormActivity, BrainstormIdea } from '../../../shared/brainstorm-types';

const ACTION: Record<BrainstormActivity['kind'], string> = {
  idea_added: 'added an idea',
  thought: 'added a thought',
  starred: 'starred',
  discarded: 'set aside',
  edited: 'edited',
  phase: 'moved the phase',
  joined: 'joined',
  brief_saved: 'saved the brief',
  file_added: 'added a file',
};

function dayLabel(ms: number): string {
  const date = new Date(ms);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return 'Today';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function ActivityTimeline({
  activity,
  ideas,
}: {
  activity: BrainstormActivity[];
  ideas: BrainstormIdea[];
}) {
  const titles = new Map(ideas.map((idea) => [idea.id, idea.title]));
  const ordered = [...activity].sort((a, b) => a.createdAt - b.createdAt);
  if (ordered.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border-subtle px-4 py-8 text-center text-[13px] text-text-muted">
        Thoughts, stars, and new ideas show up here as people add them.
      </p>
    );
  }
  let lastDay = '';
  return (
    <ol className="space-y-3">
      {ordered.map((row) => {
        const day = dayLabel(row.createdAt);
        const showDay = day !== lastDay;
        lastDay = day;
        const ideaTitle = row.ideaId ? titles.get(row.ideaId) : '';
        const initial = (row.actorName || '?').slice(0, 1).toUpperCase();
        return (
          <li key={row.id}>
            {showDay ? (
              <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">
                {day}
              </p>
            ) : null}
            <div className="flex gap-2">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface text-[11px] font-semibold text-text-secondary">
                {initial}
              </span>
              <div className="min-w-0">
                <p className="text-[12.5px] text-text-primary">
                  <span className="font-medium">{row.actorName || 'Someone'}</span>{' '}
                  <span className="text-text-secondary">{ACTION[row.kind]}</span>
                  {ideaTitle ? <span className="text-text-secondary"> · {ideaTitle}</span> : null}
                  <span className="text-text-muted"> · {timeLabel(row.createdAt)}</span>
                </p>
                {row.text && row.kind !== 'phase' ? (
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-secondary">
                    {row.text}
                  </p>
                ) : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
