/**
 * Chiridion URL Protocol Utilities
 *
 * Handles parsing and validation of chiridion:// URLs for file downloads.
 * Format: chiridion://outputs/<path>
 * Example: chiridion://outputs/report.pdf
 */

const CHIRIDION_PROTOCOL = 'chiridion://';
const OUTPUTS_PREFIX = 'outputs/';

export interface ChiridionUrl {
  /** Full path starting with /outputs/ */
  path: string;
  /** Filename from the path */
  filename: string;
}

/**
 * Check if a URL uses the chiridion:// protocol
 */
export function isChiridionUrl(url: string | null | undefined): boolean {
  return url?.startsWith(CHIRIDION_PROTOCOL) ?? false;
}

/**
 * Parse a chiridion:// URL into its components
 * Returns null if the URL is invalid
 *
 * Valid formats:
 * - chiridion://outputs/file.png
 * - chiridion://outputs/subdir/file.pdf
 */
export function parseChiridionUrl(url: string): ChiridionUrl | null {
  if (!isChiridionUrl(url)) {
    return null;
  }

  const withoutProtocol = url.slice(CHIRIDION_PROTOCOL.length);

  // Must start with outputs/
  if (!withoutProtocol.startsWith(OUTPUTS_PREFIX)) {
    return null;
  }

  // Get the file path after outputs/
  const filePath = withoutProtocol.slice(OUTPUTS_PREFIX.length);

  // Validate - must have a filename
  if (!filePath || filePath.endsWith('/')) {
    return null;
  }

  // Prevent directory traversal
  if (filePath.includes('..')) {
    return null;
  }

  // Extract filename
  const filename = filePath.split('/').pop() || filePath;

  return {
    path: `/outputs/${filePath}`,
    filename,
  };
}

/**
 * Build a download API URL from a parsed chiridion URL
 */
export function buildDownloadUrl(workspaceId: string, chiridionUrl: ChiridionUrl): string {
  return `/api/workspaces/${workspaceId}/download?path=${encodeURIComponent(chiridionUrl.path)}`;
}
