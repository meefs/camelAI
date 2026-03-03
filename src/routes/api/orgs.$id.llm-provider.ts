import type { Route } from './+types/orgs.$id.llm-provider';
import { requireOrgAdmin, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { encryptCredentials, decryptCredentials } from '@/lib/integration-crypto';
import type { LlmProvider, LlmProviderConfigPublic } from '@/types';

const VALID_PROVIDERS: LlmProvider[] = ['anthropic', 'bedrock'];

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

function keyHint(key: string): string {
  if (key.length <= 8) return key.slice(0, 4) + '...';
  return key.slice(0, 8) + '...';
}

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

  const config = JSON.parse(record.config) as Record<string, unknown>;

  // Decrypt to get key hint only
  let hint = '********';
  try {
    const creds = await decryptCredentials<Record<string, string>>(
      record.credentials_encrypted,
      env.INTEGRATION_SECRET_KEY
    );
    const primaryKey =
      record.provider === 'anthropic'
        ? creds.api_key
        : creds.bearer_token;
    if (primaryKey) {
      hint = keyHint(primaryKey);
    }
  } catch {
    // If decryption fails, show generic hint
  }

  const publicConfig: LlmProviderConfigPublic = {
    provider: record.provider as LlmProvider,
    config: { aws_region: config.aws_region as string | undefined },
    key_hint: hint,
    created_by: record.created_by,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };

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

    if (provider === 'anthropic') {
      const apiKey = (body.api_key as string)?.trim();
      if (!apiKey) {
        return Response.json({ error: 'API key is required' }, { status: 400 });
      }
      if (!apiKey.startsWith('sk-ant-')) {
        return Response.json(
          { error: 'Invalid Anthropic API key format. Keys should start with sk-ant-' },
          { status: 400 }
        );
      }

      const encrypted = await encryptCredentials({ api_key: apiKey }, env.INTEGRATION_SECRET_KEY);
      const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
      await orgStub.setLlmProviderConfig(provider, encrypted, '{}', authContext.user.id);

      return Response.json({ success: true, key_hint: keyHint(apiKey) });
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

      const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
      const config = JSON.stringify({ aws_region: awsRegion });

      if (bearerToken) {
        // New key provided — encrypt and save
        const encrypted = await encryptCredentials(
          { bearer_token: bearerToken },
          env.INTEGRATION_SECRET_KEY
        );
        await orgStub.setLlmProviderConfig(provider, encrypted, config, authContext.user.id);
        return Response.json({ success: true, key_hint: keyHint(bearerToken) });
      }

      // No new key — update region only if already configured as Bedrock
      const existing = await orgStub.getLlmProviderConfig();
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
      return Response.json({ success: true });
    }

    return Response.json({ error: 'Unsupported provider' }, { status: 400 });
  }

  if (intent === 'deleteProvider') {
    const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
    await orgStub.deleteLlmProviderConfig();
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
      const config = JSON.parse(record.config) as Record<string, unknown>;

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
        const region = (config.aws_region as string) || 'us-east-1';
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
