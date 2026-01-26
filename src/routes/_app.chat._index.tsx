import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.chat._index';
import { requireAuthContext } from '@/lib/auth.server';
import { getCtx } from '@/lib/cloudflare.server';
import * as chatDO from '@/lib/chat-do.server';
import Chat from '@/components/Chat';
import { NoWorkspacesError } from '@/components/no-workspaces-error';

export function meta() {
  return [
    { title: 'New Chat - Chiridion' },
    { name: 'description', content: 'Start a new AI chat' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const hostname = request.headers.get('host')?.split(':')[0] || undefined;

  return {
    workspaceId: authContext.currentWorkspace?.id || null,
    hostname,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);

  if (!authContext.currentWorkspace?.id) {
    return Response.json({ error: 'No workspace selected' }, { status: 400 });
  }

  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'createThread') {
    try {
      const firstMessage = formData.get('firstMessage') as string | null;
      const thread = await chatDO.createThread(
        context,
        authContext.currentWorkspace.id,
        undefined, // title will be generated asynchronously
        authContext.user?.id
      );

      // Generate title in background if we have a first message
      if (firstMessage) {
        const ctx = getCtx(context);
        ctx.waitUntil(
          chatDO.generateThreadTitle(
            context,
            thread.id,
            authContext.currentWorkspace.id,
            firstMessage
          )
        );
      }

      return Response.json({ thread });
    } catch (error) {
      console.error('Failed to create thread:', error);
      return Response.json({ error: 'Failed to create thread' }, { status: 500 });
    }
  }

  return Response.json({ error: 'Unknown intent' }, { status: 400 });
}

export default function NewChatPage() {
  const { workspaceId, hostname } = useLoaderData<typeof loader>();

  if (!workspaceId) {
    return <NoWorkspacesError />;
  }

  return <Chat workspaceId={workspaceId} hostname={hostname} />;
}
