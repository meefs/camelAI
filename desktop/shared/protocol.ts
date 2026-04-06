import type { ContentBlock } from "../../src/types";

export type DesktopProvider = "claude" | "codex" | "agentos";
export type DesktopModel = string;
export type DesktopAuthSource = "provider-account" | "api-key" | "missing";

export interface DesktopProviderOption {
  id: DesktopProvider;
  label: string;
}

export interface DesktopModelOption {
  id: DesktopModel;
  label: string;
  provider: DesktopProvider;
}

export interface DesktopAuthState {
  provider: DesktopProvider;
  available: boolean;
  source: DesktopAuthSource;
  label: string;
}

export interface DesktopThread {
  id: string;
  provider: DesktopProvider;
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

export interface DesktopRuntimeStatus {
  state: "unavailable" | "stopped" | "starting" | "running" | "error";
  detail: string;
  helperPath: string | null;
  prepared?: boolean;
  runtimeDirectory?: string | null;
  containerID?: string | null;
  controlPlaneAddress?: string | null;
  controlPlanePort?: number | null;
  imageReference?: string | null;
}

export interface DesktopSnapshot {
  threads: DesktopThread[];
  messagesByThread: Record<string, DesktopMessage[]>;
  activeThreadId: string | null;
  provider: DesktopProvider;
  availableProviders: DesktopProviderOption[];
  model: DesktopModel;
  availableModels: DesktopModelOption[];
  auth: DesktopAuthState;
  runtimeStatus: DesktopRuntimeStatus;
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
      type: "select_thread";
      threadId: string;
    }
  | {
      type: "send_message";
      threadId: string;
      content: string;
    }
  | {
      type: "set_provider";
      provider: DesktopProvider;
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
      type: "runtime_event";
      threadId: string;
      provider: DesktopProvider;
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
