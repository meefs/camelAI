import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  streamText,
  createUIMessageStream,
  createUIMessageStreamResponse,
  convertToModelMessages,
  stepCountIs,
  type StreamTextOnFinishCallback,
  type ToolSet,
  // tool,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
// import { z } from "zod";
// import { DynamicWorkerExecutor } from "@cloudflare/codemode";
// import { createCodeTool } from "@cloudflare/codemode/ai";

/**
 * Chat Agent Durable Object using Cloudflare Agents SDK.
 *
 * ## Features
 * - **Automatic conversation persistence**: Messages stored in SQLite via `this.messages`
 * - **Resumable streaming**: Reconnections continue from where they left off
 * - **WebSocket real-time communication**: Low-latency bidirectional messaging
 *
 * ## Conversation Continuity
 * The SDK automatically handles conversation history:
 *
 * 1. When a user sends a message, it's added to `this.messages`
 * 2. `convertToModelMessages(this.messages)` converts ALL messages to model format
 * 3. The full conversation history is passed to the AI on every request
 * 4. This allows the AI to maintain context across the entire conversation
 *
 * The messages array includes both user and assistant messages, so the AI
 * sees the complete back-and-forth of the conversation.
 *
 * ## Usage from React
 * ```tsx
 * // IMPORTANT: useAgent uses `name` (not `id`) to identify instances
 * // Generate sessionId server-side in your loader to avoid re-render issues
 * const agent = useAgent({ agent: "Chat", name: sessionId });
 * const { messages, sendMessage } = useAgentChat({ agent });
 * ```
 */
export class Chat extends AIChatAgent<Env> {
  /**
   * Called when a new message is received from the user.
   *
   * At this point, `this.messages` contains the FULL conversation history
   * including all previous user and assistant messages, plus the new user message.
   */
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: { abortSignal?: AbortSignal }
  ): Promise<Response> {
    const workersai = createWorkersAI({ binding: this.env.AI });

    /* --- Codemode (recommended for agents with tools) ---
    const myTools = {
      getWeather: tool({
        description: "Get weather for a city",
        parameters: z.object({ city: z.string() }),
        outputSchema: z.object({ city: z.string(), temperature: z.number() }),
        execute: async ({ city }) => ({ city, temperature: 72 }),
      }),
    };
    const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
    const codeTool = createCodeTool({ tools: myTools, executor });
    */

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const result = streamText({
          model: workersai("auto", {}),
          // Pass the FULL conversation history to maintain context
          // This includes all user messages and all previous AI responses
          messages: await convertToModelMessages(this.messages),
          system: "You are a helpful AI assistant.",
          // tools: { codemode: codeTool },
          // stopWhen: stepCountIs(100),
          onFinish,
          abortSignal: options?.abortSignal,
        });
        writer.merge(result.toUIMessageStream());
      },
    });

    return createUIMessageStreamResponse({ stream });
  }
}
