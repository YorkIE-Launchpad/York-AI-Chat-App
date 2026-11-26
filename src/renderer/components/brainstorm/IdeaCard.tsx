import { useState } from 'react';
import { Star, Trash2 } from 'lucide-react';
import type {
  BrainstormActivity,
  BrainstormIdea,
  BrainstormIdeaPatch,
} from '../../../shared/brainstorm-types';

export function ThoughtNotes({ thoughts }: { thoughts: BrainstormActivity[] }) {
  if (thoughts.length === 0) return null;
  const ordered = [...thoughts].sort((a, b) => a.createdAt - b.createdAt);
  return (
    <ul className="mt-2 space-y-1.5">
      {ordered.map((row) => (
        <li key={row.id} className="rounded-lg bg-surface px-2 py-1.5">
          <p className="text-[11px] font-medium text-text-muted">{row.actorName || 'You'}</p>
          <p className="text-[12.5px] leading-relaxed text-text-secondary">{row.text}</p>
        </li>
      ))}
    </ul>
  );
}

function Score({ label, value }: { label: string; value: number | null }) {
  if (value == null) return null;
  return (
    <span className="text-[10px] uppercase tracking-wide text-text-muted">
      {label} {value}
    </span>
  );
}

export function IdeaCard({
  idea,
  selected,
  onToggleSelect,
  onPatch,
  onThought,
  thoughts,
}: {
  idea: BrainstormIdea;
  selected: boolean;
  onToggleSelect: () => void;
  onPatch: (patch: BrainstormIdeaPatch) => void;
  onThought: (text: string) => void;
  thoughts: BrainstormActivity[];
}) {
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(idea.title);
  const [body, setBody] = useState(idea.body);
  const [thought, setThought] = useState('');
  const discarded = idea.status === 'discarded';
  const byline =
    idea.author === 'agent' || idea.authorName?.toLowerCase() === 'facilitator'
      ? null
      : idea.authorName || (idea.author === 'user' ? 'You' : null);

  return (
    <article
      className={`animate-fade-in rounded-xl border bg-background p-3 shadow-sm ${
        idea.starred ? 'border-amber-400/70' : 'border-border-subtle'
      } ${discarded ? 'opacity-50' : ''} ${selected ? 'ring-1 ring-text-primary' : ''}`}
    >
      <div className="mb-1.5 flex items-start gap-2">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`Select ${idea.title}`}
          className="mt-1"
        />
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="w-full rounded-md border border-border-subtle bg-surface px-2 py-1 text-[13px] text-text-primary"
            />
          ) : (
            <h3 className="text-[13.5px] font-semibold leading-snug text-text-primary">
              {idea.title}
            </h3>
          )}
          {byline ? <p className="text-[11px] text-text-muted">{byline}</p> : null}
        </div>
        <button
          type="button"
          aria-label={idea.starred ? 'Unstar idea' : 'Star idea'}
          onClick={() => onPatch({ starred: !idea.starred })}
          className={`rounded-md p-1 ${idea.starred ? 'text-amber-500' : 'text-text-muted hover:text-text-primary'}`}
        >
          <Star className="h-3.5 w-3.5" fill={idea.starred ? 'currentColor' : 'none'} />
        </button>
      </div>
      {editing ? (
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          className="mb-2 w-full resize-none rounded-md border border-border-subtle bg-surface px-2 py-1 text-[12.5px] text-text-secondary"
        />
      ) : (
        <p
          className={`text-[12.5px] leading-relaxed text-text-secondary ${open ? '' : 'line-clamp-3'}`}
        >
          {idea.body}
        </p>
      )}
      <ThoughtNotes thoughts={thoughts} />
      {idea.rationale && !editing && open ? (
        <p className="mt-1.5 text-[12px] leading-relaxed text-text-muted">{idea.rationale}</p>
      ) : null}
      {!open && (idea.impact != null || idea.effort != null) ? (
        <p className="mt-2 text-[11px] text-text-muted">
          {idea.impact != null ? `Impact ${idea.impact}` : ''}
          {idea.impact != null && idea.effort != null ? ' · ' : ''}
          {idea.effort != null ? `Effort ${idea.effort}` : ''}
        </p>
      ) : null}
      <button
        type="button"
        className="mt-2 text-[11px] text-text-muted hover:text-text-primary"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Show less' : 'More'}
      </button>
      {open ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Score label="Impact" value={idea.impact} />
            <Score label="Effort" value={idea.effort} />
            {(idea.tags || []).map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-surface px-1.5 py-0.5 text-[10px] text-text-muted"
              >
                {tag}
              </span>
            ))}
          </div>
          {(idea.sources || []).length > 0 ? (
            <ul className="mt-1.5 space-y-0.5">
              {(idea.sources || []).map((source) => (
                <li
                  key={`${source.title}-${source.url || ''}`}
                  className="text-[11px] text-text-muted"
                >
                  {source.url ? (
                    <a href={source.url} target="_blank" rel="noreferrer" className="underline">
                      {source.title}
                    </a>
                  ) : (
                    source.title
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          <form
            className="mt-2 flex gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              const text = thought.trim();
              if (!text) return;
              onThought(text);
              setThought('');
            }}
          >
            <input
              value={thought}
              onChange={(event) => setThought(event.target.value)}
              placeholder="Add a thought"
              className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface px-2 py-1 text-[12px] text-text-primary"
            />
          </form>
          <div className="mt-2 flex gap-2 text-[11px]">
            {editing ? (
              <>
                <button
                  type="button"
                  className="text-text-primary"
                  onClick={() => {
                    onPatch({ title, body });
                    setEditing(false);
                  }}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="text-text-muted"
                  onClick={() => {
                    setTitle(idea.title);
                    setBody(idea.body);
                    setEditing(false);
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="text-text-muted hover:text-text-primary"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
            )}
            <button
              type="button"
              className="inline-flex items-center gap-1 text-text-muted hover:text-text-primary"
              onClick={() => onPatch({ status: discarded ? 'active' : 'discarded' })}
            >
              <Trash2 className="h-3 w-3" />
              {discarded ? 'Restore' : 'Discard'}
            </button>
          </div>
        </>
      ) : null}
    </article>
  );
}
