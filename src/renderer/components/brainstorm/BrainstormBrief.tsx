import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, ListChecks } from 'lucide-react';
import type { BrainstormDetail } from '../../../shared/brainstorm-types';
import { renderBrainstormBriefHtml } from '../../../shared/brainstorm-brief-html';

export function BrainstormBrief({
  detail,
  onExport,
  onSendFollowUps,
  busy,
}: {
  detail: BrainstormDetail;
  onExport: () => void;
  onSendFollowUps: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [showHtml, setShowHtml] = useState(false);
  const html = useMemo(() => renderBrainstormBriefHtml(detail), [detail]);
  const brief = detail.brief;
  const allIdeas = detail.ideas || [];
  const ranked = (brief?.rankedIdeaIds || [])
    .map((id) => allIdeas.find((idea) => idea.id === id))
    .filter((idea): idea is NonNullable<typeof idea> => Boolean(idea));
  const ideas =
    ranked.length > 0
      ? ranked
      : allIdeas.filter((idea) => idea.starred && idea.status === 'active');

  return (
    <section className="rounded-xl border border-border-subtle bg-background p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="flex flex-1 items-center gap-1 text-[13px] font-semibold text-text-primary">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="inline-flex items-center gap-1"
            aria-expanded={open}
            aria-label={open ? 'Collapse brief' : 'Expand brief'}
          >
            {open ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Brief
          </button>
        </h3>
        <button
          type="button"
          onClick={() => setShowHtml((value) => !value)}
          className="text-[11px] text-text-muted hover:text-text-primary"
        >
          {showHtml ? 'Cards' : 'Preview'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onExport}
          className="inline-flex items-center gap-1 rounded-full border border-border-subtle px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface disabled:opacity-50"
        >
          <ExternalLink className="h-3 w-3" />
          Export
        </button>
        <button
          type="button"
          disabled={busy || (brief?.experiments.length || 0) === 0}
          onClick={onSendFollowUps}
          className="inline-flex items-center gap-1 rounded-full border border-border-subtle px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface disabled:opacity-50"
        >
          <ListChecks className="h-3 w-3" />
          Send experiments to Follow-ups
        </button>
      </div>
      {open && showHtml ? (
        <iframe
          title="Brainstorm brief"
          sandbox=""
          srcDoc={html}
          className="h-[480px] w-full rounded-lg bg-white"
        />
      ) : open ? (
        <div className="space-y-3 text-[12.5px] leading-relaxed text-text-secondary">
          {brief?.summary ? <p className="text-text-primary">{brief.summary}</p> : null}
          {ideas.length > 0 ? (
            <ol className="list-decimal space-y-2 pl-4">
              {ideas.map((idea) => (
                <li key={idea.id}>
                  <span className="font-medium text-text-primary">{idea.title}</span>
                  {idea.body ? <span> — {idea.body}</span> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-text-muted">
              The brief fills in at wrap-up, or when you export what is on the board.
            </p>
          )}
          {brief && brief.experiments.length > 0 ? (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                First experiments
              </p>
              <ul className="space-y-1">
                {brief.experiments.map((experiment) => (
                  <li key={experiment.title}>
                    <span className="font-medium text-text-primary">{experiment.title}.</span>{' '}
                    {experiment.steps}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {brief && brief.openQuestions.length > 0 ? (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                Open questions
              </p>
              <ul className="list-disc pl-4">
                {brief.openQuestions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
