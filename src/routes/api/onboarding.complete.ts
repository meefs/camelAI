import type { Route } from './+types/onboarding.complete';
import { getAuthEnv, requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as chatDO from '@/lib/chat-do.server';
import { waitUntil } from '@/lib/wait-until';

const ONBOARDING_SYSTEM_MESSAGE = `This user just signed up and landed in their first chat. This is their very
first interaction with camelAI.

Welcome them briefly (1-2 sentences), then immediately use AskUserQuestion
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

const SALES_SITE_ONBOARDING_SYSTEM_MESSAGE = `This user just signed up from the camelAI sales site where they typed a
starter prompt. This is their very first interaction with camelAI.

Welcome them briefly (1 sentence max), then start working on their request
immediately. They already told you what they want, so skip the standard
onboarding preference questions and dive into the work.

If you need clarification, ask focused follow-up questions inline as you go.
Do not use AskUserQuestion for onboarding in this case.`;

function getOnboardingSystemMessage(salesPrompt: string | null): string {
  return salesPrompt ? SALES_SITE_ONBOARDING_SYSTEM_MESSAGE : ONBOARDING_SYSTEM_MESSAGE;
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

  const firstName = authContext.user.name?.trim().split(/\s+/)[0] || 'Your';
  const onboardingThreadTitle = `${firstName}'s first chat`;
  const onboardingSystemMessage = getOnboardingSystemMessage(salesPrompt);

  if (authContext.onboarding?.completed_at) {
    // Already completed — find or recreate the onboarding thread.
    let existingThread: Awaited<ReturnType<typeof chatDO.getThreadsPaginated>>['items'][number] | null = null;
    try {
      const { items } = await chatDO.getThreadsPaginated(context, workspaceId, {
        offset: 0,
        limit: 100,
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
      if (salesPrompt) {
        await userStub.clearPendingSalesPrompt();
        waitUntil(
          chatDO.generateThreadTitle(context, existingThread.id, workspaceId, salesPrompt)
        );
      }
      return Response.json({
        success: true,
        threadId: existingThread.id,
        onboardingSystemMessage,
        salesPrompt,
        redirectTo: `/chat/${existingThread.id}?newThread=1`,
      });
    }

    const recoveryThread = await chatDO.createThread(
      context,
      workspaceId,
      onboardingThreadTitle,
      authContext.user.id,
      salesPrompt ?? undefined
    );

    if (salesPrompt) {
      await userStub.clearPendingSalesPrompt();
      waitUntil(
        chatDO.generateThreadTitle(context, recoveryThread.id, workspaceId, salesPrompt)
      );
    }

    return Response.json({
      success: true,
      threadId: recoveryThread.id,
      onboardingSystemMessage,
      salesPrompt,
      redirectTo: `/chat/${recoveryThread.id}?newThread=1`,
    });
  }

  await userStub.updateOnboarding({ completed_at: Date.now() });

  const thread = await chatDO.createThread(
    context,
    workspaceId,
    onboardingThreadTitle,
    authContext.user.id,
    salesPrompt ?? undefined
  );

  if (salesPrompt) {
    await userStub.clearPendingSalesPrompt();
    waitUntil(
      chatDO.generateThreadTitle(context, thread.id, workspaceId, salesPrompt)
    );
  }

  return Response.json({
    success: true,
    threadId: thread.id,
    onboardingSystemMessage: getOnboardingSystemMessage(salesPrompt),
    salesPrompt,
    redirectTo: `/chat/${thread.id}?newThread=1`,
  });
}
