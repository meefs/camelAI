import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import { stringifyStoredLlmProviderConfig } from '../../../src/lib/llm-provider-config';
import { createThread } from '../../../src/lib/chat-do.server';
import type { TestEnv } from './test-helpers';
import { createOrg, createUser } from './test-helpers';

function buildContext(testEnv: TestEnv) {
  return {
    cloudflare: {
      env: testEnv,
    },
  };
}

describe('web model provider wiring', () => {
  const testEnv = env as unknown as TestEnv;

  const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  it('defaults new web threads to an OpenAI model when the org provider is OpenAI', async () => {
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
    expect(thread.model).toBe('gpt-5.4');
  });

  it('creates standard hosted web threads on Claude and still allows explicit OpenAI models', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Proxy Codex User');
    const { defaultWorkspaceId } = await createOrg(testEnv, 'Proxy Codex Org', userId);

    const thread = await createThread(
      buildContext(testEnv) as never,
      defaultWorkspaceId,
      'Proxy Codex thread',
      userId,
      'Reply with pong'
    );
    expect(thread.model).toBe('sonnet');
    const codexThread = await createThread(
      buildContext(testEnv) as never,
      defaultWorkspaceId,
      'Explicit Codex thread',
      userId,
      'Reply with pong',
      'gpt-5.5'
    );

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
    expect(thread.model).toBe('sonnet');
  });

});
