import {
  defaultOrgModelPickerConfig,
  defaultWorkspaceModelPickerConfig,
} from "../../../src/lib/model-picker-config.js";
import type {
  LlmProvider,
  OrgModelPickerConfig,
  WorkspaceModelPickerConfig,
} from "../../../src/types.js";

interface OrgModelPickerConfigReader {
  getModelPickerConfig(): Promise<OrgModelPickerConfig> | OrgModelPickerConfig;
  getLlmProviderConfig?:
    | (() => Promise<{ provider: LlmProvider | string } | null>)
    | (() => { provider: LlmProvider | string } | null);
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
  let provider: LlmProvider | string | null | undefined;
  try {
    provider = (await orgStub.getLlmProviderConfig?.())?.provider;
  } catch {
    provider = null;
  }
  try {
    return await orgStub.getModelPickerConfig();
  } catch (error) {
    if (isMissingModelPickerConfigRpcError(error)) {
      return defaultOrgModelPickerConfig(provider);
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
