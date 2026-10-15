/**
 * Convert the agent's Markdown into Slack mrkdwn.
 *
 * All text is escaped first (`&`, `<`, `>`), so the only angle-bracket syntax
 * in the output is links this module builds from http(s) Markdown links —
 * never mentions, `<!channel>`, or arbitrary `<url|label>` from the desktop.
 */
import { escapeSlackText } from './sanitize.js';

const BOLD = '\u0001';
const FENCE_RE = /^\s{0,3}(```|~~~)/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*(:?-{2,}:?\s*)?\|?\s*$/;

function convertEmphasis(text: string): string {
  return text
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, `${BOLD}$1${BOLD}`)
    .replace(/(^|[^\w])__(?=\S)(.+?)(?<=\S)__(?!\w)/g, `$1${BOLD}$2${BOLD}`)
    .replace(/(^|[^*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, '$1_$2_')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '~$1~')
    .replace(new RegExp(BOLD, 'g'), '*');
}

function convertLinks(escaped: string): string {
  return escaped
    .replace(/!?\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
      const safeLabel = label.replace(/\|/g, '/').trim();
      return safeLabel && safeLabel !== url ? `<${url}|${safeLabel}>` : `<${url}>`;
    })
    .replace(/&lt;(https?:\/\/[^\s&]+?)&gt;/g, '<$1>');
}

/** Inline formatting for one line of non-code text. */
function convertInline(text: string): string {
  return text
    .split(/(`[^`\n]+`)/g)
    .map((part, i) => {
      if (i % 2 === 1) return escapeSlackText(part);
      return convertEmphasis(convertLinks(escapeSlackText(part)));
    })
    .join('');
}

function stripMarkers(text: string): string {
  return text.replace(/\*\*|__/g, '').replace(/`/g, '');
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => stripMarkers(cell.trim()));
}

/** Slack has no tables; render them as an aligned monospace block. */
function renderTable(rows: string[]): string[] {
  const cells = rows.filter((row) => !TABLE_SEPARATOR_RE.test(row)).map(splitRow);
  const widths: number[] = [];
  for (const row of cells) {
    row.forEach((cell, i) => {
      widths[i] = Math.min(Math.max(widths[i] ?? 0, cell.length), 40);
    });
  }
  const lines = cells.map((row) =>
    row
      .map((cell, i) => (cell.length > 40 ? `${cell.slice(0, 39)}…` : cell).padEnd(widths[i]))
      .join('  ')
      .trimEnd()
  );
  if (lines.length > 1) {
    lines.splice(1, 0, widths.map((w) => '─'.repeat(w)).join('  '));
  }
  return ['```', ...lines.map(escapeSlackText), '```'];
}

function convertLine(line: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
  if (heading) {
    const text = stripMarkers(heading[1]);
    return text ? `*${convertInline(text)}*` : '';
  }

  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return '──────────';

  const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
  if (quote) return quote[1] ? `> ${convertLine(quote[1])}` : '>';

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bullet) {
    const level = Math.floor(bullet[1].replace(/\t/g, '  ').length / 2);
    const body = bullet[2].replace(/^\[ \]\s+/, '☐ ').replace(/^\[[xX]\]\s+/, '☑ ');
    const marker = level === 0 ? '•' : `${'    '.repeat(level)}◦`;
    return `${marker} ${convertInline(body)}`;
  }

  const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (numbered) {
    const level = Math.floor(numbered[1].replace(/\t/g, '  ').length / 2);
    return `${'    '.repeat(level)}${numbered[2]}. ${convertInline(numbered[3])}`;
  }

  return convertInline(line);
}

export function markdownToMrkdwn(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      out.push('```');
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(escapeSlackText(line));
      continue;
    }
    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1])) {
      const rows: string[] = [];
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) rows.push(lines[i++]);
      i -= 1;
      out.push(...renderTable(rows));
      continue;
    }
    out.push(convertLine(line));
  }
  if (inFence) out.push('```');

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Split already-converted mrkdwn, keeping code blocks balanced across chunks. */
export function chunkMrkdwn(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const OPEN = '```\n';
  const CLOSE = '\n```';
  const isOpen = (chunk: string) => (chunk.match(/^```/gm)?.length ?? 0) % 2 === 1;
  const cutAt = (source: string, room: number) => {
    const cut = source.lastIndexOf('\n', room);
    return cut < room / 2 ? room : cut;
  };

  const chunks: string[] = [];
  let remaining = text;
  let reopen = false;
  while (remaining.length > 0) {
    const prefix = reopen ? OPEN : '';
    if (prefix.length + remaining.length <= maxLength) {
      chunks.push(prefix + remaining);
      break;
    }
    let cut = cutAt(remaining, maxLength - prefix.length);
    let chunk = prefix + remaining.slice(0, cut);
    if (isOpen(chunk)) {
      cut = cutAt(remaining, maxLength - prefix.length - CLOSE.length);
      chunk = prefix + remaining.slice(0, cut);
    }
    remaining = remaining.slice(cut).replace(/^\n/, '');
    reopen = isOpen(chunk);
    chunks.push(reopen ? chunk + CLOSE : chunk);
  }
  return chunks;
}
