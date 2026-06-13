import type { Route } from './+types/onboarding.complete';
import { getAuthEnv, requireAuthContext, type AuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as chatDO from '@/lib/chat-do.server';
import { waitUntil } from '@/lib/wait-until';
import {
  isOrgBillingAccessReady,
  resolveOrgBillingAccess,
} from '@/lib/billing.server';
import {
  chatBillingActionPayload,
  chatStartFailureStatus,
} from '@/lib/chat-api-errors';
import { getEffectiveLlmProviderConfig } from '@/lib/selfhost-ai-provider';
import type { LlmModel } from '@/types';

type OnboardingAccessChoice = 'byok' | 'existing' | null;

type InitialUserMessageRpc = {
  startInitialUserMessage(args: {
    threadId: string;
    workspaceId: string;
    orgId: string;
    userId?: string | null;
    messageSource?: string | null;
    message: string;
    clientMessageId?: string;
  }): Promise<{ status: 'accepted' | 'busy' | 'error'; error?: string }>;
};

type InitialUserMessageResult = Awaited<
  ReturnType<InitialUserMessageRpc['startInitialUserMessage']>
>;

function getDefaultOnboardingSystemMessage(): string {
  const questionToolName = 'AskUserQuestion';
  return `This user just signed up and landed in their first chat. This is their very
first interaction with camelAI.

Welcome them briefly (1-2 sentences), then immediately use the ${questionToolName} tool
with these 2 questions in a single tool call:

Question 1 - "What do you want to build first?"
  header: "Starter project"
  multiSelect: false
  Options:
  - label: "Data analytics"
    description: "Upload spreadsheets or connect a database for insights"
  - label: "Personal site"
    description: "Portfolio, blog, or landing page"
  - label: "Business tool"
    description: "Internal tools, dashboards, admin panels"
  - label: "Something fun"
    description: "Games, experiments, creative projects"

Question 2 - "Do you have data or services to connect?"
  header: "Data setup"
  multiSelect: false
  Options:
  - label: "I have files to upload"
    description: "CSVs, spreadsheets, PDFs, or other data files"
  - label: "Help me connect a service"
    description: "Walk me through connecting a database, Slack, or API"
  - label: "Not right now"
    description: "I'll jump straight into building"

After they answer, immediately start helping them based on their choices:
- If they chose "Data analytics" + "I have files to upload": prompt them to
  drag a file into the chat
- If they chose "Help me connect a service": walk them through the
  connections setup flow
- Otherwise: start building their chosen project right away`;
}

const SALES_SITE_ONBOARDING_SYSTEM_MESSAGE = `This user just signed up from the camelAI sales site where they typed a
starter prompt. This is their very first interaction with camelAI.

Welcome them briefly (1 sentence max), then start working on their request
immediately. They already told you what they want, so skip the standard
onboarding preference questions and dive into the work.

If you need clarification, ask focused follow-up questions inline as you go.
Do not use AskUserQuestion for onboarding in this case.`;

function getOnboardingSystemMessage(
  salesPrompt: string | null,
): string {
  return salesPrompt ? SALES_SITE_ONBOARDING_SYSTEM_MESSAGE : getDefaultOnboardingSystemMessage();
}

function buildOnboardingInitialMessage(
  onboardingSystemMessage: string,
  salesPrompt: string | null,
): string {
  return salesPrompt
    ? `<camelai system message>${onboardingSystemMessage}</camelai system message>\n\n${salesPrompt}`
    : `<camelai system message>${onboardingSystemMessage}</camelai system message>`;
}

async function startOnboardingInitialMessage(args: {
  env: ReturnType<typeof getEnv>;
  threadId: string;
  workspaceId: string;
  orgId: string;
  userId: string;
  message: string;
}): Promise<InitialUserMessageResult> {
  const chatThread = args.env.CHAT_THREAD.get(
    args.env.CHAT_THREAD.idFromName(args.threadId),
  ) as unknown as InitialUserMessageRpc;
  return await chatThread.startInitialUserMessage({
    threadId: args.threadId,
    workspaceId: args.workspaceId,
    orgId: args.orgId,
    userId: args.userId,
    message: args.message,
    clientMessageId: `onboarding:${args.threadId}`,
  });
}

function onboardingInitialMessageFailureResponse(
  result: InitialUserMessageResult,
): Response | null {
  if (result.status !== 'accepted') {
    const status = chatStartFailureStatus(result.status, result.error);
    const log =
      status >= 500
        ? console.error
        : status === 402
          ? console.info
          : console.warn;
    log('Failed to start onboarding message:', result.error);
    return Response.json(
      {
        error:
          result.error ||
          'Failed to start your onboarding chat. Please try again.',
        ...chatBillingActionPayload(status),
      },
      { status },
    );
  }
  return null;
}

async function readAccessChoice(request: Request): Promise<OnboardingAccessChoice> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return null;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }

  if (!body || typeof body !== 'object') {
    return null;
  }
  const accessChoice = (body as { accessChoice?: unknown }).accessChoice;
  return accessChoice === 'byok' ||
    accessChoice === 'existing'
    ? accessChoice
    : null;
}

async function hasUserThreadsAcrossOrgs(
  authEnv: ReturnType<typeof getAuthEnv>,
  authContext: AuthContext,
): Promise<boolean> {
  const orgIds = Array.from(
    new Set([
      authContext.currentOrg.id,
      ...authContext.orgs.map((membership) => membership.org_id),
    ]),
  );

  const results = await Promise.all(
    orgIds.map(async (orgId) => {
      const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
      const result = await orgStub.getThreadsPaginated(
        0,
        1,
        undefined,
        authContext.user.id,
      );
      return result.total > 0 || result.items.length > 0;
    }),
  );

  return results.some(Boolean);
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const accessChoice = await readAccessChoice(request);

  const workspaceId = authContext.currentWorkspace?.id;
  if (!workspaceId) {
    return Response.json({ error: 'No workspace selected' }, { status: 400 });
  }

  const userStub = authEnv.USER.get(
    authEnv.USER.idFromName(authContext.user.id)
  );
  const verificationStatus = await userStub.getEmailVerificationStatus();
  if (verificationStatus.required && !verificationStatus.verified) {
    return Response.json(
      { error: 'Please verify your email before completing onboarding.' },
      { status: 403 }
    );
  }

  // Read the sales prompt stored on the UserDO during signup.
  const salesPrompt = await userStub.getPendingSalesPrompt();
  const orgStub = authEnv.ORG.get(
    authEnv.ORG.idFromName(authContext.currentOrg.id),
  );
  const [orgInfo, llmProviderConfig] = await Promise.all([
    orgStub.getInfo(),
    orgStub.getLlmProviderConfig(),
  ]);
  const effectiveLlmProviderConfig = getEffectiveLlmProviderConfig(
    env,
    llmProviderConfig,
  );
  let onboardingModel: LlmModel | undefined;

  if (accessChoice === 'byok' && !effectiveLlmProviderConfig) {
    return Response.json(
      { error: 'Add an API key before continuing with your own provider.' },
      { status: 400 },
    );
  }

  const billingAccess = resolveOrgBillingAccess({
    env,
    org: orgInfo,
    llmProviderConfig: effectiveLlmProviderConfig,
  });

  if (!isOrgBillingAccessReady(billingAccess)) {
    return Response.json(
      { error: 'Choose a billing option before continuing.' },
      { status: 402 },
    );
  }

  let hasExistingUserThreads = false;
  try {
    hasExistingUserThreads = await hasUserThreadsAcrossOrgs(
      authEnv,
      authContext,
    );
  } catch (error) {
    console.error('Failed to verify prior user threads for onboarding:', error);
    return Response.json(
      { error: 'Failed to verify your onboarding status. Please try again.' },
      { status: 503 },
    );
  }

  if (hasExistingUserThreads) {
    if (!authContext.onboarding?.completed_at) {
      await userStub.updateOnboarding({ completed_at: Date.now() });
    }
    if (salesPrompt) {
      await userStub.clearPendingSalesPrompt();
    }

    return Response.json({
      success: true,
      redirectTo: '/chat',
    });
  }

  const firstName = authContext.user.name?.trim().split(/\s+/)[0] || 'Your';
  const onboardingThreadTitle = `${firstName}'s first chat`;

  if (authContext.onboarding?.completed_at) {
    // Already completed — find or recreate the onboarding thread.
    let existingThread: Awaited<ReturnType<typeof chatDO.getThreadsPaginated>>['items'][number] | null = null;
    try {
      const { items } = await chatDO.getThreadsPaginated(context, workspaceId, {
        offset: 0,
        limit: 100,
      }, {
        orgId: authContext.currentOrg.id,
      });
      existingThread =
        items.find(
          (thread) =>
            thread.created_by === authContext.user.id &&
            thread.title === onboardingThreadTitle
        ) ?? null;
    } catch (error) {
      console.error('Failed to look up existing onboarding thread:', error);
      return Response.json(
        { error: 'Failed to recover your onboarding chat. Please try again.' },
        { status: 503 }
      );
    }

    if (existingThread) {
      const onboardingSystemMessage = getOnboardingSystemMessage(salesPrompt);
      const onboardingInitialMessage = buildOnboardingInitialMessage(
        onboardingSystemMessage,
        salesPrompt,
      );
      const initialMessageResult = await startOnboardingInitialMessage({
        env,
        threadId: existingThread.id,
        workspaceId,
        orgId: authContext.currentOrg.id,
        userId: authContext.user.id,
        message: onboardingInitialMessage,
      });
      const failureResponse = onboardingInitialMessageFailureResponse(
        initialMessageResult,
      );
      if (failureResponse) return failureResponse;
      if (salesPrompt) {
        await userStub.clearPendingSalesPrompt();
        waitUntil(
          chatDO.generateThreadTitle(context, existingThread.id, workspaceId, salesPrompt)
        );
      }
      return Response.json({
        success: true,
        threadId: existingThread.id,
        salesPrompt,
        redirectTo: `/chat/${existingThread.id}?newThread=1`,
        showBootModal: true,
      });
    }

    const recoveryThread = await chatDO.createThread(
      context,
      workspaceId,
      onboardingThreadTitle,
      authContext.user.id,
      salesPrompt ?? undefined,
      onboardingModel,
    );

    const onboardingSystemMessage = getOnboardingSystemMessage(salesPrompt);
    const onboardingInitialMessage = buildOnboardingInitialMessage(
      onboardingSystemMessage,
      salesPrompt,
    );
    const initialMessageResult = await startOnboardingInitialMessage({
      env,
      threadId: recoveryThread.id,
      workspaceId,
      orgId: authContext.currentOrg.id,
      userId: authContext.user.id,
      message: onboardingInitialMessage,
    });
    const failureResponse = onboardingInitialMessageFailureResponse(
      initialMessageResult,
    );
    if (failureResponse) {
      await chatDO.deleteThread(context, recoveryThread.id, workspaceId, {
        orgId: authContext.currentOrg.id,
      }).catch(() => {});
      return failureResponse;
    }
    if (salesPrompt) {
      await userStub.clearPendingSalesPrompt();
      waitUntil(
        chatDO.generateThreadTitle(context, recoveryThread.id, workspaceId, salesPrompt)
      );
    }

    return Response.json({
      success: true,
      threadId: recoveryThread.id,
      salesPrompt,
      redirectTo: `/chat/${recoveryThread.id}?newThread=1`,
      showBootModal: true,
    });
  }

  const thread = await chatDO.createThread(
    context,
    workspaceId,
    onboardingThreadTitle,
    authContext.user.id,
    salesPrompt ?? undefined,
    onboardingModel,
  );

  const onboardingSystemMessage = getOnboardingSystemMessage(salesPrompt);
  const onboardingInitialMessage = buildOnboardingInitialMessage(
    onboardingSystemMessage,
    salesPrompt,
  );
  const initialMessageResult = await startOnboardingInitialMessage({
    env,
    threadId: thread.id,
    workspaceId,
    orgId: authContext.currentOrg.id,
    userId: authContext.user.id,
    message: onboardingInitialMessage,
  });
  const failureResponse = onboardingInitialMessageFailureResponse(
    initialMessageResult,
  );
  if (failureResponse) {
    await chatDO.deleteThread(context, thread.id, workspaceId, {
      orgId: authContext.currentOrg.id,
    }).catch(() => {});
    return failureResponse;
  }

  await userStub.updateOnboarding({ completed_at: Date.now() });

  if (salesPrompt) {
    await userStub.clearPendingSalesPrompt();
    waitUntil(
      chatDO.generateThreadTitle(context, thread.id, workspaceId, salesPrompt)
    );
  }

  return Response.json({
    success: true,
    threadId: thread.id,
    salesPrompt,
    redirectTo: `/chat/${thread.id}?newThread=1`,
    showBootModal: true,
  });
}
