import {
  defaultOrgModelPickerConfig,
  defaultWorkspaceModelPickerConfig,
} from "../../../src/lib/model-picker-config.js";
import {
  getStoredCustomLlmProviderApi,
  getStoredCustomLlmProviderModelId,
  type LlmProviderConfigRecord,
} from "../../../src/lib/llm-provider-config.js";
import type {
  OrgModelPickerConfig,
  WorkspaceModelPickerConfig,
} from "../../../src/types.js";

interface OrgModelPickerConfigReader {
  getModelPickerConfig(): Promise<OrgModelPickerConfig> | OrgModelPickerConfig;
  getLlmProviderConfig?:
    | (() => Promise<Pick<LlmProviderConfigRecord, "provider" | "config"> | null>)
    | (() => Pick<LlmProviderConfigRecord, "provider" | "config"> | null);
}

interface WorkspaceModelPickerConfigReader {
  getModelPickerConfig():
    | Promise<WorkspaceModelPickerConfig>
    | WorkspaceModelPickerConfig;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isMissingModelPickerConfigRpcError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("getmodelpickerconfig") &&
    (message.includes("no such rpc method") ||
      message.includes("no such method") ||
      message.includes("not a function"))
  );
}

export async function getOrgModelPickerConfigCompat(
  orgStub: OrgModelPickerConfigReader,
): Promise<OrgModelPickerConfig> {
  let providerConfig: Pick<LlmProviderConfigRecord, "provider" | "config"> | null | undefined;
  try {
    providerConfig = await orgStub.getLlmProviderConfig?.();
  } catch {
    providerConfig = null;
  }
  const customApi = getStoredCustomLlmProviderApi(providerConfig);
  const customModelId = getStoredCustomLlmProviderModelId(providerConfig);
  try {
    return await orgStub.getModelPickerConfig();
  } catch (error) {
    if (isMissingModelPickerConfigRpcError(error)) {
      return defaultOrgModelPickerConfig(providerConfig?.provider, {
        customApi,
        customModelId,
      });
    }
    throw error;
  }
}

export async function getWorkspaceModelPickerConfigCompat(
  workspaceStub: WorkspaceModelPickerConfigReader,
): Promise<WorkspaceModelPickerConfig> {
  try {
    return await workspaceStub.getModelPickerConfig();
  } catch (error) {
    if (isMissingModelPickerConfigRpcError(error)) {
      return defaultWorkspaceModelPickerConfig();
    }
    throw error;
  }
}
