"use client";

import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { useChatPreviewContext } from '@/components/chat-preview/preview-context';
import { formatCopyFilePath } from '@/lib/file-path-copy';
import { buildFilePreviewLinkTarget } from '@/lib/file-preview-target';
import { CopyButton, DetailRow, OutputBlock, ProjectDetailRow } from './shared';
import { copyTargetFromToolInput } from './file-copy';
import { getResultText } from '../tool-utils';
import { FileLink } from '../file-link';

interface SearchDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
  mode: 'glob' | 'grep';
}

function parseCount(resultText: string): number | null {
  const match = resultText.match(/Found\s+(\d+)\s+(files|matches)/i);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function extractResultLines(resultText: string): string {
  const lines = resultText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const filtered = lines.filter(line => !/^found\s+\d+/i.test(line) && !/^results are truncated/i.test(line));
  return filtered.length > 0 ? filtered.join('\n') : resultText;
}

function isFailedToolResult(result?: ToolResultBlock): boolean {
  return Boolean(result && (result.is_error === true || result.status === 'failed'));
}

type ParsedLine = {
  path: string;
  resolvedPath: string;
  suffix: string;
  raw: string;
};

const WORKSPACE_ROOT_PREFIX = '/workspace';

function isSearchNoResultLine(line: string): boolean {
  return /^No files found/i.test(line) || /^No matches found/i.test(line);
}

function isSearchNoticeLine(line: string): boolean {
  return isSearchNoResultLine(line) || /^results are truncated/i.test(line);
}

function isVmGlobBareRelativePath(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (isSearchNoticeLine(trimmed)) return false;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return false;
  if (trimmed.includes('\0')) return false;
  if (trimmed.includes(':')) return false;
  if (trimmed === '.' || trimmed === '..') return false;
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../')
  ) {
    return false;
  }
  if (trimmed.includes('/')) return false;
  return true;
}

function parseGrepMatchLine(line: string): { path: string; suffix: string } | null {
  const match = line.match(/^(.+?):([1-9]\d*):(.*)$/);
  if (!match) return null;

  return {
    path: match[1].trim(),
    suffix: `:${match[2]}:${match[3]}`,
  };
}

function normalizeVmProjectPath(path: string): string | null {
  const rawPath = path.trim();
  if (!rawPath) return null;

  let normalized = rawPath.replace(/\\/g, '/').replace(/\/+/g, '/');
  normalized = normalized.startsWith('/') ? normalized : `/${normalized}`;

  if (normalized === WORKSPACE_ROOT_PREFIX) {
    normalized = '/';
  } else if (normalized.startsWith(`${WORKSPACE_ROOT_PREFIX}/`)) {
    normalized = normalized.slice(WORKSPACE_ROOT_PREFIX.length) || '/';
  }

  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return `/${segments.join('/')}`;
}

// Resolves a search result path to an absolute VM project path. Absolute
// results are normalized as-is; relative results are joined against the search
// root. We deliberately do not special-case single-file grep roots (where the
// result is a bare basename that should resolve against the root's directory):
// that case is indistinguishable from a directory grep matching a top-level
// file, so disambiguating it requires a heuristic. We optimize for the common
// directory-search case and accept that single-file grep roots resolve
// imperfectly; proper handling is deferred to a follow-up.
function resolveVmSearchResultPath(
  resultPath: string,
  searchRoot: string,
): string | null {
  const normalizedResultPath = resultPath.trim().replace(/\\/g, '/');
  if (!normalizedResultPath) return null;

  if (normalizedResultPath.startsWith('/')) {
    return normalizeVmProjectPath(normalizedResultPath);
  }

  const normalizedSearchRoot = normalizeVmProjectPath(searchRoot || '/');
  if (!normalizedSearchRoot) return null;
  const joinedPath = normalizedSearchRoot === '/'
    ? `/${normalizedResultPath}`
    : `${normalizedSearchRoot}/${normalizedResultPath}`;
  return normalizeVmProjectPath(joinedPath);
}

function parseLine(
  line: string,
  options: {
    mode: SearchDetailsProps['mode'];
    isProjectSearch: boolean;
    searchRoot: string;
  },
): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (isSearchNoticeLine(trimmed)) return null;

  if (
    options.isProjectSearch &&
    options.mode === 'glob' &&
    isVmGlobBareRelativePath(trimmed)
  ) {
    const resolvedPath = resolveVmSearchResultPath(trimmed, options.searchRoot);
    if (!resolvedPath) return null;
    return {
      path: trimmed,
      resolvedPath,
      suffix: '',
      raw: trimmed,
    };
  }

  if (options.isProjectSearch && options.mode === 'grep' && trimmed.includes(':')) {
    const grepMatch = parseGrepMatchLine(trimmed);
    if (!grepMatch) return null;
    const resolvedPath = resolveVmSearchResultPath(
      grepMatch.path,
      options.searchRoot,
    );
    if (!resolvedPath) return null;
    return {
      path: grepMatch.path,
      resolvedPath,
      suffix: grepMatch.suffix,
      raw: trimmed,
    };
  }

  const colonIndex = trimmed.indexOf(':');
  const base = colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed;
  if (
    base.startsWith('/') ||
    base.startsWith('./') ||
    base.startsWith('../') ||
    base.includes('/')
  ) {
    const resolvedPath = options.isProjectSearch
      ? resolveVmSearchResultPath(base, options.searchRoot)
      : base;
    if (!resolvedPath) return null;
    return {
      path: base,
      resolvedPath,
      suffix: colonIndex >= 0 ? trimmed.slice(colonIndex) : '',
      raw: trimmed,
    };
  }
  return null;
}

export function SearchDetails({ tool, result, mode }: SearchDetailsProps) {
  const input = tool?.input ?? {};
  const previewContext = useChatPreviewContext();
  const isProjectSearch =
    input.location === 'project' || input.location === 'vm';
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  const path = typeof input.path === 'string' ? input.path : '';
  const outputMode = typeof input.output_mode === 'string' ? input.output_mode : '';
  const resultText = getResultText(result);
  const count = parseCount(resultText);
  const resultFailed = isFailedToolResult(result);
  const displayText = resultFailed ? resultText : extractResultLines(resultText);
  const fileLines = displayText.split(/\r?\n/).filter(Boolean);
  const parsedLines = resultFailed
    ? []
    : fileLines
        .map(line => parseLine(line, { mode, isProjectSearch, searchRoot: path }))
        .filter((entry): entry is ParsedLine => Boolean(entry));
  const copyValue = parsedLines
    .map((entry) => {
      const copyTarget = copyTargetFromToolInput(input, entry.resolvedPath);
      const formattedPath = previewContext?.formatFilePathForCopy?.(copyTarget) ??
        formatCopyFilePath(copyTarget, { fallbackProjectMention: true });
      return `${formattedPath}${entry.suffix}`;
    })
    .join('\n');

  return (
    <div className="space-y-1">
      <DetailRow label="Pattern:" value={pattern} copyValue={pattern} mono />
      <DetailRow
        label="Path:"
        value={path}
        copyFileTarget={copyTargetFromToolInput(input, path)}
        mono
        asFileLink
      />
      <ProjectDetailRow input={input} />
      {outputMode ? <DetailRow label="Mode:" value={outputMode} /> : null}
      {count !== null ? <DetailRow label="Count:" value={String(count)} /> : null}
      {parsedLines.length > 0 ? (
        <div className="mt-2">
          <div className="flex items-center justify-between text-[0.7rem] text-muted-foreground/60 mb-1 group/filelist">
            <span>{mode === 'glob' ? 'Files' : 'Matches'}</span>
            <CopyButton
              value={copyValue}
              label="Copy list"
              hoverClassName="group-hover/details:opacity-100"
            />
          </div>
          <div className="bg-muted/30 rounded p-2 max-h-32 overflow-auto text-xs">
            {parsedLines.map((entry, index) => (
              <div key={`${entry.path}-${index}`} className="flex items-start gap-1">
                <FileLink
                  path={entry.resolvedPath}
                  previewTarget={buildFilePreviewLinkTarget({
                    path: entry.resolvedPath,
                    location: input.location,
                    project: input.project,
                  }) ?? undefined}
                  mono
                  className="truncate text-muted-foreground/80"
                >
                  {entry.path}
                </FileLink>
                {entry.suffix ? (
                  <span className="text-muted-foreground/60 whitespace-pre-wrap">
                    {entry.suffix}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <OutputBlock
          value={displayText}
          label={mode === 'glob' ? 'Files' : 'Matches'}
          copyValue={displayText}
        />
      )}
    </div>
  );
}
