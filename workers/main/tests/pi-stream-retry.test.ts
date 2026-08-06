import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createPiProviderStreamErrorMessage,
  isBedrockRegionUnavailableError,
  streamPiModelWithTransientRetry,
} from "../src/chat-thread/pi-stream-retry";

const model = {
  id: "openai.gpt-5.6-terra",
  provider: "custom",
  api: "openai-responses",
  baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
} as any;

function errorStream(message: string) {
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: "error",
    reason: "error",
    error: createPiProviderStreamErrorMessage(model, message, "error"),
  });
  stream.end();
  return stream;
}

function successStream() {
  const stream = createAssistantMessageEventStream();
  const message = createPiProviderStreamErrorMessage(model, "", "error");
  message.stopReason = "stop";
  delete message.errorMessage;
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: "stop", message });
  stream.end();
  return stream;
}

describe("Pi provider stream regional retry", () => {
  it("retries a Bedrock model-not-found error before forwarding output", async () => {
    const createStream = vi
      .fn()
      .mockImplementationOnce(() =>
        errorStream(
          '404 {"error":{"type":"not_found_error","message":"The model does not exist"}}',
        ),
      )
      .mockImplementationOnce(successStream);
    const onRetry = vi.fn();
    const output = streamPiModelWithTransientRetry(
      model,
      {},
      createStream,
      vi.fn(),
      {
        isRetryableError: isBedrockRegionUnavailableError,
        onRetry,
      },
    );

    const events = [];
    for await (const event of output) events.push(event);

    expect(createStream).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
  });

  it("does not retry an authentication error", async () => {
    const createStream = vi.fn(() => errorStream("401 authentication_error"));
    const output = streamPiModelWithTransientRetry(
      model,
      {},
      createStream,
      vi.fn(),
      { isRetryableError: isBedrockRegionUnavailableError },
    );

    const events = [];
    for await (const event of output) events.push(event);

    expect(createStream).toHaveBeenCalledOnce();
    expect(events.map((event) => event.type)).toEqual(["error"]);
  });
});
