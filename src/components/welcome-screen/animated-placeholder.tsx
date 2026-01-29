'use client';

import { useEffect, useRef, useState } from 'react';
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

function useAnimatedPlaceholder({ isActive, prompts = PLACEHOLDER_PROMPTS }: UseAnimatedPlaceholderOptions) {
  const [text, setText] = useState('');
  const [state, setState] = useState<AnimationState>('typing');
  const [promptIndex, setPromptIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);
  const promptsRef = useRef(prompts);

  useEffect(() => {
    promptsRef.current = prompts;
  }, [prompts]);

  useEffect(() => {
    if (!isActive) {
      setText('');
      setState('typing');
      setPromptIndex(0);
      setCharIndex(0);
      return;
    }

    const list = promptsRef.current;
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
  }, [isActive, state, promptIndex, charIndex]);

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
