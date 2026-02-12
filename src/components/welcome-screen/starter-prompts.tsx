'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  Bug,
  Calculator,
  Calendar,
  CalendarDays,
  Puzzle,
  Dices,
  Eye,
  FileCode,
  FileSpreadsheet,
  Globe,
  Grid3x3,
  HeartPulse,
  Link,
  ListChecks,
  Mail,
  Megaphone,
  MessageCircle,
  Receipt,
  Rocket,
  Shield,
  Ticket,
  Upload,
  User,
  Users,
  Vote,
  Zap,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

export type StarterPromptIconName =
  | 'Activity'
  | 'BarChart3'
  | 'Bug'
  | 'Calculator'
  | 'Calendar'
  | 'CalendarDays'
  | 'Puzzle'
  | 'Dices'
  | 'Eye'
  | 'FileCode'
  | 'FileSpreadsheet'
  | 'Globe'
  | 'Grid3x3'
  | 'HeartPulse'
  | 'Link'
  | 'ListChecks'
  | 'Mail'
  | 'Megaphone'
  | 'MessageCircle'
  | 'Receipt'
  | 'Rocket'
  | 'Shield'
  | 'Ticket'
  | 'Upload'
  | 'User'
  | 'Users'
  | 'Vote'
  | 'Zap';

export interface StarterPromptItem {
  title: string;
  description: string;
  prompt: string;
  icon: StarterPromptIconName;
}

interface StarterPromptsProps {
  prompts: StarterPromptItem[];
  onSelect: (prompt: StarterPromptItem) => void;
  /** Incrementing key to trigger the shuffle animation */
  shuffleKey?: number;
}

const ICONS: Record<StarterPromptIconName, LucideIcon> = {
  Activity,
  BarChart3,
  Bug,
  Calculator,
  Calendar,
  CalendarDays,
  Puzzle,
  Dices,
  Eye,
  FileCode,
  FileSpreadsheet,
  Globe,
  Grid3x3,
  HeartPulse,
  Link,
  ListChecks,
  Mail,
  Megaphone,
  MessageCircle,
  Receipt,
  Rocket,
  Shield,
  Ticket,
  Upload,
  User,
  Users,
  Vote,
  Zap,
};

const SLOT_COUNT = 4;

export function StarterPrompts({ prompts, onSelect, shuffleKey = 0 }: StarterPromptsProps) {
  const [displayed, setDisplayed] = useState(prompts);
  const [phase, setPhase] = useState<'idle' | 'out' | 'in'>('idle');
  const pendingPrompts = useRef(prompts);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return () => timers.current.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    pendingPrompts.current = prompts;

    if (shuffleKey === 0) {
      setDisplayed(prompts);
      return;
    }

    timers.current.forEach(clearTimeout);
    timers.current = [];

    // Phase 1: slide content out
    setPhase('out');

    // Phase 2: swap data + slide content in
    const swap = setTimeout(() => {
      setDisplayed(pendingPrompts.current);
      setPhase('in');

      // Phase 3: back to idle
      const idle = setTimeout(() => setPhase('idle'), 450);
      timers.current.push(idle);
    }, 220);
    timers.current.push(swap);
  }, [shuffleKey, prompts]);

  // Stable click handler that reads current displayed data
  const handleClick = useCallback(
    (index: number) => {
      onSelect(displayed[index]);
    },
    [displayed, onSelect]
  );

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {Array.from({ length: SLOT_COUNT }, (_, index) => (
        <PromptSlot
          key={index}
          index={index}
          item={displayed[index]}
          phase={phase}
          onClick={handleClick}
        />
      ))}
    </div>
  );
}

interface PromptSlotProps {
  index: number;
  item: StarterPromptItem | undefined;
  phase: 'idle' | 'out' | 'in';
  onClick: (index: number) => void;
}

// Stagger offsets per slot for a cascade feel
const OUT_DIRECTIONS = [
  { x: -4, y: -3 },
  { x: 4, y: -3 },
  { x: -4, y: 3 },
  { x: 4, y: 3 },
];

function PromptSlot({ index, item, phase, onClick }: PromptSlotProps) {
  const innerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;

    if (phase === 'out') {
      const dir = OUT_DIRECTIONS[index % OUT_DIRECTIONS.length];
      el.style.transition = `all 180ms cubic-bezier(0.4, 0, 0.7, 0.2) ${index * 35}ms`;
      el.style.opacity = '0';
      el.style.transform = `translate(${dir.x}px, ${dir.y}px) scale(0.97)`;
    } else if (phase === 'in') {
      // Start from below, then animate up
      el.style.transition = 'none';
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.style.transition = `all 300ms cubic-bezier(0.2, 0.85, 0.3, 1.06) ${index * 60}ms`;
          el.style.opacity = '1';
          el.style.transform = 'translateY(0)';
        });
      });
    } else {
      // idle — clear inline styles so hover etc. work normally
      el.style.transition = '';
      el.style.opacity = '';
      el.style.transform = '';
    }
  }, [phase, index]);

  if (!item) return null;
  const Icon = ICONS[item.icon];

  return (
    <button
      type="button"
      onClick={() => onClick(index)}
      className={cn(
        'group relative flex flex-col gap-2 p-3 rounded-xl cursor-pointer',
        'border border-border bg-card hover:bg-accent/50',
        'text-left transition-all duration-200 ease-out',
        'hover:border-ring hover:shadow-md'
      )}
    >
      <div ref={innerRef} className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground group-hover:text-foreground transition-colors" />
          <span className="font-medium text-sm text-foreground">{item.title}</span>
        </div>
        <p className="text-sm text-muted-foreground">{item.description}</p>
      </div>
    </button>
  );
}
