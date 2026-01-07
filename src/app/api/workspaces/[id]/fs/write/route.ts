import { NextRequest } from 'next/server';
import * as computerDO from '@/lib/computer-do';
import { errorResponse, jsonResponse } from '@/lib/auth';
import type { WorkspaceFileWrite } from '@/types';
import { hashContent, normalizeWorkspacePath, parseJson, requireWorkspaceSession } from '../utils';

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface WritePayload {
  path?: string;
  content?: string;
  baseVersion?: string | null;
}

const encoder = new TextEncoder();

function getByteSize(value: string): number {
  return encoder.encode(value).length;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const auth = await requireWorkspaceSession(id, { requireWrite: true });
    if (auth.response) return auth.response;

    const payload = await parseJson<WritePayload>(request);
    if (!payload.path || typeof payload.content !== 'string') {
      return errorResponse('Invalid write payload', 400);
    }

    const path = normalizeWorkspacePath(payload.path);
    const baseVersion =
      payload.baseVersion === undefined ? undefined : payload.baseVersion;

    const existing = await computerDO.readWorkspaceFile(id, path);
    const currentVersion = existing?.result.content
      ? await hashContent(existing.result.content)
      : null;

    if (baseVersion !== undefined) {
      if (currentVersion && baseVersion !== currentVersion) {
        return jsonResponse({ error: 'Version conflict', currentVersion }, 409);
      }
      if (!currentVersion && baseVersion !== null) {
        return jsonResponse({ error: 'Version conflict', currentVersion: null }, 409);
      }
    }

    await computerDO.writeWorkspaceFile(id, path, payload.content);
    const newVersion = await hashContent(payload.content);

    const parentPath =
      path === '/' ? '/' : path.split('/').slice(0, -1).join('/') || '/';
    const listing = await computerDO.listWorkspaceEntries(id, {
      path: parentPath,
      recursive: false,
      includeHidden: true,
    });
    const entry = listing.entries.find((item) => item.path === path);

    const response: WorkspaceFileWrite = {
      path,
      newVersion,
      size: entry?.size ?? getByteSize(payload.content),
      mtime: entry?.modifiedAt ?? null,
    };

    return jsonResponse(response);
  } catch (error) {
    console.error('Error writing workspace file:', error);
    return errorResponse('Failed to write workspace file', 500);
  }
}
