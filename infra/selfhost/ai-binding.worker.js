const AUXILIARY_MODEL_ALIASES = {
  "@cf/meta/llama-3.2-3b-instruct": "meta.llama3-2-3b-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": "meta.llama3-3-70b-instruct",
};

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
    const baseUrl = `https://bedrock-mantle.${this.awsRegion}.api.aws/v1`;
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: bedrockModel,
        messages: inputs.messages,
        ...(typeof inputs.max_tokens === "number" ? { max_tokens: inputs.max_tokens } : {}),
      }),
    });

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(bodyText || `Self-host AI request failed (${response.status})`);
    }

    let payload;
    try {
      payload = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      throw new Error("Self-host AI returned invalid JSON");
    }

    return payload;
  }
}

export default function makeBinding(env) {
  return new SelfhostAiBinding(env);
}
