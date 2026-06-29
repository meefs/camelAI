import type { PreviewTarget } from '@/types';
import { PREVIEW_INITIAL_MAX_LINES } from '@/lib/file-preview-limits';

export { PREVIEW_INITIAL_MAX_LINES };

export interface FilePreviewUrlDescriptor {
  workspaceId: string;
  source: 'workspace' | 'project' | 'vm' | 'upload' | 'output';
  path: string;
  project?: string;
}

function encodePathSegments(path: string) {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export function buildRawFilePreviewRoute(descriptor: FilePreviewUrlDescriptor): string {
  const normalizedPath = descriptor.path.replace(/^\/+/, '');
  const encodedPath = encodePathSegments(normalizedPath);
  if (descriptor.source === 'vm' || descriptor.source === 'project') {
    const encodedProject = encodeURIComponent(descriptor.project ?? '');
    return `/api/workspaces/${descriptor.workspaceId}/projects/${encodedProject}/fs/content/${encodedPath}`;
  }
  const route =
    descriptor.source === 'workspace'
      ? `fs/content/${encodedPath}`
      : `${descriptor.source === 'upload' ? 'uploads' : 'outputs'}/${encodedPath}`;
  return `/api/workspaces/${descriptor.workspaceId}/${route}`;
}

export function buildTextPreviewUrls(
  descriptor: FilePreviewUrlDescriptor,
  opts: { refreshKey?: number; maxLines?: number } = {}
): { initialUrl: string; fullUrl: string } {
  const buildUrl = (mode: 'initial' | 'full') => {
    const params = new URLSearchParams({
      source: descriptor.source,
      path: descriptor.path,
      mode,
    });
    if (descriptor.project) {
      params.set('project', descriptor.project);
    }
    if (mode === 'initial') {
      params.set('maxLines', String(opts.maxLines ?? PREVIEW_INITIAL_MAX_LINES));
      if (typeof opts.refreshKey === 'number') {
        params.set('v', String(opts.refreshKey));
      }
    }
    return `/api/workspaces/${descriptor.workspaceId}/file-preview/text?${params.toString()}`;
  };

  return {
    initialUrl: buildUrl('initial'),
    fullUrl: buildUrl('full'),
  };
}

export function getFilePreviewUrlDescriptor(
  target: Extract<PreviewTarget, { kind: 'file' }>
): FilePreviewUrlDescriptor {
  return {
    workspaceId: target.workspaceId,
    source: target.source,
    path: target.path,
    project: target.project,
  };
}
