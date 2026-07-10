import type { Route } from './+types/workspaces.$id.projects.$project.fs.content.$';
import { getEnv } from '@/lib/cloudflare.server';
import { ProjectFilesystemClient, WorkspaceFilesystemClient } from '../../../workers/main/src/workspace-filesystem-do';
import {
  normalizeWorkspacePath,
  requireWorkspaceAccess,
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
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson',
  '.ipynb': 'application/x-ipynb+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.ts': 'application/typescript; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.sh': 'text/x-shellscript',
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

function getMimeType(filename: string): string {
  const ext = filename.includes('.') ? `.${filename.split('.').pop()?.toLowerCase()}` : '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function shouldDisplayInline(contentType: string): boolean {
  const normalized = contentType.split(';')[0].trim().toLowerCase();
  if (INLINE_MIME_TYPES.has(normalized)) return true;
  return INLINE_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function decodeProjectFilePath(rawPath: string): string {
  const decoded = decodeURIComponent(rawPath);
  const withLeadingSlash = decoded.startsWith('/') ? decoded : `/${decoded}`;
  return normalizeWorkspacePath(withLeadingSlash);
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    const workspaceId = params.id;
    const project = params.project;
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }
    if (!project) {
      return Response.json({ error: 'Project required' }, { status: 400 });
    }

    await requireWorkspaceAccess(request, context, workspaceId);

    const rawFilePath = params['*'];
    if (!rawFilePath) {
      return Response.json({ error: 'File path required' }, { status: 400 });
    }

    const path = decodeProjectFilePath(rawFilePath);
    const env = getEnv(context);
    const workspaceFs = new WorkspaceFilesystemClient(env as never, workspaceId);
    const projectRecord = await workspaceFs.getProjectByName(project);
    if (!projectRecord) {
      return Response.json({ error: 'Project not found' }, { status: 404 });
    }

    if ((projectRecord.backend ?? 'vm') !== 'do-r2') {
      return Response.json(
        { error: 'This legacy project was archived when camelAI retired project VMs.' },
        { status: 404 },
      );
    }

    const resolvedPath = path;
    let contentLength: string | null = null;
    const projectFs = new ProjectFilesystemClient(env as never, projectRecord.id);
    const result = await projectFs.readFileStream(path);
    if (!result.success || !result.stream) {
      return Response.json({ error: 'File not found' }, { status: 404 });
    }
    const body = result.stream;
    contentLength = typeof result.size === 'number' ? String(result.size) : null;

    if (!body) {
      return Response.json({ error: 'File not found' }, { status: 404 });
    }

    const filename = resolvedPath.split('/').filter(Boolean).pop() || 'file';
    const contentType = getMimeType(filename);
    const displayInline = shouldDisplayInline(contentType);

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `${displayInline ? 'inline' : 'attachment'}; filename="${filename}"`,
    };
    if (contentLength) {
      headers['Content-Length'] = contentLength;
    }

    return new Response(body, { headers });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error serving project content file:', error);
    return Response.json({ error: 'Failed to serve project content file' }, { status: 500 });
  }
}
