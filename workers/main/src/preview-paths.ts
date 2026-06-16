export interface ParsedFilePreviewPath {
  source: 'workspace' | 'upload' | 'output';
  path: string;
  filename: string;
}

const WORKSPACE_ROOT_PREFIXES = ['/home/claude', '/workspace', '/root'];
const R2_PREVIEW_PREFIXES = [
  { prefix: 'uploads/', source: 'upload' as const },
  { prefix: 'outputs/', source: 'output' as const },
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

  for (const { prefix, source } of R2_PREVIEW_PREFIXES) {
    if (!trimmed.startsWith(prefix)) continue;
    const relative = trimmed.slice(prefix.length);
    const normalized = normalizePathSegments(relative, false);
    if (!normalized) return null;
    return {
      source,
      path: normalized,
      filename: basename(normalized),
    };
  }

  const absoluteInput = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
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
