import type { Route } from './+types/onboarding';
import { getAuthEnv, requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import type { OnboardingPreferences } from '@/types';

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
    // Completion is only allowed through POST /api/onboarding/complete.
    completed_at: null,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const payload = normalizeOnboardingInput(body);
  const userStub = authEnv.USER.get(
    authEnv.USER.idFromName(authContext.user.id)
  );
  const onboarding = await userStub.updateOnboarding(payload);

  return Response.json({
    success: true,
    onboarding,
  });
}
