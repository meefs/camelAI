import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import { stringifyStoredLlmProviderConfig } from '../../../src/lib/llm-provider-config';
import { createThread } from '../../../src/lib/chat-do.server';
import { WorkspaceContainer } from '../src/workspace-container';
import type { TestEnv } from './test-helpers';
import { createOrg, createUser } from './test-helpers';

function buildContext(testEnv: TestEnv) {
  return {
    cloudflare: {
      env: testEnv,
    },
  };
}

describe('web Codex provider wiring', () => {
  const testEnv = env as unknown as TestEnv;

  const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  it('keeps new web threads on the Codex harness when the org provider is OpenAI', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Codex User');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Codex Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const encrypted = await encryptCredentials(
      { api_key: 'sk-test-openai-1234567890' },
      testEnv.INTEGRATION_SECRET_KEY ?? 'test-secret'
    );
    await orgStub.setLlmProviderConfig(
      'openai',
      encrypted,
      stringifyStoredLlmProviderConfig({}),
      userId
    );
    const thread = await createThread(
      buildContext(testEnv) as never,
      defaultWorkspaceId,
      'Codex thread',
      userId,
      'Reply with pong'
    );

    expect(thread.provider).toBe('codex');
  });

  it('creates standard proxy web threads on Claude and still allows explicit Codex', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Proxy Codex User');
    const { defaultWorkspaceId } = await createOrg(testEnv, 'Proxy Codex Org', userId);

    const thread = await createThread(
      buildContext(testEnv) as never,
      defaultWorkspaceId,
      'Proxy Codex thread',
      userId,
      'Reply with pong'
    );

    expect(thread.provider).toBe('claude');
    expect(thread.model).toBe('sonnet');
    const codexThread = await createThread(
      buildContext(testEnv) as never,
      defaultWorkspaceId,
      'Explicit Codex thread',
      userId,
      'Reply with pong',
      'gpt-5.5'
    );

    expect(codexThread.provider).toBe('codex');
    expect(codexThread.model).toBe('gpt-5.5');
  });

  it('does not require the proxy model-access flag for Claude defaults', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Claude Proxy User');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Claude Proxy Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    await orgStub.setExperimentalSettings({ claude_proxy_models: true });

    const thread = await createThread(
      buildContext(testEnv) as never,
      defaultWorkspaceId,
      'Claude default thread',
      userId,
      'Reply with pong'
    );

    expect(thread.provider).toBe('claude');
    expect(thread.model).toBe('sonnet');
  });

  it('does not pass OpenAI BYOK through runner env or runner state', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Codex User');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Codex Env Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const encrypted = await encryptCredentials(
      { api_key: 'sk-test-openai-abcdef' },
      testEnv.INTEGRATION_SECRET_KEY ?? 'test-secret'
    );
    await orgStub.setLlmProviderConfig(
      'openai',
      encrypted,
      stringifyStoredLlmProviderConfig({}),
      userId
    );

    const thread = await orgStub.createThread(defaultWorkspaceId, 'Codex env thread', userId);

    const container = new WorkspaceContainer(testEnv as never, defaultWorkspaceId, org.id);
    (container as any).fetchIntegrationEnvVars = async () => ({});
    (container as any).createAppAccessSession = async () => ({});
    (container as any).writeIntegrationEnvFileToSandbox = async () => true;

    const runnerEnv = await container.buildChatRunnerEnv({
      threadId: thread.id,
      provider: 'codex',
    });

    expect(runnerEnv.envVars.CHIRIDION_CHAT_PROVIDER).toBe('codex');
    expect(runnerEnv.envVars.OPENAI_API_KEY).toBeUndefined();
    expect('byokProxy' in runnerEnv).toBe(false);
  });

  it('allows OpenRouter orgs to create Claude threads without passing BYOK through runner state', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'OpenRouter Claude User');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'OpenRouter Claude Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const encrypted = await encryptCredentials(
      { api_key: 'sk-or-test-openrouter-abcdef' },
      testEnv.INTEGRATION_SECRET_KEY ?? 'test-secret'
    );
    await orgStub.setLlmProviderConfig(
      'openrouter',
      encrypted,
      stringifyStoredLlmProviderConfig({}),
      userId
    );

    const thread = await createThread(
      buildContext(testEnv) as never,
      defaultWorkspaceId,
      'OpenRouter Claude thread',
      userId,
      'Reply with pong',
      'sonnet'
    );

    expect(thread.provider).toBe('claude');
    expect(thread.model).toBe('sonnet');

    const container = new WorkspaceContainer(testEnv as never, defaultWorkspaceId, org.id);
    (container as any).fetchIntegrationEnvVars = async () => ({});
    (container as any).createAppAccessSession = async () => ({});
    (container as any).writeIntegrationEnvFileToSandbox = async () => true;

    const runnerEnv = await container.buildChatRunnerEnv({
      threadId: thread.id,
      provider: 'claude',
    });

    expect(runnerEnv.envVars.CHIRIDION_CHAT_PROVIDER).toBe('claude');
    expect('byokProxy' in runnerEnv).toBe(false);
  });
});
