'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { PreviewTarget } from '@/types';

interface ChatPreviewContextValue {
  openPreviewTarget: (target: PreviewTarget) => void;
  clearPreviewTarget: () => void;
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
  return useContext(ChatPreviewContext);
}
