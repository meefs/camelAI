/** OpenAI chat/completions compatibility surface for Bedrock Mantle via pi-ai. */
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import type { PiBedrockCall } from "./bedrock-pi-contracts.js";
import { buildBedrockPiModel } from "./bedrock-pi-model.js";
import {
  piEventStreamToSSE,
  piMessageToChatCompletion,
} from "./bedrock-pi-output.js";

export class BedrockPiCompletionError extends Error {
  constructor(
    message: string,
    readonly completion: AssistantMessage,
  ) {
    super(message);
    this.name = "BedrockPiCompletionError";
  }
}

export type { PiBedrockCall } from "./bedrock-pi-contracts.js";
export { chatCompletionToPiCall } from "./bedrock-pi-input.js";
export { buildBedrockPiModel } from "./bedrock-pi-model.js";
export {
  piEventStreamToSSE,
  piMessageToChatCompletion,
} from "./bedrock-pi-output.js";

export async function runBedrockViaPi(args: {
  call: PiBedrockCall;
  modelId: string;
  bearerToken: string;
  region?: string;
}): Promise<unknown> {
  const eventStream = streamSimple(
    buildBedrockPiModel(args.modelId, args.region),
    args.call.context,
    {
      apiKey: args.bearerToken,
      toolChoice: args.call.toolChoice,
      maxTokens: args.call.maxTokens,
      temperature: args.call.temperature,
    },
  );
  if (args.call.stream) return piEventStreamToSSE(eventStream, args.modelId);
  const completion = await eventStream.result();
  if (completion.stopReason === "error" || completion.stopReason === "aborted") {
    throw new BedrockPiCompletionError(
      completion.errorMessage ||
        (completion.stopReason === "error"
          ? "Bedrock request failed"
          : "Bedrock request was aborted"),
      completion,
    );
  }
  return piMessageToChatCompletion(completion, args.modelId);
}
