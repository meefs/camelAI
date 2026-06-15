import { encryptCredentials } from "../../../../src/lib/integration-crypto";
import { stringifyStoredLlmProviderConfig } from "../../../../src/lib/llm-provider-config";

export type EvalCustomModelApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

export type EvalModelEnv = {
  EVAL_MODEL?: string;
  EVAL_CUSTOM_API?: EvalCustomModelApi;
  EVAL_CUSTOM_API_KEY?: string;
  EVAL_CUSTOM_BASE_URL?: string;
  EVAL_CUSTOM_MODEL_ID?: string;
  EVAL_TIMEOUT_MS?: string;
  INTEGRATION_SECRET_KEY: string;
};

type OrgLlmConfigWriter = {
  setLlmProviderConfig(
    provider: string,
    credentialsEncrypted: string,
    config: string,
    createdBy: string,
  ): void | Promise<void>;
};

export async function configureEvalModel(
  env: EvalModelEnv,
  orgStub: OrgLlmConfigWriter,
  userId: string,
): Promise<void> {
  if (env.EVAL_MODEL !== "custom") {
    return;
  }

  if (!env.EVAL_CUSTOM_API_KEY || !env.EVAL_CUSTOM_BASE_URL) {
    throw new Error(
      "EVAL_MODEL=custom requires EVAL_CUSTOM_API_KEY and EVAL_CUSTOM_BASE_URL",
    );
  }

  const credentialsEncrypted = await encryptCredentials(
    { api_key: env.EVAL_CUSTOM_API_KEY },
    env.INTEGRATION_SECRET_KEY,
  );
  await orgStub.setLlmProviderConfig(
    "custom",
    credentialsEncrypted,
    stringifyStoredLlmProviderConfig({
      custom_base_url: env.EVAL_CUSTOM_BASE_URL,
      custom_api: env.EVAL_CUSTOM_API ?? "openai-completions",
      custom_model_id: env.EVAL_CUSTOM_MODEL_ID,
    }),
    userId,
  );
}

export function getEvalTimeoutMs(
  env: Pick<EvalModelEnv, "EVAL_TIMEOUT_MS">,
  defaultTimeoutMs: number,
): number {
  if (!env.EVAL_TIMEOUT_MS) {
    return defaultTimeoutMs;
  }

  const timeoutMs = Number(env.EVAL_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("EVAL_TIMEOUT_MS must be a positive number");
  }
  return timeoutMs;
}
