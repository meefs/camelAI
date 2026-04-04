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

  it('creates new web threads on the codex harness when the org provider is OpenAI', async () => {
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

  it('builds codex runner env with the OpenAI BYOK proxy when the org uses OpenAI', async () => {
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
    expect(runnerEnv.byokProxy).toEqual({
      provider: 'openai',
      apiKey: 'sk-test-openai-abcdef',
    });
  });
});
