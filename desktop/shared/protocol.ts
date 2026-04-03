import type { ContentBlock } from "../../src/types";

export type DesktopModel = "sonnet" | "opus";

export interface DesktopThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastMessagePreview: string | null;
}

export interface DesktopMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
  createdAt: number;
  status: "done" | "streaming" | "error";
  isMeta?: boolean;
  sourceToolUseID?: string;
}

export interface DesktopVmStatus {
  state: "unavailable" | "stopped" | "starting" | "running" | "error";
  detail: string;
  helperPath: string | null;
  prepared?: boolean;
  vmDirectory?: string | null;
  diskPath?: string | null;
  instanceName?: string | null;
  localProxyPort?: number | null;
  guestIPAddress?: string | null;
}

export interface DesktopSnapshot {
  threads: DesktopThread[];
  messagesByThread: Record<string, DesktopMessage[]>;
  activeThreadId: string | null;
  model: string;
  hasClaudeAuth: boolean;
  authSource: "claude-ai" | "api-key" | "missing";
  vmStatus: DesktopVmStatus;
}

export interface DesktopStartupDiagnostic {
  at: number;
  stage: string;
  detail?: string;
}

export type DesktopClientEvent =
  | {
      type: "create_thread";
      title?: string;
    }
  | {
      type: "send_message";
      threadId: string;
      content: string;
    }
  | {
      type: "set_model";
      model: DesktopModel;
    }
  | {
      type: "ping";
    };

export type DesktopServerEvent =
  | {
      type: "snapshot";
      snapshot: DesktopSnapshot;
    }
  | {
      type: "diagnostic";
      diagnostic: DesktopStartupDiagnostic;
    }
  | {
      type: "assistant_delta";
      threadId: string;
      messageId: string;
      delta: string;
    }
  | {
      type: "sdk_event";
      threadId: string;
      event: unknown;
    }
  | {
      type: "error";
      message: string;
      threadId?: string;
    }
  | {
      type: "pong";
      now: number;
    };
