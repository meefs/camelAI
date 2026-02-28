import type { Route } from './+types/onboarding.complete';
import { getAuthEnv, requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as chatDO from '@/lib/chat-do.server';

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

  await userStub.updateOnboarding({ completed_at: Date.now() });

  const firstName = authContext.user.name?.trim().split(/\s+/)[0] || 'Your';
  const thread = await chatDO.createThread(
    context,
    workspaceId,
    `${firstName}'s first chat`,
    authContext.user.id
  );

  return Response.json({
    success: true,
    threadId: thread.id,
    onboardingSystemMessage: ONBOARDING_SYSTEM_MESSAGE,
    redirectTo: `/chat/${thread.id}?newThread=1`,
  });
}
