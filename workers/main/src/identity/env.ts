import type { UserDO } from "./user-do";
import type { OrgDO } from "./org-do";
import type { WorkspaceDO } from "../workspace";
import type { ChatThreadDO } from "../chat-thread-do";

// Environment bindings needed by identity Durable Objects
export interface DOEnv {
  USER: DurableObjectNamespace<UserDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  APP_DB?: D1Database;
  OBSERVABILITY_EVENTS?: AnalyticsEngineDataset;
  ERROR_ANALYTICS?: AnalyticsEngineDataset;
  EMAIL_TO_USER: KVNamespace;
  APP_KV: KVNamespace;
}
