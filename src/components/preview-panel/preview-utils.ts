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
import { getFileCategory, getFileExtension } from '@/components/chat-file-preview/file-type-utils';

const CODE_EXTENSIONS = new Set([
  'py',
  'js',
  'jsx',
  'ts',
  'tsx',
  'html',
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
  | 'text'
  | 'spreadsheet'
  | 'json'
  | 'code'
  | 'svg'
  | 'image'
  | 'other';

export function getToolbarFileType(target: PreviewTarget): ToolbarFileType {
  if (target.kind === 'app') return 'app';

  const fileName = getTargetFileName(target);
  const ext = getFileExtension(fileName);

  if (ext === 'ipynb') return 'notebook';
  if (ext === 'md') return 'markdown';
  if (ext === 'txt') return 'text';
  if (ext === 'csv' || ext === 'tsv' || ext === 'xlsx' || ext === 'xls') return 'spreadsheet';
  if (ext === 'json' || ext === 'jsonl') return 'json';
  if (ext === 'svg') return 'svg';
  if (RASTER_IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (CODE_EXTENSIONS.has(ext)) return 'code';

  const category = getFileCategory(fileName, target.contentType);
  if (category === 'notebook') return 'notebook';
  if (category === 'spreadsheet') return 'spreadsheet';
  if (category === 'image') return 'image';
  if (category === 'text') return 'text';
  if (category === 'code') return 'code';

  return 'other';
}

export function getPreviewTabId(target: PreviewTarget): string {
  if (target.kind === 'app') return `app:${target.scriptName}`;
  return `file:${target.workspaceId}:${target.source}:${target.path}`;
}
