'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { codeToHtml, SHIKI_DEFAULT_THEMES, SUPPORTED_LANGUAGES } from '@/lib/shiki-config';
import { cn } from '@/lib/utils';
import { getShikiLanguage } from './file-type-utils';

interface CodePreviewProps {
  code: string;
  filename: string;
  layout: 'panel' | 'dialog';
  truncated: boolean;
  totalLines: number;
  maxLines?: number;
}

export function CodePreview({
  code,
  filename,
  layout,
  truncated,
  totalLines,
  maxLines = 500,
}: CodePreviewProps) {
  const [copied, setCopied] = useState(false);
  const [highlightedCode, setHighlightedCode] = useState<string | null>(null);

  const language = useMemo(() => getShikiLanguage(filename), [filename]);

  useEffect(() => {
    let isActive = true;

    if (!code) {
      setHighlightedCode(null);
      return () => {
        isActive = false;
      };
    }

    setHighlightedCode(null);
    const lang = language && SUPPORTED_LANGUAGES.has(language)
      ? language
      : 'text';

    try {
      const html = codeToHtml(code, {
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
  }, [code, language]);

  const handleCopy = useCallback(async () => {
    if (!navigator?.clipboard) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard failures (permissions, unsupported contexts).
    }
  }, [code]);

  return (
    <div className={cn('group/code relative', layout === 'dialog' && 'max-h-[60vh] overflow-auto')}>
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 z-10 rounded-md p-1 opacity-0 transition-opacity group-hover/code:opacity-100 hover:bg-muted"
        aria-label="Copy code"
      >
        {copied ? (
          <Check className="size-3.5 text-green-500" />
        ) : (
          <Copy className="size-3.5 text-muted-foreground" />
        )}
      </button>

      {highlightedCode ? (
        <div
          className="code-preview-lines overflow-x-auto font-mono text-xs leading-5 [&_pre]:m-0 [&_pre]:min-w-max [&_pre]:bg-transparent [&_pre]:px-3 [&_pre]:pb-4"
          dangerouslySetInnerHTML={{ __html: highlightedCode }}
        />
      ) : (
        <pre className="overflow-x-auto px-3 pb-4 font-mono text-xs leading-5">
          <code>{code || 'No preview content available.'}</code>
        </pre>
      )}
      {truncated && (
        <p className="px-3 pb-3 text-[11px] text-muted-foreground/50">
          Showing first {maxLines.toLocaleString()} of {totalLines.toLocaleString()} lines.
        </p>
      )}
    </div>
  );
}
