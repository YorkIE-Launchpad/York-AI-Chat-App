import { memo } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import {
  getTextAlignmentClass,
  getTextDirectionProps,
  type TextDirection,
} from '../utils/text-direction';

// Hoisted to module scope to avoid re-creating arrays on every render
const REMARK_PLUGINS = [remarkMath, [remarkGfm, { singleTilde: false }]] as const;

// remark-math emits <code class="language-math math-inline"> (inline) and
// <pre><code class="language-math math-display"> (display). The default schema
// allows only /^language-./ on <code>, stripping the math-* tokens before
// rehypeKatex processes them.
const mathSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // Merged into one tuple — findDefinition returns the first match per key,
    // so a second ['className', ...] entry would be silently ignored.
    code: [['className', /^language-./, 'math-inline', 'math-display']],
  },
  protocols: {
    ...defaultSchema.protocols,
    // Allow in-app memory citations: [Title](memory:{id}) and numbered cites: [1](cite:1)
    href: [...(defaultSchema.protocols?.href || []), 'memory', 'cite'],
  },
};

// NOTE: rehypeSanitize runs BEFORE rehypeKatex — KaTeX output is unsanitized.
// Safe while trust is false (default), which disables \href, \htmlClass, etc.
// If KaTeX trust is ever enabled, add a second sanitize pass.
const REHYPE_PLUGINS = [
  [rehypeSanitize, mathSanitizeSchema],
  [rehypeKatex, { throwOnError: false, strict: false }],
] as const;

const IN_APP_HREF_RE = /^(?:memory|cite):[^\s]+$/i;

/** react-markdown drops non-web protocols by default; keep in-app memory and numbered cites. */
function urlTransform(url: string): string {
  return IN_APP_HREF_RE.test(url) ? url : defaultUrlTransform(url);
}

export interface MessageMarkdownProps {
  normalizedText: string;
  isStreaming?: boolean;
  components?: Record<string, unknown>;
  /** Visual tone — thinking uses muted sans; output keeps primary serif prose. */
  tone?: 'output' | 'thinking';
  textDirection?: TextDirection;
}

export const MessageMarkdown = memo(function MessageMarkdown({
  normalizedText,
  isStreaming,
  components,
  tone = 'output',
  textDirection = 'auto',
}: MessageMarkdownProps) {
  const alignmentClass = getTextAlignmentClass(textDirection);
  const proseClass =
    tone === 'thinking'
      ? `prose-thinking max-w-none text-text-secondary ${alignmentClass}`
      : `prose-chat max-w-none text-text-primary ${alignmentClass}`;

  return (
    <div {...getTextDirectionProps(textDirection)} className={proseClass}>
      <ReactMarkdown
        remarkPlugins={
          REMARK_PLUGINS as unknown as Parameters<typeof ReactMarkdown>[0]['remarkPlugins']
        }
        rehypePlugins={
          REHYPE_PLUGINS as unknown as Parameters<typeof ReactMarkdown>[0]['rehypePlugins']
        }
        components={components}
        urlTransform={urlTransform}
      >
        {normalizedText}
      </ReactMarkdown>
      {isStreaming && <span className="inline-block w-2 h-4 bg-accent ml-1 animate-pulse" />}
    </div>
  );
});
