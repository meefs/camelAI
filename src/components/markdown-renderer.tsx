'use client';

import {
  Fragment,
  Children,
  cloneElement,
  isValidElement,
  memo,
  useMemo,
  useState,
  useCallback,
  useEffect,
  type ReactElement,
  type ReactNode,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { cn } from '@/lib/utils';
import { Check, Copy } from 'lucide-react';
import { codeToHtml, SHIKI_DEFAULT_THEMES, SUPPORTED_LANGUAGES } from '@/lib/shiki-config';
import { MentionChip } from '@/components/connection-mention-menu/mention-chip';
import {
  parseMentions,
  type AnnotatedMentionRef,
  type MentionMatch,
} from '@/lib/connection-mentions';
import type { Integration } from '@/types';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
  variant?: 'default' | 'user';
  mentionSlugMap?: Map<string, Integration>;
  annotatedMentions?: ReadonlyArray<AnnotatedMentionRef>;
}

const CODEX_CITATION_REGEX = /cite[^]+/g;

export function normalizeCodexCitationMarkers(content: string): string {
  if (!content.includes('cite')) {
    return content;
  }

  // Codex app-server currently leaks raw web-search citation markers into visible
  // text without the structured metadata needed to render real links. Strip the
  // markers so users do not see broken token artifacts like citeturn1search0.
  return content.replace(CODEX_CITATION_REGEX, '');
}

// Inline code component - simple styled span
function InlineCode({ children }: { children?: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded-md bg-muted font-mono text-[0.875em]">
      {children}
    </code>
  );
}

// Code block component with syntax highlighting and copy button
function CodeBlockPre({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [highlightedCode, setHighlightedCode] = useState<string | null>(null);

  // Extract code content and language from the child code element
  // react-markdown renders: <pre><code className="language-xxx">...</code></pre>
  let codeString = '';
  let language = '';

  if (children && typeof children === 'object' && 'props' in (children as React.ReactElement)) {
    const codeElement = children as React.ReactElement<{ children?: React.ReactNode; className?: string }>;
    codeString = String(codeElement.props.children || '').replace(/\n$/, '');
    const match = /language-(\w+)/.exec(codeElement.props.className || '');
    language = match ? match[1] : '';
  }

  useEffect(() => {
    let isActive = true;

    if (!codeString) {
      setHighlightedCode(null);
      return () => {
        isActive = false;
      };
    }

    const lang = language && SUPPORTED_LANGUAGES.has(language)
      ? language
      : 'text';
    codeToHtml(codeString, {
      lang,
      themes: SHIKI_DEFAULT_THEMES,
      defaultColor: false,
    })
      .then((html) => {
        if (isActive) setHighlightedCode(html);
      })
      .catch(() => {
        if (isActive) setHighlightedCode(null);
      });

    return () => {
      isActive = false;
    };
  }, [codeString, language]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(codeString);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [codeString]);

  return (
    <div className="group/code relative my-4">
      {language && (
        <div className="absolute top-0 left-0 px-3 py-1 text-xs text-muted-foreground font-mono bg-muted/50 rounded-tl-lg rounded-br-lg z-10">
          {language}
        </div>
      )}
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-muted/80 hover:bg-muted opacity-0 group-hover/code:opacity-100 transition-opacity z-10"
        aria-label="Copy code"
      >
        {copied ? (
          <Check className="size-4 text-green-500" />
        ) : (
          <Copy className="size-4 text-muted-foreground" />
        )}
      </button>
      {highlightedCode ? (
        <div
          className="shiki-wrapper overflow-x-auto rounded-lg text-sm [&_pre]:!bg-muted/50 [&_pre]:p-4 [&_pre]:pt-8 [&_pre]:min-w-max"
          dangerouslySetInnerHTML={{ __html: highlightedCode }}
        />
      ) : (
        <pre className="overflow-x-auto rounded-lg bg-muted/50 p-4 pt-8 text-sm font-mono">
          <code>{codeString}</code>
        </pre>
      )}
    </div>
  );
}

// react-markdown leaf text inside these elements should stay literal — never
// transform `@slug` inside inline code or code blocks.
function isOpaqueElement(element: ReactElement): boolean {
  const t = (element as ReactElement & { type: unknown }).type;
  if (t === InlineCode || t === CodeBlockPre) return true;
  if (typeof t === 'string') return t === 'code' || t === 'pre';
  return false;
}

function buildAnnotatedIdsBySlug(
  annotatedMentions: ReadonlyArray<AnnotatedMentionRef> | undefined,
): Map<string, Set<string | null>> {
  const idsBySlug = new Map<string, Set<string | null>>();
  for (const mention of annotatedMentions ?? []) {
    const ids = idsBySlug.get(mention.slug) ?? new Set<string | null>();
    ids.add(mention.id);
    idsBySlug.set(mention.slug, ids);
  }
  return idsBySlug;
}

function resolveMentionChipIntegration(
  match: MentionMatch,
  annotatedIdsBySlug: ReadonlyMap<string, ReadonlySet<string | null>>,
): Integration | null {
  const currentIntegration = match.integration as Integration | null;
  const annotatedIds = annotatedIdsBySlug.get(match.slug);

  if (!annotatedIds) {
    return currentIntegration;
  }

  if (currentIntegration && annotatedIds.has(currentIntegration.id)) {
    return currentIntegration;
  }

  return null;
}

function replaceMentionsInText(
  text: string,
  slugMap: Map<string, Integration>,
  annotatedIdsBySlug: ReadonlyMap<string, ReadonlySet<string | null>>,
  keyPrefix: string,
): ReactNode[] {
  // Render chips for live slugs and for slugs whose stripped annotation proves
  // they were once real mentions. Random unknown `@words` stay as plain text.
  const matches = parseMentions(text, slugMap).filter((m) =>
    m.integration !== null || annotatedIdsBySlug.has(m.slug),
  );
  if (matches.length === 0) return [text];

  const out: ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    if (m.index > cursor) {
      out.push(text.slice(cursor, m.index));
    }
    out.push(
      <MentionChip
        key={`${keyPrefix}-m${i}`}
        slug={m.slug}
        integration={resolveMentionChipIntegration(m, annotatedIdsBySlug)}
      />,
    );
    cursor = m.index + m.length;
  }
  if (cursor < text.length) {
    out.push(text.slice(cursor));
  }
  return out;
}

function withMentionChips(
  children: ReactNode,
  slugMap: Map<string, Integration>,
  annotatedIdsBySlug: ReadonlyMap<string, ReadonlySet<string | null>>,
  keyPrefix = 'mc',
): ReactNode {
  if (typeof children === 'string') {
    const parts = replaceMentionsInText(
      children,
      slugMap,
      annotatedIdsBySlug,
      keyPrefix,
    );
    if (parts.length === 1 && parts[0] === children) return children;
    return parts.map((part, i) => (
      <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>
    ));
  }
  if (Array.isArray(children)) {
    return Children.map(children, (child, i) =>
      withMentionChips(child, slugMap, annotatedIdsBySlug, `${keyPrefix}-${i}`),
    );
  }
  if (isValidElement(children)) {
    if (isOpaqueElement(children)) return children;
    const c = children as ReactElement<{ children?: ReactNode }>;
    if (c.props && c.props.children !== undefined) {
      return cloneElement(
        c,
        undefined,
        withMentionChips(c.props.children, slugMap, annotatedIdsBySlug, keyPrefix),
      );
    }
    return children;
  }
  return children;
}

// Custom components for react-markdown
const createComponents = (
  variant: 'default' | 'user',
  mentionSlugMap?: Map<string, Integration>,
  annotatedMentions?: ReadonlyArray<AnnotatedMentionRef>,
): Components => {
  const annotatedIdsBySlug = buildAnnotatedIdsBySlug(annotatedMentions);
  const canRenderMentions = Boolean(mentionSlugMap || annotatedIdsBySlug.size);
  const slugMap = mentionSlugMap ?? new Map<string, Integration>();
  const wrap = (children: ReactNode, keyPrefix: string) =>
    canRenderMentions
      ? withMentionChips(children, slugMap, annotatedIdsBySlug, keyPrefix)
      : children;
  return ({
  // Paragraphs
  p: ({ children }) => (
    <p className="mb-4 last:mb-0 leading-relaxed">{wrap(children, 'p')}</p>
  ),

  // Headings
  h1: ({ children }) => (
    <h1 className="text-2xl font-bold mt-6 mb-4 first:mt-0">{wrap(children, 'h1')}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-xl font-bold mt-6 mb-3 first:mt-0">{wrap(children, 'h2')}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-lg font-semibold mt-5 mb-2 first:mt-0">{wrap(children, 'h3')}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-base font-semibold mt-4 mb-2 first:mt-0">{wrap(children, 'h4')}</h4>
  ),

  // Inline code - simple styled span
  code: InlineCode as Components['code'],

  // Code blocks - pre wraps code, handles syntax highlighting and copy
  pre: CodeBlockPre as Components['pre'],

  // Links
  a: ({ href, children }) => {
    // Internal API links (workspace outputs) should not open in new tab
    const isInternal = href?.startsWith('/api/');

    return (
      <a
        href={href}
        target={isInternal ? undefined : '_blank'}
        rel={isInternal ? undefined : 'noopener noreferrer'}
        className={cn(
          'underline underline-offset-2 hover:no-underline',
          variant === 'user' ? 'text-primary-foreground/90' : 'text-primary'
        )}
      >
        {wrap(children, 'a')}
      </a>
    );
  },

  // Lists
  ul: ({ children }) => (
    <ul className="list-disc list-outside ml-6 mb-4 space-y-1">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal list-outside ml-6 mb-4 space-y-1">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{wrap(children, 'li')}</li>,

  // Blockquotes
  blockquote: ({ children }) => (
    <blockquote
      className={cn(
        'border-l-4 pl-4 my-4 italic',
        variant === 'user'
          ? 'border-primary-foreground/30 text-primary-foreground/80'
          : 'border-border text-muted-foreground'
      )}
    >
      {wrap(children, 'bq')}
    </blockquote>
  ),

  // Tables
  table: ({ children }) => (
    <div className="overflow-x-auto my-4">
      <table className="min-w-full border-collapse border border-border">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-muted/50">{children}</thead>
  ),
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => (
    <tr className="border-b border-border">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-4 py-2 text-left font-semibold border-r border-border last:border-r-0">
      {wrap(children, 'th')}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-2 border-r border-border last:border-r-0">
      {wrap(children, 'td')}
    </td>
  ),

  // Horizontal rule
  hr: () => <hr className="my-6 border-border" />,

  // Strong and emphasis
  strong: ({ children }) => <strong className="font-semibold">{wrap(children, 'strong')}</strong>,
  em: ({ children }) => <em className="italic">{wrap(children, 'em')}</em>,

  // Strikethrough
  del: ({ children }) => <del className="line-through">{wrap(children, 'del')}</del>,

  // Images
  img: ({ src, alt }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt || ''}
      className="max-w-full h-auto rounded-lg my-4"
    />
  ),
});
};

function MarkdownRendererBase({
  content,
  className,
  isStreaming = false,
  variant = 'default',
  mentionSlugMap,
  annotatedMentions,
}: MarkdownRendererProps) {
  // Process content for streaming - auto-close unclosed code fences
  const processedContent = useMemo(() => {
    const normalizedContent = normalizeCodexCitationMarkers(content);
    if (!isStreaming) return normalizedContent;

    // Count code fences to check if one is unclosed
    const fenceCount = (normalizedContent.match(/```/g) || []).length;
    if (fenceCount % 2 === 1) {
      // Unclosed fence - add a closing one for better preview
      return normalizedContent + '\n```';
    }
    return normalizedContent;
  }, [content, isStreaming]);

  const components = useMemo(
    () => createComponents(variant, mentionSlugMap, annotatedMentions),
    [variant, mentionSlugMap, annotatedMentions],
  );

  return (
    <div
      className={cn(
        'markdown-content',
        variant === 'user' && 'markdown-content-user',
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
}

// Memoize to prevent unnecessary re-renders during streaming
export const MarkdownRenderer = memo(MarkdownRendererBase, (prev, next) => {
  return (
    prev.content === next.content &&
    prev.className === next.className &&
    prev.isStreaming === next.isStreaming &&
    prev.variant === next.variant &&
    prev.mentionSlugMap === next.mentionSlugMap &&
    prev.annotatedMentions === next.annotatedMentions
  );
});

MarkdownRenderer.displayName = 'MarkdownRenderer';
