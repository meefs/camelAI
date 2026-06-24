'use client';

import { ChatGroupAvatar } from '@/components/avatar/chat-group-avatar';
import type { GroupNewChatPayload } from '@/types';

export function GroupNewChatHeader({ group }: { group: GroupNewChatPayload }) {
  return (
    <div className="flex items-center justify-center gap-3">
      <ChatGroupAvatar
        avatar={group.avatar}
        fallbackName={group.name}
        size="lg"
      />
      <div className="min-w-0 text-left">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          New chat in
        </p>
        <h1 className="truncate text-2xl font-serif italic leading-tight text-foreground md:text-3xl">
          {group.name}
        </h1>
      </div>
    </div>
  );
}
