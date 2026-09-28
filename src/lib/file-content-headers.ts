/**
 * How chiridion serves a stored file's bytes from its own origin: the content
 * type from the file's extension, and whether it shows inline or downloads.
 * Shared by the workspace file route and the runtime scratch file route, so
 * both previews behave the same.
 */
const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.ipynb': 'application/x-ipynb+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.ts': 'application/typescript; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
};

const INLINE_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'text/'];

const INLINE_MIME_TYPES = new Set([
  'application/pdf',
  'application/json',
  'application/x-ndjson',
  'application/javascript',
  'application/xml',
  'application/typescript',
  'application/x-ipynb+json',
]);

export function getMimeType(filename: string): string {
  const ext = filename.includes('.') ? `.${filename.split('.').pop()?.toLowerCase()}` : '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

export function shouldDisplayInline(contentType: string): boolean {
  const normalized = contentType.split(';')[0].trim().toLowerCase();
  if (INLINE_MIME_TYPES.has(normalized)) return true;
  return INLINE_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
