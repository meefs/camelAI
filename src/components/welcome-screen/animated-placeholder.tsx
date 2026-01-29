'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

export const PLACEHOLDER_PROMPTS = [
  'Build me a waitlist page that collects emails...',
  'Create an API that processes CSV files...',
  'Make a dashboard to track my metrics...',
  'Set up a webhook that posts to Slack when...',
  'Build a form that saves to my database...',
  'Create a landing page for my product...',
  'Make an internal tool to manage users...',
  'Build a simple CRM for my business...',
  
  // Specific SaaS replacements
  'Make an NPS survey that triggers after signup...',
  'Build a booking page that checks my calendar...',
  'Create an invoice generator that pulls from Stripe...',
  'Make a changelog page I can update easily...',
  
  // Data-forward (camelAI heritage)
  'Show me which customers churned last month...',
  'Build a report combining Stripe and PostHog data...',
  'Create a dashboard for my Snowflake metrics...',
  
  // Delightfully specific
  'Make a "link in bio" page with click tracking...',
  'Build a bug report form for my team...',
  'Create a status page for my API...',
  'Make a simple poll I can share on Twitter...',
  
  // Shows the "just ask" magic
  'Help me figure out why signups dropped...',
  'I need to send a personalized email to 50 users...',
  'Can you connect to my Postgres and show me...',
];

const TYPING_SPEED = 50;
const ERASE_SPEED = 25;
const DISPLAY_DURATION = 2000;
const PAUSE_BETWEEN = 500;

type AnimationState = 'typing' | 'displaying' | 'erasing' | 'paused';

interface UseAnimatedPlaceholderOptions {
  isActive: boolean;
  prompts?: string[];
}

function shuffleArray(items: string[]) {
  const list = [...items];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function ensureNoAdjacentDuplicates(items: string[]) {
  const list = [...items];
  for (let i = 1; i < list.length; i += 1) {
    if (list[i] !== list[i - 1]) continue;
    const swapIndex = list.findIndex((item, idx) => idx > i && item !== list[i - 1]);
    if (swapIndex !== -1) {
      [list[i], list[swapIndex]] = [list[swapIndex], list[i]];
    }
  }
  if (list.length > 1 && list[0] === list[list.length - 1]) {
    const swapIndex = list.findIndex((item, idx) => idx > 0 && idx < list.length - 1 && item !== list[0]);
    if (swapIndex !== -1) {
      [list[list.length - 1], list[swapIndex]] = [list[swapIndex], list[list.length - 1]];
    }
  }
  return list;
}

function buildSequence(prompts: string[]) {
  if (prompts.length <= 1) return [...prompts];
  const shuffled = ensureNoAdjacentDuplicates(shuffleArray(prompts));
  const startIndex = Math.floor(Math.random() * shuffled.length);
  const rotated = startIndex
    ? [...shuffled.slice(startIndex), ...shuffled.slice(0, startIndex)]
    : shuffled;
  return ensureNoAdjacentDuplicates(rotated);
}

function useAnimatedPlaceholder({ isActive, prompts = PLACEHOLDER_PROMPTS }: UseAnimatedPlaceholderOptions) {
  const [sequence, setSequence] = useState(() => buildSequence(prompts));
  const [text, setText] = useState('');
  const [state, setState] = useState<AnimationState>('typing');
  const [promptIndex, setPromptIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);

  useEffect(() => {
    setSequence(buildSequence(prompts));
    setText('');
    setState('typing');
    setPromptIndex(0);
    setCharIndex(0);
  }, [prompts]);

  useEffect(() => {
    if (!isActive) {
      setText('');
      setState('typing');
      setPromptIndex(0);
      setCharIndex(0);
      return;
    }

    const list = sequence;
    if (!list.length) return;

    const currentPrompt = list[promptIndex % list.length];

    let delay = TYPING_SPEED;
    if (state === 'displaying') delay = DISPLAY_DURATION;
    if (state === 'erasing') delay = ERASE_SPEED;
    if (state === 'paused') delay = PAUSE_BETWEEN;

    const timeout = window.setTimeout(() => {
      if (state === 'typing') {
        const nextIndex = charIndex + 1;
        setText(currentPrompt.slice(0, nextIndex));
        if (nextIndex >= currentPrompt.length) {
          setCharIndex(nextIndex);
          setState('displaying');
        } else {
          setCharIndex(nextIndex);
        }
        return;
      }

      if (state === 'displaying') {
        setState('erasing');
        return;
      }

      if (state === 'erasing') {
        const nextIndex = charIndex - 1;
        const clampedIndex = Math.max(0, nextIndex);
        setText(currentPrompt.slice(0, clampedIndex));
        if (clampedIndex <= 0) {
          setState('paused');
        } else {
          setCharIndex(clampedIndex);
        }
        return;
      }

      if (state === 'paused') {
        setPromptIndex((index) => (index + 1) % list.length);
        setCharIndex(0);
        setState('typing');
      }
    }, delay);

    return () => window.clearTimeout(timeout);
  }, [isActive, state, promptIndex, charIndex, sequence]);

  return text;
}

interface AnimatedPlaceholderProps {
  isActive: boolean;
  prompts?: string[];
  children: (text: string) => ReactNode;
}

export function AnimatedPlaceholder({ isActive, prompts, children }: AnimatedPlaceholderProps) {
  const text = useAnimatedPlaceholder({ isActive, prompts });
  return <>{children(text)}</>;
}
