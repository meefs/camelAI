import { useState } from 'react';
import { useLoaderData, useSearchParams, useFetcher, Link } from 'react-router';
import type { Route } from './+types/_app.settings.workspace.chats';
import { requireAuthContext, requireOrgAdmin, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as chatDO from '@/lib/chat-do.server';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Trash2 } from 'lucide-react';
import { NoWorkspacesError } from '@/components/no-workspaces-error';
import type { Thread, User } from '@/types';

interface ChatRow extends Omit<Thread, 'creator'> {
  workspace_name: string;
  creator?: Pick<User, 'id' | 'name' | 'email'> | null;
}

const PAGE_SIZE = 50;

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString();
}

function formatRelativeTime(ts: number) {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 30) return new Date(ts).toLocaleDateString();
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

export function meta() {
  return [
    { title: 'Chats - Workspace Settings - camelAI' },
    { name: 'description', content: 'Manage workspace chats' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'deleteThread') {
    const threadId = formData.get('threadId') as string;
    const workspaceId = formData.get('workspaceId') as string;

    if (!threadId || !workspaceId) {
      return { error: 'Thread ID and workspace ID are required' };
    }

    try {
      await chatDO.deleteThread(context, threadId, workspaceId);
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to delete chat' };
    }
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  await requireOrgAdmin(request, context, authContext.currentOrg.id);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'this-workspace';
  const workspaceId = authContext.currentWorkspace?.id;

  if (!workspaceId) {
    return { chats: [] as ChatRow[], total: 0, hasWorkspace: false, filter };
  }

  const workspaces = authContext.workspaces ?? [];
  const workspaceNameMap = new Map(workspaces.map((ws) => [ws.id, ws.name]));
  const accessibleWorkspaceIds = workspaces.map((ws) => ws.id);

  // Fetch threads using existing paginated methods
  const page = filter === 'all-workspaces'
    ? await chatDO.getThreadsPaginatedAllWorkspaces(context, accessibleWorkspaceIds, {
        offset: 0,
        limit: PAGE_SIZE,
      })
    : await chatDO.getThreadsPaginated(context, workspaceId, {
        offset: 0,
        limit: PAGE_SIZE,
      });

  // Hydrate creators
  const creatorIds = Array.from(
    new Set(page.items.map((t) => t.created_by).filter(Boolean))
  );
  const creatorProfiles = await Promise.all(
    creatorIds.map(async (id) => {
      const profile = await authEnv.USER.get(authEnv.USER.idFromName(id)).getProfile();
      return [id, profile] as const;
    })
  );
  const creatorMap = new Map(creatorProfiles.filter(([, p]) => p !== null));

  const chats: ChatRow[] = page.items.map((thread) => {
    const creator = creatorMap.get(thread.created_by);
    return {
      ...thread,
      workspace_name: workspaceNameMap.get(thread.workspace_id) ?? thread.workspace_id,
      creator: creator ? { id: creator.id, name: creator.name, email: creator.email } : null,
    };
  });

  return { chats, total: page.total, hasWorkspace: true, filter };
}

export default function WorkspaceChatsPage() {
  const { chats, total, hasWorkspace, filter } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [deleteTarget, setDeleteTarget] = useState<ChatRow | null>(null);

  if (!hasWorkspace) {
    return <NoWorkspacesError />;
  }

  const currentFilter = searchParams.get('filter') || 'this-workspace';
  const showWorkspaceColumn = currentFilter === 'all-workspaces';

  const handleFilterChange = (value: string) => {
    setSearchParams((prev) => {
      prev.set('filter', value);
      return prev;
    });
  };

  const handleDelete = (chat: ChatRow) => {
    fetcher.submit(
      {
        intent: 'deleteThread',
        threadId: chat.id,
        workspaceId: chat.workspace_id,
      },
      { method: 'POST' }
    );
    setDeleteTarget(null);
  };

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Chats"
        description="View and manage chat threads across workspaces."
      />
      <Separator />

      <div className="flex items-center gap-2">
        <Tabs value={currentFilter} onValueChange={handleFilterChange}>
          <TabsList variant="line">
            <TabsTrigger value="this-workspace">This workspace</TabsTrigger>
            <TabsTrigger value="all-workspaces">All workspaces</TabsTrigger>
          </TabsList>
        </Tabs>
        {total > 0 ? (
          <span className="text-xs text-muted-foreground ml-auto">
            {total} {total === 1 ? 'chat' : 'chats'}
          </span>
        ) : null}
      </div>

      {chats.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          No chats found.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              {showWorkspaceColumn ? <TableHead>Workspace</TableHead> : null}
              <TableHead>Created By</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last Active</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {chats.map((chat) => (
              <TableRow key={chat.id}>
                <TableCell className="font-medium max-w-[300px] truncate">
                  <Link
                    to={`/chat/${chat.id}`}
                    className="hover:underline"
                  >
                    {chat.title || 'Untitled'}
                  </Link>
                </TableCell>
                {showWorkspaceColumn ? (
                  <TableCell className="text-muted-foreground text-sm">
                    {chat.workspace_name}
                  </TableCell>
                ) : null}
                <TableCell className="text-muted-foreground text-sm">
                  {chat.creator?.name ?? chat.creator?.email ?? '—'}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatDate(chat.created_at)}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {formatRelativeTime(chat.updated_at)}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setDeleteTarget(chat)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete chat?"
        description={`This will permanently delete "${deleteTarget?.title || 'Untitled'}". This action cannot be undone.`}
        confirmLabel="Delete chat"
        variant="destructive"
        onConfirm={() => {
          if (deleteTarget) handleDelete(deleteTarget);
        }}
      />
    </div>
  );
}
