import type { BrainstormSummary } from '../../../shared/brainstorm-types';
import { BRAINSTORM_PHASE_LABELS } from '../../../shared/brainstorm-types';

function when(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function BrainstormLibrary({
  items,
  onOpen,
  onDelete,
}: {
  items: BrainstormSummary[];
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (items.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-border-subtle px-4 py-8 text-center text-[13px] text-text-muted">
        Past brainstorms show up here. Each one keeps its board, the chat, and the brief.
      </p>
    );
  }
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {items.map((item) => (
        <li key={item.id}>
          <article className="flex h-full flex-col rounded-2xl border border-border-subtle bg-background p-3">
            <button type="button" onClick={() => onOpen(item.id)} className="text-left">
              <p className="text-[11px] text-text-muted">
                {BRAINSTORM_PHASE_LABELS[item.phase]} · {when(item.updatedAt)}
                {item.status === 'wrapped' ? ' · brief' : ''}
                {item.shared ? ' · shared' : ''}
              </p>
              <h3 className="mt-1 text-[14px] font-semibold text-text-primary">{item.topic}</h3>
              {item.goal ? (
                <p className="mt-0.5 text-[12px] text-text-secondary">{item.goal}</p>
              ) : null}
              {(item.topIdeaTitles || []).length > 0 ? (
                <p className="mt-2 line-clamp-2 text-[12px] text-text-muted">
                  {(item.topIdeaTitles || []).join(' · ')}
                </p>
              ) : (
                <p className="mt-2 text-[12px] text-text-muted">{item.ideaCount} ideas</p>
              )}
            </button>
            <button
              type="button"
              onClick={() => onDelete(item.id)}
              className="mt-2 self-start text-[11px] text-text-muted hover:text-text-primary"
            >
              Delete
            </button>
          </article>
        </li>
      ))}
    </ul>
  );
}
