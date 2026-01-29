'use client';

import type { WorkerScriptWithCreator } from '@/types';
import { SlimAppCard } from './slim-app-card';

interface AppCardsRowProps {
  apps: WorkerScriptWithCreator[];
  renderedAt: number;
  onStartChat: (app: WorkerScriptWithCreator) => void;
}

export function AppCardsRow({ apps, renderedAt, onStartChat }: AppCardsRowProps) {
  return (
    <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
      {apps.map((app) => (
        <SlimAppCard
          key={app.script_name}
          app={app}
          renderedAt={renderedAt}
          onStartChat={onStartChat}
        />
      ))}
    </div>
  );
}
