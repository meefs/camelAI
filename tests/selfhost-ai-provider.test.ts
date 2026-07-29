import { describe, expect, it } from "vitest";
import {
  getSelfhostAiProviderCredentials,
  getSelfhostAiProviderStatus,
} from "@/lib/selfhost-ai-provider";

describe("self-host AI provider configuration", () => {
  it("requires a Bedrock API key instead of accepting a nonfunctional IAM sentinel", () => {
    const env = {
      CF_ACCOUNT_ID: "selfhost",
      SELFHOST_AI_PROVIDER: "bedrock",
      SELFHOST_AI_AWS_REGION: "us-west-2",
    };

    expect(getSelfhostAiProviderStatus(env)).toMatchObject({
      configured: true,
      valid: false,
      provider: "bedrock",
      message:
        "SELFHOST_AI_API_KEY is required for the configured self-host AI provider.",
    });
    expect(() => getSelfhostAiProviderCredentials(env)).toThrow(
      "SELFHOST_AI_API_KEY is required",
    );
  });

  it("returns key-backed Bedrock credentials with the configured region", () => {
    const env = {
      CF_ACCOUNT_ID: "selfhost",
      SELFHOST_AI_PROVIDER: "bedrock",
      SELFHOST_AI_API_KEY: "bedrock-test-token",
      SELFHOST_AI_AWS_REGION: "us-west-2",
    };

    expect(getSelfhostAiProviderCredentials(env)).toEqual({
      provider: "bedrock",
      apiKey: "bedrock-test-token",
      awsRegion: "us-west-2",
    });
  });
});
