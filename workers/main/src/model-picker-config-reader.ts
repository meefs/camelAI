import { retryTransientDurableObjectRead } from "../../../src/lib/do-rpc-retry.server.js";
import type {
  OrgModelPickerConfig,
  WorkspaceModelPickerConfig,
} from "../../../src/types.js";

interface OrgModelPickerConfigReader {
  getModelPickerConfig(): Promise<OrgModelPickerConfig> | OrgModelPickerConfig;
}

interface WorkspaceModelPickerConfigReader {
  getModelPickerConfig():
    | Promise<WorkspaceModelPickerConfig>
    | WorkspaceModelPickerConfig;
}

export async function readOrgModelPickerConfig(
  orgStub: OrgModelPickerConfigReader,
): Promise<OrgModelPickerConfig> {
  return retryTransientDurableObjectRead("OrgDO.getModelPickerConfig", () =>
    Promise.resolve(orgStub.getModelPickerConfig()),
  );
}

export async function readWorkspaceModelPickerConfig(
  workspaceStub: WorkspaceModelPickerConfigReader,
): Promise<WorkspaceModelPickerConfig> {
  return retryTransientDurableObjectRead(
    "WorkspaceDO.getModelPickerConfig",
    () => Promise.resolve(workspaceStub.getModelPickerConfig()),
  );
}
