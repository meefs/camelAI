/**
 * External MCP Server Handler
 *
 * MCP server for external clients (Claude.ai, ChatGPT, etc.) authenticated
 * via OAuth 2.1. Exposes workspace tools: bash, list_apps, list_files,
 * read_file, write_file.
 *
 * Each connection is scoped to a single workspace via the OAuth grant.
 */

import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OrgDO, WorkerScript } from './auth';
import type { WorkspaceDO } from './workspace';
import { WorkspaceContainer, type WorkspaceContainerEnv } from './workspace-container';
import { getEnvPrefix } from './cf-api-proxy';

export interface ExternalMcpEnv extends WorkspaceContainerEnv {
  EXTERNAL_MCP_OBJECT: DurableObjectNamespace<ExternalMcpDO>;
  APP_KV: KVNamespace;
}

// Headers set by the route handler after OAuth token verification
const AUTH_HEADER_ORG_ID = 'x-ext-mcp-org-id';
const AUTH_HEADER_USER_ID = 'x-ext-mcp-user-id';
const AUTH_HEADER_WORKSPACE_ID = 'x-ext-mcp-workspace-id';

/**
 * External MCP Agent DO
 */
export class ExternalMcpDO extends McpAgent<ExternalMcpEnv, Record<string, unknown>, Record<string, unknown>> {
  server = new McpServer({
    name: 'camelai-external',
    version: '1.0.0',
  });

  private orgId: string | null = null;
  private userId: string | null = null;
  private workspaceId: string | null = null;

  async fetch(request: Request): Promise<Response> {
    this.orgId = request.headers.get(AUTH_HEADER_ORG_ID);
    this.userId = request.headers.get(AUTH_HEADER_USER_ID);
    this.workspaceId = request.headers.get(AUTH_HEADER_WORKSPACE_ID);
    return super.fetch(request);
  }

  private requireAuth(): { orgId: string; userId: string; workspaceId: string } {
    if (!this.orgId || !this.userId || !this.workspaceId) {
      throw new Error('Authentication context not available');
    }
    return { orgId: this.orgId, userId: this.userId, workspaceId: this.workspaceId };
  }

  private textResponse(data: unknown) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    };
  }

  private getOrgStub(): DurableObjectStub<OrgDO> {
    if (!this.orgId) throw new Error('No org context');
    return this.env.ORG.get(this.env.ORG.idFromName(this.orgId)) as DurableObjectStub<OrgDO>;
  }

  private getContainer(): WorkspaceContainer {
    const { workspaceId, orgId } = this.requireAuth();
    return new WorkspaceContainer(this.env, workspaceId, orgId);
  }

  /**
   * Get the vanity domain for deployed apps.
   */
  private getVanityDomain(): string {
    const baseUrl = this.env.WORKER_BASE_URL;
    if (baseUrl) {
      try {
        const hostname = new URL(baseUrl).hostname;
        const envPrefix = getEnvPrefix(hostname);
        if (envPrefix) return `${envPrefix}.camelai.app`;
        if (hostname !== 'camelai.dev' && !hostname.endsWith('.camelai.dev')) {
          return 'local.camelai.app';
        }
        return 'camelai.app';
      } catch {
        return 'camelai.app';
      }
    }
    return 'camelai.app';
  }

  private async getAppUrl(scriptName: string): Promise<string> {
    try {
      const orgStub = this.getOrgStub();
      const customDomain = await orgStub.getCustomDomain();
      if (customDomain?.domain) {
        return `https://${scriptName}.${customDomain.domain}`;
      }
    } catch {}

    try {
      const orgStub = this.getOrgStub();
      const orgSlug = await orgStub.getSlug();
      if (orgSlug) {
        const separator = /^[a-z0-9]{6,}$/.test(orgSlug) ? '-' : '--';
        return `https://${scriptName}${separator}${orgSlug}.${this.getVanityDomain()}`;
      }
    } catch {}

    return `https://${scriptName}.${this.getVanityDomain()}`;
  }

  async init() {
    // ── bash ─────────────────────────────────────────────────────
    this.server.tool(
      'bash',
      'Execute a bash command in the workspace container. The working directory is /home/claude by default. Commands run as the claude user inside a gVisor-sandboxed container.',
      {
        command: z.string().describe('The bash command to execute'),
        cwd: z.string().optional().describe('Working directory (default: /home/claude)'),
      },
      async ({ command, cwd }) => {
        this.requireAuth();
        const container = this.getContainer();
        const result = await container.exec(command, { cwd });

        return this.textResponse({
          success: result.success,
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          ...(result.killed && { killed: true }),
          ...(result.signal && { signal: result.signal }),
        });
      }
    );

    // ── list_apps ────────────────────────────────────────────────
    this.server.tool(
      'list_apps',
      'List deployed apps/workers in the current workspace. Returns app names, URLs, visibility status, and creation info.',
      {},
      async () => {
        const { workspaceId } = this.requireAuth();
        const orgStub = this.getOrgStub();
        const scripts: WorkerScript[] = await orgStub.listWorkerScriptsByWorkspace(workspaceId);

        const apps = await Promise.all(scripts.map(async (s: WorkerScript) => ({
          name: s.script_name,
          url: await this.getAppUrl(s.script_name),
          is_public: s.is_public,
          created_at: new Date(s.created_at).toISOString(),
          updated_at: new Date(s.updated_at).toISOString(),
        })));

        return this.textResponse({ count: apps.length, apps });
      }
    );

    // ── list_files ───────────────────────────────────────────────
    this.server.tool(
      'list_files',
      'List files and directories in the workspace container.',
      {
        path: z.string().optional().describe('Directory path to list (default: /home/claude)'),
        recursive: z.boolean().optional().describe('Recursively list all files (default: false)'),
      },
      async ({ path, recursive }) => {
        this.requireAuth();
        const container = this.getContainer();
        const targetPath = path ?? '/home/claude';

        const result = await container.listFiles(targetPath, {
          recursive: recursive ?? false,
        });

        return this.textResponse(result);
      }
    );

    // ── read_file ────────────────────────────────────────────────
    this.server.tool(
      'read_file',
      'Read the contents of a file in the workspace container.',
      {
        path: z.string().describe('Absolute path to the file to read'),
      },
      async ({ path: filePath }) => {
        this.requireAuth();
        const container = this.getContainer();
        const result = await container.readFile(filePath);

        if (!result.success) {
          return this.textResponse({ success: false, error: result.error ?? 'Failed to read file' });
        }

        return this.textResponse({
          success: true,
          path: filePath,
          content: result.content,
          size: result.size,
          is_binary: result.isBinary ?? false,
        });
      }
    );

    // ── write_file ───────────────────────────────────────────────
    this.server.tool(
      'write_file',
      'Write content to a file in the workspace container. Creates the file if it does not exist, overwrites if it does.',
      {
        path: z.string().describe('Absolute path to the file to write'),
        content: z.string().describe('Content to write to the file'),
      },
      async ({ path: filePath, content }) => {
        this.requireAuth();
        const container = this.getContainer();
        const result = await container.writeFile(filePath, content);

        if (!result.success) {
          return this.textResponse({ success: false, error: result.error ?? 'Failed to write file' });
        }

        return this.textResponse({
          success: true,
          path: filePath,
          message: `File written successfully`,
        });
      }
    );

    // ── upload_file ──────────────────────────────────────────────
    this.server.tool(
      'upload_file',
      'Upload a binary file to the workspace container. Content must be base64-encoded. Use this for images, PDFs, archives, or any non-text file.',
      {
        path: z.string().describe('Absolute path to write the file to in the container'),
        content_base64: z.string().describe('Base64-encoded file content'),
      },
      async ({ path: filePath, content_base64 }) => {
        this.requireAuth();
        const container = this.getContainer();

        // Validate base64
        try {
          atob(content_base64.replace(/[\s\n]/g, ''));
        } catch {
          return this.textResponse({ success: false, error: 'Invalid base64 content' });
        }

        const result = await container.writeBinaryFile(filePath, content_base64);

        if (!result.success) {
          return this.textResponse({ success: false, error: result.error ?? 'Failed to upload file' });
        }

        // Get file size
        const sizeBytes = Math.floor(content_base64.replace(/[\s\n=]/g, '').length * 3 / 4);

        return this.textResponse({
          success: true,
          path: filePath,
          size: sizeBytes,
          message: `File uploaded successfully (${formatSize(sizeBytes)})`,
        });
      }
    );

    // ── download_file ────────────────────────────────────────────
    this.server.tool(
      'download_file',
      'Download a file from the workspace container. Returns the file as an embedded MCP resource with a URI, mime type, and content (text or base64 blob).',
      {
        path: z.string().describe('Absolute path to the file to download'),
      },
      async ({ path: filePath }) => {
        this.requireAuth();
        const container = this.getContainer();
        const result = await container.readFile(filePath);

        if (!result.success) {
          return this.textResponse({ success: false, error: result.error ?? 'Failed to download file' });
        }

        const filename = filePath.split('/').pop() ?? filePath;
        const mimeType = guessMimeType(filename);
        const uri = `file://${filePath}`;

        // Binary files → blob resource (base64)
        if (result.isBinary) {
          return {
            content: [{
              type: 'resource' as const,
              resource: {
                uri,
                mimeType,
                blob: result.content!,
              },
            }],
          };
        }

        // Text files → text resource
        return {
          content: [{
            type: 'resource' as const,
            resource: {
              uri,
              mimeType,
              text: result.content!,
            },
          }],
        };
      }
    );
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MIME_TYPES: Record<string, string> = {
  // Text
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
  '.xml': 'text/xml', '.svg': 'image/svg+xml',
  // Code
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript',
  '.ts': 'text/typescript', '.tsx': 'text/typescript', '.jsx': 'text/javascript',
  '.json': 'application/json', '.jsonl': 'application/x-ndjson',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/x-toml',
  '.py': 'text/x-python', '.rb': 'text/x-ruby', '.go': 'text/x-go',
  '.rs': 'text/x-rust', '.java': 'text/x-java', '.c': 'text/x-c',
  '.cpp': 'text/x-c++', '.h': 'text/x-c', '.sh': 'text/x-shellscript',
  '.sql': 'text/x-sql',
  // Images
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.avif': 'image/avif',
  // Documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Archives
  '.zip': 'application/zip', '.gz': 'application/gzip',
  '.tar': 'application/x-tar', '.7z': 'application/x-7z-compressed',
  // Data
  '.parquet': 'application/x-parquet', '.sqlite': 'application/x-sqlite3',
  '.db': 'application/x-sqlite3', '.wasm': 'application/wasm',
  // Media
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function guessMimeType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = filename.slice(dot).toLowerCase();
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}
