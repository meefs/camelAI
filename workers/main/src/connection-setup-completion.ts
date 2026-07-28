import type { ConnectionSetupResponse } from "./chat-thread-browser-prompts.js";

interface ConnectionSetupChatThreadRpc {
  receiveConnectionSetupResponse(
    response: ConnectionSetupResponse,
  ): Promise<{ accepted: boolean }>;
}

interface ConnectionSetupCompletionEnv {
  CHAT_THREAD: DurableObjectNamespace;
}

export async function completeConnectionSetupPromptContext(
  env: ConnectionSetupCompletionEnv,
  context: { requestId: string; threadId: string },
  integrationId: string,
  integrationType: string,
  integrationName: string,
): Promise<boolean> {
  try {
    const chatThreadStub = env.CHAT_THREAD.get(
      env.CHAT_THREAD.idFromName(context.threadId),
    ) as unknown as ConnectionSetupChatThreadRpc;
    const response: ConnectionSetupResponse = {
      requestId: context.requestId,
      cancelled: false,
      integration: {
        type: integrationType,
        name: integrationName,
        config: {},
        credentials: { _oauth_completed: true, integration_id: integrationId },
      },
    };
    const result = await chatThreadStub.receiveConnectionSetupResponse(response);
    return result.accepted;
  } catch (error) {
    console.error(
      "[Integration OAuth] Failed to complete chat connection setup request:",
      error,
    );
    return false;
  }
}
