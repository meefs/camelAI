const AUXILIARY_MODEL_ALIASES = {
  "@cf/meta/llama-3.2-3b-instruct": "openai.gpt-5.6-terra",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": "openai.gpt-5.6-terra",
};

const BEDROCK_OPENAI_MODEL_REGIONS = {
  "openai.gpt-5.6-sol": ["us-east-1", "us-east-2"],
  "openai.gpt-5.6-terra": ["us-east-1", "us-east-2", "us-west-2"],
};

function bedrockRegionCandidates(model, preferredRegion) {
  const supported = BEDROCK_OPENAI_MODEL_REGIONS[model] ?? [
    preferredRegion,
    "us-east-1",
    "us-east-2",
    "us-west-2",
  ];
  return [
    ...(supported.includes(preferredRegion) ? [preferredRegion] : []),
    ...supported.filter((region) => region !== preferredRegion),
  ];
}

function isBedrockRegionUnavailableError(message) {
  const lower = message.toLowerCase();
  return (
    lower.includes("not_found_error") ||
    lower.includes("model not found") ||
    (lower.includes("model") && lower.includes("does not exist")) ||
    (lower.includes("model") && lower.includes("not available in")) ||
    (lower.includes("model") && lower.includes("unsupported region"))
  );
}

function resolveBedrockModelId(model) {
  const trimmed = String(model || "").trim();
  if (!trimmed) {
    throw new Error("Self-host AI binding requires a model id");
  }
  return AUXILIARY_MODEL_ALIASES[trimmed] ?? trimmed;
}

class SelfhostAiBinding {
  constructor(env) {
    this.provider = String(env.provider || "").trim().toLowerCase();
    this.apiKey = String(env.apiKey || "").trim();
    this.awsRegion = String(env.awsRegion || "us-east-1").trim();
  }

  async run(model, inputs) {
    if (this.provider !== "bedrock") {
      throw new Error(
        `Self-host AI binding only supports bedrock auxiliary generation (provider=${this.provider || "unset"})`,
      );
    }
    if (!this.apiKey) {
      throw new Error("SELFHOST_AI_API_KEY is required for self-host AI binding");
    }
    if (!Array.isArray(inputs?.messages) || inputs.messages.length === 0) {
      throw new Error(`Self-host AI binding does not support model ${model} without chat messages`);
    }

    const bedrockModel = resolveBedrockModelId(model);
    const regions = bedrockRegionCandidates(bedrockModel, this.awsRegion);
    let payload;
    for (const [index, region] of regions.entries()) {
      const baseUrl = `https://bedrock-mantle.${region}.api.aws/openai/v1`;
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: bedrockModel,
          input: inputs.messages,
          ...(typeof inputs.max_tokens === "number"
            ? { max_output_tokens: inputs.max_tokens }
            : {}),
        }),
      });

      const bodyText = await response.text();
      if (!response.ok) {
        if (
          index < regions.length - 1 &&
          isBedrockRegionUnavailableError(bodyText)
        ) {
          continue;
        }
        throw new Error(bodyText || `Self-host AI request failed (${response.status})`);
      }

      try {
        payload = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        throw new Error("Self-host AI returned invalid JSON");
      }
      break;
    }

    if (!payload) {
      throw new Error("Self-host AI request failed in all supported Bedrock regions");
    }

    const outputText =
      (typeof payload.output_text === "string" && payload.output_text.trim()) ||
      payload.output
        ?.flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
        .find((item) => item?.type === "output_text" && typeof item.text === "string")
        ?.text?.trim();
    return outputText ? { response: outputText } : payload;
  }
}

export default function makeBinding(env) {
  return new SelfhostAiBinding(env);
}
