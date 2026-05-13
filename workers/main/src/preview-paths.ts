export interface ParsedFilePreviewPath {
  source: 'workspace' | 'upload' | 'output';
  path: string;
  filename: string;
}

const WORKSPACE_ROOT_PREFIXES = ['/home/claude', '/workspace', '/root'];
const TEMP_PREVIEW_PREFIXES = [
  { prefix: '/mnt/user-uploads/', source: 'upload' as const },
  { prefix: '/mnt/user-outputs/', source: 'output' as const },
];

function sanitizePathInput(path: string): string {
  return path.trim().replace(/\\/g, '/');
}

function normalizePathSegments(path: string, leadingSlash: boolean): string | null {
  const segments = path
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');

  if (segments.some((segment) => segment === '..')) {
    return null;
  }

  const normalized = segments.join('/');
  if (leadingSlash) {
    return normalized ? `/${normalized}` : '/';
  }
  return normalized;
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}

export function parseFilePreviewPath(rawPath: string): ParsedFilePreviewPath | null {
  const trimmed = sanitizePathInput(rawPath);
  if (!trimmed) return null;

  const absoluteInput = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;

  for (const { prefix, source } of TEMP_PREVIEW_PREFIXES) {
    if (!absoluteInput.startsWith(prefix)) continue;
    const relative = absoluteInput.slice(prefix.length);
    const normalized = normalizePathSegments(relative, false);
    if (!normalized) return null;
    return {
      source,
      path: normalized,
      filename: basename(normalized),
    };
  }

  let workspacePath = absoluteInput;
  for (const prefix of WORKSPACE_ROOT_PREFIXES) {
    if (workspacePath === prefix) {
      workspacePath = '/';
      break;
    }
    if (workspacePath.startsWith(`${prefix}/`)) {
      workspacePath = workspacePath.slice(prefix.length);
      if (!workspacePath.startsWith('/')) {
        workspacePath = `/${workspacePath}`;
      }
      break;
    }
  }

  const normalizedWorkspacePath = normalizePathSegments(workspacePath, true);
  if (!normalizedWorkspacePath || normalizedWorkspacePath === '/') return null;
  return {
    source: 'workspace',
    path: normalizedWorkspacePath,
    filename: basename(normalizedWorkspacePath),
  };
}
