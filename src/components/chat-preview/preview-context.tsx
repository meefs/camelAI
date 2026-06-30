'use client';

import { createContext, use, type ReactNode } from 'react';
import type { PreviewTarget } from '@/types';
import type { CopyFilePathTarget } from '@/lib/file-path-copy';

interface ChatPreviewContextValue {
  openPreviewTarget: (target: PreviewTarget) => void;
  clearPreviewTarget: () => void;
  resolveAppVisibility?: (scriptName: string) => Promise<boolean | null>;
  workspaceId?: string | null;
  formatFilePathForCopy?: (target: CopyFilePathTarget) => string;
}

const ChatPreviewContext = createContext<ChatPreviewContextValue | null>(null);

interface ChatPreviewProviderProps {
  value: ChatPreviewContextValue;
  children: ReactNode;
}

export function ChatPreviewProvider({ value, children }: ChatPreviewProviderProps) {
  return (
    <ChatPreviewContext.Provider value={value}>
      {children}
    </ChatPreviewContext.Provider>
  );
}

export function useChatPreviewContext(): ChatPreviewContextValue | null {
  return use(ChatPreviewContext);
}
