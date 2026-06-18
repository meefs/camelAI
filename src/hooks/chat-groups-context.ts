import { createContext } from "react";
import type { ChatGroupView } from "@/types";

export interface ChatGroupsContextValue {
  groups: ChatGroupView[];
  activeGroupId: string | null;
  runningThreadIds: Set<string>;
  hasStatusSnapshot: boolean;
  isLoading: boolean;
  markThreadIdle: (threadId: string) => void;
}

export const ChatGroupsContext = createContext<ChatGroupsContextValue | null>(null);
