'use client';

import { memo, useMemo, useState, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { cn } from '@/lib/utils';
import { Check, Copy } from 'lucide-react';
import { codeToHtml, SHIKI_DEFAULT_THEMES, SUPPORTED_LANGUAGES } from '@/lib/shiki-config';

interface MarkdownRendererProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
  variant?: 'default' | 'user';
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
    try {
      const html = codeToHtml(codeString, {
        lang,
        themes: SHIKI_DEFAULT_THEMES,
        defaultColor: false,
      });
      if (isActive) {
        setHighlightedCode(html);
      }
    } catch {
      if (isActive) {
        setHighlightedCode(null);
      }
    }

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

// Custom components for react-markdown
const createComponents = (variant: 'default' | 'user'): Components => ({
  // Paragraphs
  p: ({ children }) => (
    <p className="mb-4 last:mb-0 leading-relaxed">{children}</p>
  ),

  // Headings
  h1: ({ children }) => (
    <h1 className="text-2xl font-bold mt-6 mb-4 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-xl font-bold mt-6 mb-3 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-lg font-semibold mt-5 mb-2 first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-base font-semibold mt-4 mb-2 first:mt-0">{children}</h4>
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
        {children}
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
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,

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
      {children}
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
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-4 py-2 border-r border-border last:border-r-0">
      {children}
    </td>
  ),

  // Horizontal rule
  hr: () => <hr className="my-6 border-border" />,

  // Strong and emphasis
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,

  // Strikethrough
  del: ({ children }) => <del className="line-through">{children}</del>,

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

function MarkdownRendererBase({
  content,
  className,
  isStreaming = false,
  variant = 'default',
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

  const components = useMemo(() => createComponents(variant), [variant]);

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
    prev.variant === next.variant
  );
});

MarkdownRenderer.displayName = 'MarkdownRenderer';
