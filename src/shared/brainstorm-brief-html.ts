import type { BrainstormDetail, BrainstormIdea } from './brainstorm-types';
import { BRAINSTORM_PHASE_LABELS } from './brainstorm-types';

function esc(value: string | null | undefined): string {
  return (value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ideaById(detail: BrainstormDetail, id: string): BrainstormIdea | undefined {
  return (detail.ideas || []).find((idea) => idea.id === id);
}

/** One-page HTML brief. Same markup is previewed in the app and written to disk. */
export function renderBrainstormBriefHtml(detail: BrainstormDetail): string {
  const brief = detail.brief;
  const ranked = (brief?.rankedIdeaIds || [])
    .map((id) => ideaById(detail, id))
    .filter((idea): idea is BrainstormIdea => Boolean(idea));
  const ideas = ranked.length
    ? ranked
    : (detail.ideas || []).filter((idea) => idea.status === 'active' && idea.starred);
  const fallback = ideas.length
    ? ideas
    : (detail.ideas || []).filter((idea) => idea.status === 'active').slice(0, 8);

  const ideaHtml = fallback
    .map((idea, index) => {
      const sources = (idea.sources || [])
        .map((source) =>
          source.url
            ? `<a href="${esc(source.url)}">${esc(source.title || source.url)}</a>`
            : esc(source.title)
        )
        .filter(Boolean)
        .join(' · ');
      return `<article>
        <h3>${index + 1}. ${esc(idea.title)}</h3>
        <p>${esc(idea.body)}</p>
        ${idea.rationale ? `<p class="why"><strong>Why:</strong> ${esc(idea.rationale)}</p>` : ''}
        ${sources ? `<p class="src">${sources}</p>` : ''}
      </article>`;
    })
    .join('\n');

  const experiments = (brief?.experiments || [])
    .map(
      (experiment) =>
        `<li><strong>${esc(experiment.title)}</strong><br/>${esc(experiment.steps)}</li>`
    )
    .join('\n');

  const questions = (brief?.openQuestions || [])
    .map((question) => `<li>${esc(question)}</li>`)
    .join('\n');

  const sources = (brief?.sources || [])
    .map((source) =>
      source.url
        ? `<li><a href="${esc(source.url)}">${esc(source.title || source.url)}</a></li>`
        : `<li>${esc(source.title)}</li>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${esc(detail.topic)} — Brainstorm brief</title>
  <style>
    body { font-family: Georgia, "Iowan Old Style", serif; color: #1c1917; background: #faf7f2; margin: 0; }
    main { max-width: 740px; margin: 0 auto; padding: 48px 28px 72px; }
    h1 { font-size: 34px; line-height: 1.15; margin: 0 0 8px; }
    h2 { font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase; margin: 32px 0 10px; }
    h3 { font-size: 18px; margin: 0 0 6px; }
    p, li { font-size: 16px; line-height: 1.5; }
    .meta { color: #57534e; font-family: ui-sans-serif, system-ui, sans-serif; font-size: 13px; }
    article { background: white; border: 1px solid #e7e5e4; border-radius: 14px; padding: 16px 18px; margin: 0 0 12px; }
    .why, .src { color: #44403c; font-size: 14px; }
    a { color: #9a3412; }
  </style>
</head>
<body>
  <main>
    <p class="meta">${esc(BRAINSTORM_PHASE_LABELS[detail.phase])}</p>
    <h1>${esc(detail.topic)}</h1>
    ${detail.goal ? `<p>${esc(detail.goal)}</p>` : ''}
    ${brief?.summary ? `<p>${esc(brief.summary)}</p>` : ''}
    <h2>Ideas</h2>
    ${ideaHtml || '<p>No ideas yet.</p>'}
    ${experiments ? `<h2>First experiments</h2><ol>${experiments}</ol>` : ''}
    ${questions ? `<h2>Open questions</h2><ul>${questions}</ul>` : ''}
    ${sources ? `<h2>Sources</h2><ul>${sources}</ul>` : ''}
  </main>
</body>
</html>`;
}
