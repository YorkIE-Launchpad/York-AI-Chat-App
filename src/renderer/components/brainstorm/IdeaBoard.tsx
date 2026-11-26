import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import type {
  BrainstormActivity,
  BrainstormIdea,
  BrainstormIdeaPatch,
} from '../../../shared/brainstorm-types';
import { IdeaCard, ThoughtNotes } from './IdeaCard';

export function IdeaBoard({
  ideas,
  selectedIds,
  onToggleSelect,
  onPatch,
  onAdd,
  onThought,
  activity,
}: {
  ideas: BrainstormIdea[];
  selectedIds: string[];
  onToggleSelect: (id: string) => void;
  onPatch: (id: string, patch: BrainstormIdeaPatch) => void;
  onAdd: (title: string, body: string) => void;
  onThought: (ideaId: string | null, text: string) => void;
  activity: BrainstormActivity[];
}) {
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [freeThought, setFreeThought] = useState('');
  const visible = ideas.filter((idea) => (showDiscarded ? true : idea.status === 'active'));
  const groups = useMemo(() => {
    const map = new Map<string, BrainstormIdea[]>();
    for (const idea of visible) {
      const key = idea.cluster?.trim() || 'Ungrouped';
      const list = map.get(key) || [];
      list.push(idea);
      map.set(key, list);
    }
    const ungrouped = map.get('Ungrouped');
    map.delete('Ungrouped');
    const entries = [...map.entries()];
    if (ungrouped) entries.push(['Ungrouped', ungrouped]);
    return entries;
  }, [visible]);
  const thoughts = activity.filter((row) => row.kind === 'thought' && row.text);
  const looseThoughts = thoughts.filter((row) => !row.ideaId);
  const thoughtsByIdea = new Map<string, BrainstormActivity[]>();
  for (const row of thoughts) {
    if (!row.ideaId) continue;
    const list = thoughtsByIdea.get(row.ideaId) || [];
    list.push(row);
    thoughtsByIdea.set(row.ideaId, list);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[12px] text-text-muted">
          {ideas.filter((idea) => idea.status === 'active').length} ideas
        </p>
        <button
          type="button"
          className="text-[11px] text-text-muted hover:text-text-primary"
          onClick={() => setShowDiscarded((value) => !value)}
        >
          {showDiscarded ? 'Hide discarded' : 'Show discarded'}
        </button>
      </div>
      {looseThoughts.length > 0 ? (
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
            Thoughts
          </p>
          <ThoughtNotes thoughts={looseThoughts} />
        </div>
      ) : null}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const text = freeThought.trim();
          if (!text) return;
          onThought(null, text);
          setFreeThought('');
        }}
      >
        <input
          value={freeThought}
          onChange={(event) => setFreeThought(event.target.value)}
          placeholder="Add a thought for the group"
          className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-background px-2.5 py-1.5 text-[13px] text-text-primary"
        />
      </form>
      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border-subtle px-4 py-8 text-center text-[13px] text-text-muted">
          Ideas show up here. Star the ones you want to keep.
        </p>
      ) : (
        groups.map(([cluster, cards]) => (
          <section key={cluster}>
            {cluster === 'Ungrouped' && groups.length === 1 ? null : (
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                {cluster}
              </h3>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              {cards.map((idea) => (
                <IdeaCard
                  key={idea.id}
                  idea={idea}
                  selected={selectedIds.includes(idea.id)}
                  onToggleSelect={() => onToggleSelect(idea.id)}
                  onPatch={(patch) => onPatch(idea.id, patch)}
                  onThought={(text) => onThought(idea.id, text)}
                  thoughts={thoughtsByIdea.get(idea.id) || []}
                />
              ))}
            </div>
          </section>
        ))
      )}
      <form
        className="rounded-xl border border-border-subtle bg-surface/60 p-3"
        onSubmit={(event) => {
          event.preventDefault();
          const title = draftTitle.trim();
          if (!title) return;
          onAdd(title, draftBody.trim());
          setDraftTitle('');
          setDraftBody('');
        }}
      >
        <p className="mb-2 text-[12px] font-medium text-text-secondary">Add your own</p>
        <input
          value={draftTitle}
          onChange={(event) => setDraftTitle(event.target.value)}
          placeholder="Idea title"
          className="mb-2 w-full rounded-lg border border-border-subtle bg-background px-2.5 py-1.5 text-[13px] text-text-primary"
        />
        <textarea
          value={draftBody}
          onChange={(event) => setDraftBody(event.target.value)}
          placeholder="Pitch"
          rows={2}
          className="mb-2 w-full resize-none rounded-lg border border-border-subtle bg-background px-2.5 py-1.5 text-[12.5px] text-text-secondary"
        />
        <button
          type="submit"
          className="inline-flex items-center gap-1 rounded-full bg-text-primary px-3 py-1 text-[12px] text-background"
        >
          <Plus className="h-3.5 w-3.5" />
          Add to board
        </button>
      </form>
    </div>
  );
}
