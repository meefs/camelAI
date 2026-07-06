// Pure Pi model/provider mapping helpers (OpenRouter / Bedrock / custom
// provider model-id and header derivation) extracted from chat-thread-do.ts.
// Stateless: grouped as a class so the verbatim methods keep calling each other
// via `this`. The stateful resolution orchestrators (resolvePiModel,
// resolvePiRequestConfig, getCachedLlmProviderConfig, resolveCurrentByokCredentials)
// remain on ChatThreadDO and call into a PiModelMapping instance.
import { bedrockProviderModule } from "./pi-bedrock-provider";
import type { Model } from "@earendil-works/pi-ai";
import { DEFAULT_LLM_MODEL, normalizeLlmModel } from "../../../src/lib/llm-provider-config";
import type { PiHeaderValue, PiResolvedModelReference } from "./chat-thread-do";

export class PiModelMapping {
  resolvePiModelReference(modelId: string): PiResolvedModelReference {
    const normalizedModelId = this.normalizePiModelId(modelId);
    const claudeReference = (resolvedModelId: string): PiResolvedModelReference => ({
      provider: "anthropic",
      modelId: resolvedModelId,
      hostedGatewayProvider: "openrouter",
      hostedModelId: this.openRouterNitroModel(this.openRouterClaudeModel(resolvedModelId)),
    });
    const openRouterReference = (resolvedModelId: string): PiResolvedModelReference => ({
      provider: "openrouter",
      modelId: resolvedModelId,
      hostedGatewayProvider: "openrouter",
      hostedModelId: this.openRouterNitroModel(resolvedModelId),
    });
    const openRouterResponsesReference = (resolvedModelId: string): PiResolvedModelReference => ({
      ...openRouterReference(resolvedModelId),
      api: "openai-responses",
    });
    const openAiReference = (resolvedModelId: string): PiResolvedModelReference => ({
      provider: "openai",
      modelId: resolvedModelId,
      hostedGatewayProvider: "openrouter",
      hostedModelId: this.openRouterNitroModel(`openai/${resolvedModelId}`),
    });
    switch (normalizedModelId) {
      case "haiku":
        return claudeReference("claude-haiku-4-5-20251001");
      case "opus":
      case "opus-4.7":
      case "opus-4.8":
        return claudeReference("claude-opus-4-8");
      case "sonnet":
        return claudeReference("claude-sonnet-4-6");
      case "gpt-5.4-mini":
      case "gpt-5.4":
      case "gpt-5.5":
        return openAiReference(normalizedModelId);
      case "custom":
        return openAiReference("gpt-5.4");
      case "kimi-k2.7-code":
        return openRouterReference("moonshotai/kimi-k2.7-code");
      case "grok-4.3":
        return openRouterResponsesReference("x-ai/grok-4.3");
      case "glm-5.2":
        return openRouterReference("z-ai/glm-5.2");
      case "gemini-3.5-flash":
        return openRouterReference("google/gemini-3.5-flash");
      case "gemini-3-flash-preview":
        return openRouterReference("google/gemini-3-flash-preview");
      case "gemini-3.1-pro-preview":
        return openRouterReference("google/gemini-3.5-flash");
      case "deepseek-v4-pro":
        // Hosted traffic goes through the AI Gateway dynamic route so Gateway
        // can try Azure first and fall back to OpenRouter; BYOK OpenRouter uses
        // the native OpenRouter Pro id from `modelId`.
        return {
          ...openRouterReference("deepseek/deepseek-v4-pro"),
          hostedGatewayProvider: "compat",
          hostedModelId: "dynamic/deepseek-v4-pro-fallback",
          hostedReasoningEffort: "xhigh",
        };
      case "deepseek-v4-auto":
        // Hosted traffic goes through the AI Gateway dynamic route (provider
        // fallbacks are configured on the gateway); BYOK OpenRouter uses Pro.
        return {
          ...openRouterReference("deepseek/deepseek-v4-pro"),
          hostedGatewayProvider: "compat",
          hostedModelId: "dynamic/deepseek-v4-auto",
          hostedReasoningEffort: "xhigh",
        };
      case "deepseek-v4-flash":
        return openRouterReference("deepseek/deepseek-v4-flash");
      default:
        if (normalizedModelId.includes("/")) {
          return openRouterReference(normalizedModelId);
        }
        return openAiReference("gpt-5.5");
    }
  }

  normalizePiModelId(modelId: string): string {
    const trimmed = modelId.trim();
    const normalized = trimmed;
    const lower = normalized.toLowerCase();
    if (lower === "fable-5" || lower === "claude-fable-5") {
      return "sonnet";
    }
    if (
      lower === "kimi-k2.6" ||
      lower === "kimi-latest" ||
      lower === "~moonshotai/kimi-latest" ||
      lower === "moonshotai/kimi-latest" ||
      lower === "moonshotai/kimi-k2.6"
    ) {
      return "kimi-k2.7-code";
    }
    return normalized;
  }

  openRouterAttributionHeaders(): Record<string, string> {
    return {
      "HTTP-Referer": "https://camelai.dev",
      "X-OpenRouter-Title": "camelAI",
      "X-OpenRouter-Categories": "cloud-agent,programming-app",
    };
  }

  customProviderAuthHeaders(
    api: "openai-completions" | "openai-responses" | "anthropic-messages",
    authType: "bearer" | "x-api-key",
    apiKey: string,
  ): Record<string, PiHeaderValue> | undefined {
    if (api === "anthropic-messages") {
      return authType === "bearer"
        ? { "x-api-key": null, Authorization: `Bearer ${apiKey}` }
        : undefined;
    }

    return authType === "x-api-key"
      ? { Authorization: null, "x-api-key": apiKey }
      : undefined;
  }

  resolveCustomProviderModelReference(
    api: "openai-completions" | "openai-responses" | "anthropic-messages",
    requestedModelId: string,
    customModelId: string | undefined,
  ): { provider: string; lookupModelId: string; requestModelId: string } {
    const model = normalizeLlmModel(this.normalizePiModelId(requestedModelId), "custom", {
      customApi: api,
      customModelId,
    });
    if (model === "custom" && customModelId?.trim()) {
      const lookupModel =
        api === "anthropic-messages" ? DEFAULT_LLM_MODEL : "gpt-5.4";
      const lookupReference = this.resolvePiModelReference(lookupModel);
      return {
        provider: lookupReference.provider,
        lookupModelId: lookupReference.modelId,
        requestModelId: customModelId.trim(),
      };
    }
    const reference = this.resolvePiModelReference(model);
    return {
      provider: reference.provider,
      lookupModelId: reference.modelId,
      requestModelId: reference.modelId,
    };
  }

  openRouterClaudeModel(model: string): string {
    switch (model.trim().toLowerCase()) {
      case "sonnet":
        return "anthropic/claude-sonnet-4.6";
      case "haiku":
        return "anthropic/claude-haiku-4.5";
      case "opus":
      case "opus-4.7":
      case "opus-4.8":
      case "claude-opus-4-8":
      case "claude-opus-4.8":
      case "claude-opus-4-7":
      case "claude-opus-4.7":
      case "claude-opus-4-6":
      case "claude-opus-4.6":
        return "anthropic/claude-opus-4.8";
      case "claude-sonnet-4-6":
        return "anthropic/claude-sonnet-4.6";
      case "claude-sonnet-4-5-20250929":
        return "anthropic/claude-sonnet-4.5";
      case "claude-haiku-4-5-20251001":
        return "anthropic/claude-haiku-4.5";
      case "claude-opus-4-5-20251101":
        return "anthropic/claude-opus-4.5";
      case "claude-sonnet-4-20250514":
        return "anthropic/claude-sonnet-4";
      case "claude-opus-4-20250514":
        return "anthropic/claude-opus-4";
      case "claude-3-7-sonnet-20250219":
        return "anthropic/claude-3.7-sonnet";
      case "claude-3-5-sonnet-20241022":
      case "claude-3-5-sonnet-20240620":
        return "anthropic/claude-3.5-sonnet";
      case "claude-3-5-haiku-20241022":
        return "anthropic/claude-3.5-haiku";
      default:
        return model;
    }
  }

  openRouterNitroModel(model: string): string {
    const trimmed = model.trim();
    if (!trimmed) return model;
    const lower = trimmed.toLowerCase();
    if (
      lower.startsWith("dynamic/") ||
      lower.startsWith("google/gemini-") ||
      lower.startsWith("deepseek/deepseek-v4-") ||
      lower.startsWith("anthropic/claude-opus-4.") ||
      lower.endsWith(":nitro")
    ) {
      return trimmed;
    }
    const lastSegment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
    if (lastSegment.includes(":")) {
      return trimmed;
    }
    return `${trimmed}:nitro`;
  }

  bedrockClaudeModel(modelId: string): string {
    switch (modelId) {
      case "claude-haiku-4-5-20251001":
        return "global.anthropic.claude-haiku-4-5-20251001-v1:0";
      case "claude-opus-4-8":
        return "global.anthropic.claude-opus-4-8";
      case "claude-opus-4-6":
      case "claude-opus-4-7":
        return "global.anthropic.claude-opus-4-8";
      case "claude-sonnet-4-6":
      default:
        return "global.anthropic.claude-sonnet-4-6";
    }
  }

  bedrockRuntimeBaseUrl(region: string | undefined): string | undefined {
    const normalized = region?.trim();
    if (!normalized) return undefined;
    if (!/^[a-z0-9-]+$/.test(normalized)) return undefined;
    return `https://bedrock-runtime.${normalized}.amazonaws.com`;
  }

  bedrockOpenAiModelConfig(
    modelId: string,
    region: string | undefined,
  ): { modelId: string; baseUrl: string } | null {
    const normalizedModel = modelId.trim().toLowerCase();
    const supportedRegionsByModel: Record<string, readonly string[]> = {
      "gpt-5.5": ["us-east-1", "us-east-2"],
      "gpt-5.4": ["us-east-1", "us-east-2", "us-west-2", "us-gov-west-1"],
    };
    const supportedRegions = supportedRegionsByModel[normalizedModel];
    if (!supportedRegions) return null;

    const normalizedRegion = region?.trim() || "us-east-1";
    if (!/^[a-z0-9-]+$/.test(normalizedRegion)) {
      throw new Error(`Invalid Bedrock AWS region: ${normalizedRegion}`);
    }
    if (!supportedRegions.includes(normalizedRegion)) {
      throw new Error(
        `OpenAI ${modelId} on Amazon Bedrock is not available in ${normalizedRegion}. Supported regions: ${supportedRegions.join(", ")}.`,
      );
    }

    return {
      modelId: `openai.${normalizedModel}`,
      baseUrl: `https://bedrock-mantle.${normalizedRegion}.api.aws/openai/v1`,
    };
  }

  buildBedrockByokOptions(
    model: Model<any>,
    options: Parameters<typeof import("@earendil-works/pi-ai").streamSimple>[2],
  ): Parameters<typeof bedrockProviderModule.streamBedrock>[2] {
    return {
      ...options,
      bearerToken: options?.apiKey,
      maxTokens:
        options?.maxTokens ??
        (typeof model.maxTokens === "number" && model.maxTokens > 0
          ? Math.min(model.maxTokens, 32000)
          : undefined),
    } as Parameters<typeof bedrockProviderModule.streamBedrock>[2];
  }
}
