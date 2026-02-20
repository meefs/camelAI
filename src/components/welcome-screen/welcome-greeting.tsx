'use client';

import { useMemo } from 'react';
import { createSeededRandom, hashStringToSeed } from './deterministic-random';

const GREETINGS_WITH_NAME = [
  'Hey, {name}',
  'Welcome back, {name}',
  'Good to see you, {name}',
  'Ready to build, {name}?',
  "Let's create something, {name}",
  "What's next, {name}?",
];

const GREETINGS_WITHOUT_NAME = [
  "Let's build something",
  'Ready to create?',
  'What will you build today?',
  "Let's get started",
  'Time to build',
];

interface WelcomeGreetingProps {
  userName: string | null;
  seed: number;
}

function getFirstName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return '';
  return trimmed.split(/\s+/)[0] ?? trimmed;
}

export function WelcomeGreeting({ userName, seed }: WelcomeGreetingProps) {
  const greeting = useMemo(() => {
    const name = userName?.trim();
    const hasName = Boolean(name);
    const pool = hasName ? GREETINGS_WITH_NAME : GREETINGS_WITHOUT_NAME;
    const random = createSeededRandom(hashStringToSeed(`${seed}:${name ?? ''}`));
    const selected = pool[Math.floor(random() * pool.length)] ?? pool[0];
    if (hasName && name) {
      return selected.replace('{name}', getFirstName(name));
    }
    return selected;
  }, [userName, seed]);

  return (
    <div className="text-center mb-8">
      <h1 className="text-3xl md:text-4xl font-serif italic text-foreground mb-2">
        {greeting}
      </h1>
      <p className="text-muted-foreground text-lg">What would you like to build?</p>
    </div>
  );
}
