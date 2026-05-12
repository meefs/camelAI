'use client';

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Check, Copy } from 'lucide-react';
import { codeToHtml, SHIKI_DEFAULT_THEMES, SUPPORTED_LANGUAGES } from '@/lib/shiki-config';
import { cn } from '@/lib/utils';
import { getShikiLanguage } from './file-type-utils';

export interface SourcePreviewProps {
  code: string;
  filename: string;
  layout: 'panel' | 'dialog';
  truncated: boolean;
  totalLines: number;
  maxLines?: number;
  languageOverride?: string | null;
  emptyMessage?: string;
}

type CodePreviewProps = Omit<SourcePreviewProps, 'languageOverride' | 'emptyMessage'>;

export function SourcePreview({
  code,
  filename,
  layout,
  truncated,
  totalLines,
  maxLines = 500,
  languageOverride,
  emptyMessage = 'No preview content available.',
}: SourcePreviewProps) {
  const [copied, setCopied] = useState(false);
  const [highlightedCode, setHighlightedCode] = useState<string | null>(null);

  const language = useMemo(
    () => languageOverride ?? getShikiLanguage(filename),
    [filename, languageOverride]
  );
  const fallbackLines = useMemo(() => {
    const fallbackContent = code.length > 0 ? code : emptyMessage;
    return fallbackContent.split('\n');
  }, [code, emptyMessage]);
  const lineNumberDigits = useMemo(() => {
    const lineCount = Math.max(totalLines, fallbackLines.length, 1);
    return Math.max(String(lineCount).length, 2);
  }, [fallbackLines.length, totalLines]);
  const sourceStyle = useMemo(
    () => ({
      '--source-line-number-digits': String(lineNumberDigits),
    }) as CSSProperties,
    [lineNumberDigits]
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
    const lang = language && SUPPORTED_LANGUAGES.has(language)
      ? language
      : 'text';

    codeToHtml(code, {
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
        aria-label="Copy source"
      >
        {copied ? (
          <Check className="size-3.5 text-green-500" />
        ) : (
          <Copy className="size-3.5 text-muted-foreground" />
        )}
      </button>

      {highlightedCode ? (
        <div
          className="source-preview-lines font-mono text-xs leading-5 text-foreground [&_pre]:m-0 [&_pre]:bg-transparent [&_pre]:px-3 [&_pre]:py-4 [&_pre]:pr-10"
          style={sourceStyle}
          dangerouslySetInnerHTML={{ __html: highlightedCode }}
        />
      ) : (
        <div
          className={cn(
            'source-preview-lines font-mono text-xs leading-5 [&_pre]:m-0 [&_pre]:bg-transparent [&_pre]:px-3 [&_pre]:py-4 [&_pre]:pr-10',
            code ? 'text-foreground' : 'text-muted-foreground'
          )}
          style={sourceStyle}
        >
          <pre>
            <code>
              {fallbackLines.map((line, index) => (
                <span className="line" key={index}>
                  {line || '\u00a0'}
                </span>
              ))}
            </code>
          </pre>
        </div>
      )}
      {truncated && (
        <p className="px-3 pb-3 text-[11px] text-muted-foreground/50">
          Showing first {maxLines.toLocaleString()} of {totalLines.toLocaleString()} lines.
        </p>
      )}
    </div>
  );
}

export function CodePreview(props: CodePreviewProps) {
  return <SourcePreview {...props} />;
}
