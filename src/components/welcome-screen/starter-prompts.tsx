'use client';

import { BarChart3, Shield, Calendar, Zap, User, Mail, FileCode, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

export interface StarterPromptItem {
  title: string;
  description: string;
  prompt: string;
  icon: 'BarChart3' | 'Shield' | 'Calendar' | 'Zap' | 'User' | 'Mail' | 'FileCode' | 'Upload';
}

interface StarterPromptsProps {
  prompts: StarterPromptItem[];
  onSelect: (prompt: StarterPromptItem) => void;
}

const ICONS: Record<StarterPromptItem['icon'], LucideIcon> = {
  BarChart3,
  Shield,
  Calendar,
  Zap,
  User,
  Mail,
  FileCode,
  Upload,
};

export function StarterPrompts({ prompts, onSelect }: StarterPromptsProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {prompts.map((item) => {
        const Icon = ICONS[item.icon];
        return (
          <button
            key={item.title}
            type="button"
            onClick={() => onSelect(item)}
            className={cn(
              'group relative flex flex-col gap-2 p-4 rounded-xl',
              'border border-border bg-card hover:bg-accent/50',
              'text-left transition-all duration-200',
              'hover:shadow-md hover:-translate-y-0.5'
            )}
          >
            <div className="flex items-center gap-2">
              <Icon className="size-5 text-muted-foreground group-hover:text-foreground" />
              <span className="font-semibold text-foreground">{item.title}</span>
            </div>
            <p className="text-sm text-muted-foreground">{item.description}</p>
          </button>
        );
      })}
    </div>
  );
}
