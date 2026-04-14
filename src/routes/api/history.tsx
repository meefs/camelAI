import type { AppLoadContext } from 'react-router';
import { getAuthEnv, requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import {
  fetchHistoryThreadsPage,
  getHistoryCreatedBy,
  getHistoryScope,
  hydrateHistoryThreads,
} from '@/lib/history.server';

const DEFAULT_LIMIT = 50;

function parsePositiveInteger(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function loader({
  request,
  context,
}: {
  request: Request;
  context: AppLoadContext;
}) {
  const authContext = await requireAuthContext(request, context);
  const authEnv = getAuthEnv(getEnv(context));

  const url = new URL(request.url);
  const scope = getHistoryScope(url.searchParams);
  const createdBy = getHistoryCreatedBy(url.searchParams);
  const queryKey = url.searchParams.get('queryKey')?.trim() || '';
  const offset = parsePositiveInteger(url.searchParams.get('offset'), 0);
  const limit = parsePositiveInteger(url.searchParams.get('limit'), DEFAULT_LIMIT);
  const accessibleWorkspaceIds = authContext.workspaces.map((workspace) => workspace.id);
  const workspaceId =
    url.searchParams.get('workspaceId')?.trim() || authContext.currentWorkspace?.id || '';

  if (scope === 'this-workspace') {
    if (!workspaceId) {
      return Response.json({ error: 'Workspace ID required' }, { status: 400 });
    }
    if (!accessibleWorkspaceIds.includes(workspaceId)) {
      return Response.json({ error: 'Workspace not found' }, { status: 404 });
    }
  }

  const page = await fetchHistoryThreadsPage(context, {
    scope,
    workspaceId,
    accessibleWorkspaceIds,
    offset,
    limit,
    createdBy,
  });
  const { threads } = await hydrateHistoryThreads(authEnv, page.items);

  return Response.json({
    threads,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    queryKey,
  });
}
