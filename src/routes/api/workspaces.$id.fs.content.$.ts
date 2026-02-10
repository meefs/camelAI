import type { Route } from './+types/workspaces.$id.fs.content.$';
import {
  requireWorkspaceAuth,
  normalizeWorkspacePath,
  resolveContainerPath,
  toContainerPath,
} from './workspaces.utils';

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
  '.json': 'application/json; charset=utf-8',
  '.ipynb': 'application/x-ipynb+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
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
  'application/javascript',
  'application/xml',
  'application/typescript',
  'application/x-ipynb+json',
]);

function getMimeType(filename: string): string {
  const ext = filename.includes('.') ? `.${filename.split('.').pop()?.toLowerCase()}` : '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function shouldDisplayInline(contentType: string): boolean {
  const normalized = contentType.split(';')[0].trim().toLowerCase();
  if (INLINE_MIME_TYPES.has(normalized)) return true;
  return INLINE_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function toFileBytes(base64: string): ArrayBuffer {
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return buffer;
}

function decodeWorkspacePath(rawPath: string): string {
  const decoded = decodeURIComponent(rawPath);
  const withLeadingSlash = decoded.startsWith('/') ? decoded : `/${decoded}`;
  return normalizeWorkspacePath(withLeadingSlash);
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    const workspaceId = params.id;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }

    const rawFilePath = params['*'];
    if (!rawFilePath) {
      return Response.json({ error: 'File path required' }, { status: 400 });
    }

    const workspacePath = decodeWorkspacePath(rawFilePath);
    const { container } = await requireWorkspaceAuth(request, context, workspaceId);

    const containerPath = toContainerPath(workspacePath);

    let result = await container.readFile(containerPath);
    if (!result.success && result.code === 'ENOENT') {
      const resolvedPath = await resolveContainerPath(container, workspacePath);
      if (resolvedPath && resolvedPath !== containerPath) {
        result = await container.readFile(resolvedPath);
      }
    }

    if (!result.success) {
      const status = result.code === 'ENOENT' ? 404 : 500;
      return Response.json({ error: result.error || 'Failed to read file' }, { status });
    }

    const filename = workspacePath.split('/').filter(Boolean).pop() || 'file';
    const contentType = result.mimeType || getMimeType(filename);
    const displayInline = shouldDisplayInline(contentType);

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `${displayInline ? 'inline' : 'attachment'}; filename="${filename}"`,
    };

    const body: BodyInit = result.isBinary && result.encoding === 'base64'
      ? (() => {
          const buffer = toFileBytes(result.content || '');
          return new Blob([buffer], { type: contentType });
        })()
      : result.content || '';

    return new Response(body, { headers });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error serving workspace content file:', error);
    return Response.json({ error: 'Failed to serve workspace content file' }, { status: 500 });
  }
}
