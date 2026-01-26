/**
 * Chiridion URL Protocol Utilities
 *
 * Handles parsing and validation of chiridion:// URLs for file downloads.
 * Format: chiridion://outputs/<path>
 * Example: chiridion://outputs/report.pdf
 */

const CHIRIDION_PROTOCOL = 'chiridion://';
const OUTPUTS_PREFIX = 'outputs/';
const MNT_USER_OUTPUTS_PATH = '/mnt/user-outputs/';

export interface ChiridionUrl {
  /** Full path starting with /outputs/ */
  path: string;
  /** Filename from the path */
  filename: string;
}

/**
 * Check if a URL uses the chiridion:// protocol or /mnt/user-outputs/ path
 */
export function isChiridionUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.startsWith(CHIRIDION_PROTOCOL) || url.startsWith(MNT_USER_OUTPUTS_PATH);
}

/**
 * Parse a chiridion:// URL or /mnt/user-outputs/ path into its components
 * Returns null if the URL is invalid
 *
 * Valid formats:
 * - chiridion://outputs/file.png
 * - chiridion://outputs/subdir/file.pdf
 * - /mnt/user-outputs/file.png
 * - /mnt/user-outputs/subdir/file.pdf
 */
export function parseChiridionUrl(url: string): ChiridionUrl | null {
  if (!isChiridionUrl(url)) {
    return null;
  }

  let filePath: string;

  if (url.startsWith(CHIRIDION_PROTOCOL)) {
    const withoutProtocol = url.slice(CHIRIDION_PROTOCOL.length);

    // Must start with outputs/
    if (!withoutProtocol.startsWith(OUTPUTS_PREFIX)) {
      return null;
    }

    // Get the file path after outputs/
    filePath = withoutProtocol.slice(OUTPUTS_PREFIX.length);
  } else if (url.startsWith(MNT_USER_OUTPUTS_PATH)) {
    // Handle /mnt/user-outputs/ paths
    filePath = url.slice(MNT_USER_OUTPUTS_PATH.length);
  } else {
    return null;
  }

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
