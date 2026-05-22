import type { LucideIcon } from 'lucide-react';
import {
  AppWindow,
  Braces,
  File,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  NotebookPen,
} from 'lucide-react';
import type { PreviewTarget } from '@/types';
import {
  getFileCategory,
  getFileExtension,
  getPreviewType,
} from '@/components/chat-file-preview/file-type-utils';

const CODE_EXTENSIONS = new Set([
  'py',
  'js',
  'jsx',
  'ts',
  'tsx',
  'html',
  'htm',
  'css',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'sh',
  'sql',
  'yaml',
  'yml',
  'toml',
  'bash',
  'zsh',
]);

const RASTER_IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'ico',
  'avif',
]);

function getTargetFileName(target: Extract<PreviewTarget, { kind: 'file' }>): string {
  return target.filename || target.path;
}

export function getTabIcon(target: PreviewTarget): LucideIcon {
  if (target.kind === 'app') return AppWindow;

  const ext = getFileExtension(getTargetFileName(target));
  if (ext === 'ipynb') return NotebookPen;
  if (ext === 'json' || ext === 'jsonl') return Braces;
  if (ext === 'md' || ext === 'txt' || ext === 'pdf') return FileText;
  if (ext === 'csv' || ext === 'tsv' || ext === 'xlsx' || ext === 'xls') return FileSpreadsheet;
  if (ext === 'svg' || RASTER_IMAGE_EXTENSIONS.has(ext)) return FileImage;
  if (CODE_EXTENSIONS.has(ext)) return FileCode;

  const category = getFileCategory(getTargetFileName(target), target.contentType);
  if (category === 'notebook') return NotebookPen;
  if (category === 'spreadsheet') return FileSpreadsheet;
  if (category === 'image') return FileImage;
  if (category === 'code') return FileCode;
  if (category === 'text' || category === 'pdf') return FileText;

  return File;
}

export function getTabLabel(target: PreviewTarget): string {
  if (target.kind === 'app') return target.scriptName;
  if (target.filename) return target.filename;
  return target.path.split('/').filter(Boolean).pop() || 'file';
}

export type ToolbarFileType =
  | 'app'
  | 'notebook'
  | 'markdown'
  | 'html'
  | 'text'
  | 'spreadsheet'
  | 'json'
  | 'code'
  | 'svg'
  | 'image'
  | 'other';

const DELIMITED_SPREADSHEET_CONTENT_TYPES = new Set([
  'text/csv',
  'text/tab-separated-values',
  'application/csv',
  'application/tab-separated-values',
]);

export function getToolbarFileType(target: PreviewTarget): ToolbarFileType {
  if (target.kind === 'app') return 'app';

  const fileName = getTargetFileName(target);
  const previewType = getPreviewType(fileName, target.contentType);
  switch (previewType) {
    case 'notebook':
    case 'markdown':
    case 'html':
    case 'spreadsheet':
    case 'svg':
    case 'image':
    case 'code':
    case 'text':
      return previewType;
    case 'json':
    case 'jsonl':
      return 'json';
    default:
      return 'other';
  }
}

export function isDelimitedSpreadsheetTarget(target: PreviewTarget): boolean {
  if (target.kind !== 'file') return false;

  const fileName = getTargetFileName(target);
  const ext = getFileExtension(fileName);
  if (ext === 'csv' || ext === 'tsv') return true;
  if (ext === 'xlsx' || ext === 'xls') return false;

  const contentType = target.contentType?.toLowerCase().split(';', 1)[0]?.trim();
  return contentType ? DELIMITED_SPREADSHEET_CONTENT_TYPES.has(contentType) : false;
}

export function supportsPreviewSourceToggle(target: PreviewTarget): boolean {
  if (target.kind !== 'file') return false;

  const fileType = getToolbarFileType(target);
  if (
    fileType === 'notebook' ||
    fileType === 'markdown' ||
    fileType === 'html' ||
    fileType === 'svg' ||
    fileType === 'json'
  ) {
    return true;
  }

  return fileType === 'spreadsheet' && isDelimitedSpreadsheetTarget(target);
}

export function shouldAutoRefreshFilePreview(
  target: Extract<PreviewTarget, { kind: 'file' }>,
  fileViewMode: 'preview' | 'source',
): boolean {
  return fileViewMode !== 'preview' || getToolbarFileType(target) !== 'html';
}

export function getPreviewTabId(target: PreviewTarget): string {
  if (target.kind === 'app') return `app:${target.scriptName}`;
  return `file:${target.workspaceId}:${target.source}:${target.path}`;
}
