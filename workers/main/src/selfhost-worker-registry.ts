export const SELFHOST_WORKER_PREFIX = "selfhost:worker:";

export interface SelfhostWorkerModule {
  name: string;
  type: "js" | "text" | "data" | "json" | "wasm";
  content: string;
}

export interface SelfhostWorkerRecord {
  schemaVersion: 1;
  appId: string;
  scriptName: string;
  dispatchScriptName: string;
  orgId: string;
  orgSlug: string;
  workspaceId: string;
  version: string;
  createdAt: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  mainModule: string;
  modules: Record<string, SelfhostWorkerModule>;
  bindings: Array<Record<string, unknown>>;
}

export function selfhostWorkerKey(dispatchScriptName: string): string {
  return `${SELFHOST_WORKER_PREFIX}${dispatchScriptName}`;
}
