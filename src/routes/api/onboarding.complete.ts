import { waitUntil } from 'cloudflare:workers';
import type { Route } from './+types/onboarding.complete';
import { getAuthEnv, requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as chatDO from '@/lib/chat-do.server';
import type { OnboardingPreferences } from '@/types';
import {
  buildOnboardingProfileMarkdown,
  buildOnboardingSystemContext,
} from '@/lib/onboarding';
import { INTEGRATION_REGISTRY } from '@/lib/integration-registry';
import {
  WorkspaceContainer,
  type WorkspaceContainerEnv,
} from '../../../workers/main/src/workspace-container';

function normalizeOnboardingInput(input: unknown): OnboardingPreferences {
  const data = (input ?? {}) as Partial<OnboardingPreferences>;
  const dataInterests = data.data_interests ?? { files: [], integrations: [] };

  return {
    ai_familiarity: data.ai_familiarity ?? null,
    iteration_style: data.iteration_style ?? null,
    stakes: data.stakes ?? null,
    design_style: data.design_style ?? null,
    starter_project: data.starter_project ?? null,
    data_interests: {
      files: Array.isArray(dataInterests.files)
        ? dataInterests.files
        : [],
      integrations: Array.isArray(dataInterests.integrations)
        ? dataInterests.integrations
        : [],
    },
    completed_at: data.completed_at ?? null,
  };
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

function isOwnerForOrg(
  orgId: string,
  memberships: Array<{ org_id: string; role: string }>
): boolean {
  return memberships.some(
    (membership) => membership.org_id === orgId && membership.role === 'owner'
  );
}

function buildIntegrationNameMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const definition of Object.values(INTEGRATION_REGISTRY)) {
    map.set(definition.type, definition.displayName);
  }
  return map;
}

async function writeOnboardingProfile(
  context: Route.ActionArgs['context'],
  workspaceId: string,
  orgId: string,
  profileMarkdown: string
): Promise<void> {
  const env = getEnv(context);
  const container = new WorkspaceContainer(env as unknown as WorkspaceContainerEnv, workspaceId, orgId);
  const writeResult = await container.writeFile(
    '/home/claude/.chiridion/profile.md',
    profileMarkdown
  );
  if (!writeResult.success) {
    throw new Error(writeResult.error ?? 'Unknown profile write error');
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const workspaceId = authContext.currentWorkspace?.id;
  if (!workspaceId) {
    return Response.json({ error: 'No workspace selected' }, { status: 400 });
  }

  let body: { onboarding?: unknown; desiredSlug?: string | null };
  try {
    body = (await request.json()) as { onboarding?: unknown; desiredSlug?: string | null };
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const desiredSlug = normalizeSlug(body.desiredSlug ?? '');
  if (desiredSlug) {
    const isOwner = isOwnerForOrg(authContext.currentOrg.id, authContext.orgs);
    if (!isOwner) {
      return Response.json({ error: 'Only owners can update the org slug' }, { status: 403 });
    }

    const orgStub = authEnv.ORG.get(
      authEnv.ORG.idFromName(authContext.currentOrg.id)
    );
    try {
      await orgStub.updateSlug(desiredSlug, authContext.user.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update slug';
      if (message === 'invalid_slug_format') {
        return Response.json({ error: 'Invalid slug format' }, { status: 400 });
      }
      if (message === 'slug_taken' || message === 'slug_already_finalized') {
        return Response.json({ error: message }, { status: 409 });
      }
      if (message === 'not_owner') {
        return Response.json({ error: 'Only owners can update the org slug' }, { status: 403 });
      }
      console.error('Failed to update slug during onboarding completion:', error);
      return Response.json({ error: 'Failed to update slug' }, { status: 500 });
    }
  }

  const onboarding = normalizeOnboardingInput(body.onboarding);
  const completed: OnboardingPreferences = {
    ...onboarding,
    completed_at: Date.now(),
  };

  const userStub = authEnv.USER.get(
    authEnv.USER.idFromName(authContext.user.id)
  );
  await userStub.updateOnboarding(completed);

  const thread = await chatDO.createThread(
    context,
    workspaceId,
    undefined,
    authContext.user.id
  );

  const integrationNameMap = buildIntegrationNameMap();
  const onboardingSystemMessage = buildOnboardingSystemContext(
    completed,
    integrationNameMap
  );
  const onboardingProfileMarkdown = buildOnboardingProfileMarkdown(
    completed,
    integrationNameMap
  );

  waitUntil(
    writeOnboardingProfile(
      context,
      workspaceId,
      authContext.currentOrg.id,
      onboardingProfileMarkdown
    ).catch((error) => {
      console.error('Failed to write onboarding profile:', error);
    })
  );

  return Response.json({
    success: true,
    threadId: thread.id,
    onboardingSystemMessage,
    redirectTo: `/chat/${thread.id}?newThread=1`,
  });
}
