import type { LucideIcon } from 'lucide-react';
import {
  File,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
} from 'lucide-react';

export type FileCategory =
  | 'image'
  | 'pdf'
  | 'notebook'
  | 'spreadsheet'
  | 'code'
  | 'text'
  | 'audio'
  | 'video'
  | 'other';

export type PreviewType = 'image' | 'pdf' | 'notebook' | 'text' | 'audio' | 'video' | 'other';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const PDF_EXTENSIONS = new Set(['pdf']);
const NOTEBOOK_EXTENSIONS = new Set(['ipynb']);
const SPREADSHEET_EXTENSIONS = new Set(['csv', 'xlsx', 'xls']);
const CODE_EXTENSIONS = new Set([
  'txt',
  'json',
  'xml',
  'html',
  'css',
  'js',
  'jsx',
  'ts',
  'tsx',
  'md',
  'py',
  'yaml',
  'yml',
  'toml',
  'sql',
  'log',
  'sh',
  'bash',
  'zsh',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
]);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi']);

export function getFileExtension(filename: string): string {
  const trimmed = filename.trim();
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot === -1 || lastDot === trimmed.length - 1) return '';
  return trimmed.slice(lastDot + 1).toLowerCase();
}

export function getFileCategory(filename: string, contentType?: string): FileCategory {
  if (contentType) {
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('audio/')) return 'audio';
    if (contentType.startsWith('video/')) return 'video';
    if (contentType === 'application/pdf') return 'pdf';
    if (contentType.includes('ipynb')) return 'notebook';
    if (contentType.startsWith('text/')) return 'text';
    if (contentType.includes('json') || contentType.includes('xml')) return 'code';
    if (contentType.includes('csv') || contentType.includes('spreadsheet')) return 'spreadsheet';
  }

  const ext = getFileExtension(filename);
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';
  if (NOTEBOOK_EXTENSIONS.has(ext)) return 'notebook';
  if (SPREADSHEET_EXTENSIONS.has(ext)) return 'spreadsheet';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';

  return 'other';
}

export function getPreviewType(filename: string, contentType?: string): PreviewType {
  const category = getFileCategory(filename, contentType);
  if (category === 'image') return 'image';
  if (category === 'pdf') return 'pdf';
  if (category === 'notebook') return 'notebook';
  if (category === 'audio') return 'audio';
  if (category === 'video') return 'video';
  if (category === 'code' || category === 'text' || category === 'spreadsheet') return 'text';
  return 'other';
}

export function getFileIcon(category: FileCategory): LucideIcon {
  switch (category) {
    case 'image':
      return FileImage;
    case 'pdf':
      return FileText;
    case 'notebook':
      return FileCode;
    case 'spreadsheet':
      return FileSpreadsheet;
    case 'code':
      return FileCode;
    case 'text':
      return FileText;
    case 'audio':
      return FileAudio;
    case 'video':
      return FileVideo;
    default:
      return File;
  }
}

export function isImageFile(filename: string, contentType?: string): boolean {
  return getPreviewType(filename, contentType) === 'image';
}
