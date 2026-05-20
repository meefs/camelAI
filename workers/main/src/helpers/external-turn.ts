import type { Env } from '../types.js';
import type {
  ExternalMessageRequest,
  ExternalTurnResult,
} from '../chat-thread-do.js';

type ExternalMessageRpc = {
  externalMessage: (body: ExternalMessageRequest) => Promise<ExternalTurnResult>;
};
type ExternalMessageEnv = Pick<Env, 'CHAT_THREAD'>;

function getExternalMessageRpc(
  env: ExternalMessageEnv,
  threadId: string,
): ExternalMessageRpc {
  return env.CHAT_THREAD.get(
    env.CHAT_THREAD.idFromName(threadId),
  ) as unknown as ExternalMessageRpc;
}

export async function runExternalMessageTurn(
  env: ExternalMessageEnv,
  args: ExternalMessageRequest & { threadId: string }
): Promise<ExternalTurnResult> {
  const stub = getExternalMessageRpc(env, args.threadId);
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
