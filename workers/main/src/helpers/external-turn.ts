import type { Env } from '../types.js';
import type { ExternalMessageRequest, ExternalTurnResult } from '../durable-objects.js';
import { getThreadStub } from './stubs.js';

type ExternalMessageRpc = {
  externalMessage: (body: ExternalMessageRequest) => Promise<ExternalTurnResult>;
};

export async function runExternalMessageTurn(
  env: Env,
  args: ExternalMessageRequest & { threadId: string }
): Promise<ExternalTurnResult> {
  const stub = getThreadStub(env, args.threadId) as DurableObjectStub<ExternalMessageRpc>;
  try {
    const result = await stub.externalMessage(args);
    if (result.status === 'result' || result.status === 'busy' || result.status === 'error') {
      return result;
    }
    return { status: 'error', error: 'Invalid response from chat thread' };
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Chat thread rejected message',
    };
  }
}
