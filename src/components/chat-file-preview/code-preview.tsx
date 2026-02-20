'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { codeToHtml } from 'shiki';
import { SHIKI_DEFAULT_THEMES, PRELOAD_LANGUAGES } from '@/lib/shiki-config';
import { cn } from '@/lib/utils';
import { getFileExtension, getShikiLanguage } from './file-type-utils';

interface CodePreviewProps {
  code: string;
  filename: string;
  layout: 'panel' | 'dialog';
  truncated: boolean;
  totalLines: number;
  maxLines?: number;
}

function getLanguageLabel(filename: string, language: string | null): string {
  if (language) return language;
  const extension = getFileExtension(filename);
  return extension || 'text';
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
  const languageLabel = useMemo(
    () => getLanguageLabel(filename, language),
    [filename, language]
  );

  useEffect(() => {
    let isActive = true;

    if (!code) {
      setHighlightedCode(null);
      return () => {
        isActive = false;
      };
    }

    setHighlightedCode(null);
    const lang = language && PRELOAD_LANGUAGES.includes(language as (typeof PRELOAD_LANGUAGES)[number])
      ? language
      : 'text';

    codeToHtml(code, {
      lang,
      themes: SHIKI_DEFAULT_THEMES,
      defaultColor: false,
    })
      .then((html) => {
        if (isActive) {
          setHighlightedCode(html);
        }
      })
      .catch(() => {
        if (isActive) {
          setHighlightedCode(null);
        }
      });

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
      <div className="sticky top-0 z-10 flex items-center justify-between px-3 py-1">
        <span className="font-mono text-[11px] text-muted-foreground/50">
          {languageLabel}
        </span>
        <button
          onClick={handleCopy}
          className="rounded-md p-1 opacity-0 transition-opacity group-hover/code:opacity-100 hover:bg-muted"
          aria-label="Copy code"
        >
          {copied ? (
            <Check className="size-3.5 text-green-500" />
          ) : (
            <Copy className="size-3.5 text-muted-foreground" />
          )}
        </button>
      </div>

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
