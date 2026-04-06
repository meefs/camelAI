import type { Route } from './+types/orgs.$id.llm-provider';
import { requireOrgAdmin, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { encryptCredentials, decryptCredentials } from '@/lib/integration-crypto';
import {
  buildPublicLlmProviderConfig,
  getAffectedChatHarnessesForLlmProviderChange,
  parseStoredLlmProviderConfig,
  stringifyStoredLlmProviderConfig,
  keyHint,
} from '@/lib/llm-provider-config';
import { waitUntil } from '@/lib/wait-until';
import type { LlmProvider, LlmProviderConfigPublic } from '@/types';

const VALID_PROVIDERS: LlmProvider[] = ['anthropic', 'bedrock', 'openai'];
const VALID_AWS_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ap-south-1',
  'sa-east-1',
  'ca-central-1',
];

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const orgId = params.id;
  await requireOrgAdmin(request, context, orgId);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const record = await orgStub.getLlmProviderConfig();

  if (!record) {
    return Response.json({ config: null });
  }

  const publicConfig: LlmProviderConfigPublic = await buildPublicLlmProviderConfig(
    record,
    env.INTEGRATION_SECRET_KEY
  );

  return Response.json({ config: publicConfig });
}

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const orgId = params.id;
  const authContext = await requireOrgAdmin(request, context, orgId);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const intent = body.intent as string;

  if (intent === 'setProvider') {
    const provider = body.provider as string;
    if (!VALID_PROVIDERS.includes(provider as LlmProvider)) {
      return Response.json(
        { error: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(', ')}` },
        { status: 400 }
      );
    }

    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    const existing = await orgStub.getLlmProviderConfig();
    const notifyByokChanged = () => {
      const affectedHarnesses = getAffectedChatHarnessesForLlmProviderChange(
        existing?.provider,
        provider,
      );
      if (affectedHarnesses.length === 0) {
        return;
      }
      waitUntil(
        orgStub.notifyByokChanged(affectedHarnesses).catch((error: unknown) => {
          console.error('[llm-provider] Failed to notify BYOK change:', error);
        })
      );
    };

    if (provider === 'anthropic') {
      const apiKey = (body.api_key as string)?.trim();
      const config = stringifyStoredLlmProviderConfig({});

      if (apiKey && !apiKey.startsWith('sk-ant-')) {
        return Response.json(
          { error: 'Invalid Anthropic API key format. Keys should start with sk-ant-' },
          { status: 400 }
        );
      }

      if (apiKey) {
        const encrypted = await encryptCredentials({ api_key: apiKey }, env.INTEGRATION_SECRET_KEY);
        await orgStub.setLlmProviderConfig(provider, encrypted, config, authContext.user.id);
        notifyByokChanged();
        return Response.json({ success: true, key_hint: keyHint(apiKey) });
      }

      if (!existing || existing.provider !== 'anthropic') {
        return Response.json({ error: 'API key is required' }, { status: 400 });
      }

      await orgStub.setLlmProviderConfig(
        provider,
        existing.credentials_encrypted,
        config,
        authContext.user.id
      );
      notifyByokChanged();
      return Response.json({ success: true });
    }

    if (provider === 'bedrock') {
      const bearerToken = (body.bearer_token as string)?.trim();
      const awsRegion = (body.aws_region as string)?.trim();

      if (!awsRegion || !VALID_AWS_REGIONS.includes(awsRegion)) {
        return Response.json(
          { error: `Invalid AWS region. Must be one of: ${VALID_AWS_REGIONS.join(', ')}` },
          { status: 400 }
        );
      }

      const config = stringifyStoredLlmProviderConfig({ aws_region: awsRegion });

      if (bearerToken) {
        // New key provided — encrypt and save
        const encrypted = await encryptCredentials(
          { bearer_token: bearerToken },
          env.INTEGRATION_SECRET_KEY
        );
        await orgStub.setLlmProviderConfig(provider, encrypted, config, authContext.user.id);
        notifyByokChanged();
        return Response.json({ success: true, key_hint: keyHint(bearerToken) });
      }

      // No new key — update region only if already configured as Bedrock
      if (!existing || existing.provider !== 'bedrock') {
        return Response.json({ error: 'Bedrock API key is required' }, { status: 400 });
      }
      // Re-use existing encrypted credentials, update config (region)
      await orgStub.setLlmProviderConfig(
        provider,
        existing.credentials_encrypted,
        config,
        authContext.user.id
      );
      notifyByokChanged();
      return Response.json({ success: true });
    }

    if (provider === 'openai') {
      const apiKey = (body.api_key as string)?.trim();
      if (!apiKey) {
        return Response.json({ error: 'API key is required' }, { status: 400 });
      }
      if (!apiKey.startsWith('sk-')) {
        return Response.json(
          { error: 'Invalid OpenAI API key format. Keys should start with sk-' },
          { status: 400 }
        );
      }

      const encrypted = await encryptCredentials({ api_key: apiKey }, env.INTEGRATION_SECRET_KEY);
      await orgStub.setLlmProviderConfig(
        provider,
        encrypted,
        stringifyStoredLlmProviderConfig({}),
        authContext.user.id
      );
      notifyByokChanged();
      return Response.json({ success: true, key_hint: keyHint(apiKey) });
    }

    return Response.json({ error: 'Unsupported provider' }, { status: 400 });
  }

  if (intent === 'deleteProvider') {
    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    const existing = await orgStub.getLlmProviderConfig();
    await orgStub.deleteLlmProviderConfig();
    const affectedHarnesses = getAffectedChatHarnessesForLlmProviderChange(existing?.provider, null);
    if (affectedHarnesses.length === 0) {
      return Response.json({ success: true });
    }
    waitUntil(
      orgStub.notifyByokChanged(affectedHarnesses).catch((error: unknown) => {
        console.error('[llm-provider] Failed to notify BYOK change:', error);
      })
    );
    return Response.json({ success: true });
  }

  if (intent === 'testProvider') {
    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    const record = await orgStub.getLlmProviderConfig();
    if (!record) {
      return Response.json({ error: 'No provider configured' }, { status: 404 });
    }

    try {
      const creds = await decryptCredentials<Record<string, string>>(
        record.credentials_encrypted,
        env.INTEGRATION_SECRET_KEY
      );
      const config = parseStoredLlmProviderConfig(record.config);

      if (record.provider === 'anthropic') {
        // Test with a lightweight count_tokens call
        const resp = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': creds.api_key,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            messages: [{ role: 'user', content: 'test' }],
          }),
        });

        if (resp.ok) {
          return Response.json({ success: true, message: 'Anthropic API key is valid' });
        }

        const errorBody = await resp.text();
        if (resp.status === 401) {
          return Response.json(
            { success: false, message: 'Invalid API key. Please check and try again.' },
            { status: 200 }
          );
        }
        return Response.json(
          { success: false, message: `API returned ${resp.status}: ${errorBody.slice(0, 200)}` },
          { status: 200 }
        );
      }

      if (record.provider === 'bedrock') {
        // Test Bedrock API key by listing foundation models
        const region = config.aws_region || 'us-east-1';
        const resp = await fetch(
          `https://bedrock.${region}.amazonaws.com/foundation-models?byProvider=anthropic`,
          {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${creds.bearer_token}`,
            },
          }
        );

        if (resp.ok) {
          return Response.json({ success: true, message: 'Bedrock API key is valid' });
        }

        if (resp.status === 401 || resp.status === 403) {
          return Response.json(
            { success: false, message: 'Invalid Bedrock API key or insufficient permissions.' },
            { status: 200 }
          );
        }
        return Response.json(
          { success: false, message: `Bedrock API returned ${resp.status}` },
          { status: 200 }
        );
      }

      if (record.provider === 'openai') {
        const resp = await fetch('https://api.openai.com/v1/models?limit=1', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${creds.api_key}`,
          },
        });

        if (resp.ok) {
          return Response.json({ success: true, message: 'OpenAI API key is valid' });
        }

        const errorBody = await resp.text();
        if (resp.status === 401 || resp.status === 403) {
          return Response.json(
            { success: false, message: 'Invalid OpenAI API key. Please check and try again.' },
            { status: 200 }
          );
        }
        return Response.json(
          { success: false, message: `OpenAI API returned ${resp.status}: ${errorBody.slice(0, 200)}` },
          { status: 200 }
        );
      }

      return Response.json({ error: 'Unknown provider' }, { status: 400 });
    } catch (err) {
      return Response.json(
        { success: false, message: `Test failed: ${(err as Error).message}` },
        { status: 200 }
      );
    }
  }

  return Response.json({ error: 'Unknown intent' }, { status: 400 });
}
