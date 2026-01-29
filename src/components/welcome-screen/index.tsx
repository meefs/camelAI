'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorkerScriptWithCreator, Integration } from '@/types';
import type { Attachment } from '@/components/attachment-list';
import { PromptInput } from '@/components/prompt-input';
import { AnimatedPlaceholder } from './animated-placeholder';
import { WelcomeGreeting } from './welcome-greeting';
import { SectionHeader } from './section-header';
import { StarterPrompts, type StarterPromptItem } from './starter-prompts';
import { IntegrationButtons } from './integration-buttons';
import { ConnectedTools } from './connected-tools';
import { AppCardsRow } from './app-cards-row';

const STARTER_PROMPTS: StarterPromptItem[] = [
  {
    title: 'Feedback form + dashboard',
    description: 'Collect responses and see live results',
    prompt: 'Build me a feedback form with a simple admin dashboard to view all submissions in real-time',
    icon: 'BarChart3',
  },
  {
    title: 'Internal admin panel',
    description: 'View and edit customer records',
    prompt: 'Create an internal admin panel where I can view, search, and edit customer data',
    icon: 'Shield',
  },
  {
    title: 'Booking page',
    description: 'Calendar sync + auto confirmations',
    prompt: 'Build a booking page where visitors can schedule appointments and receive confirmation emails',
    icon: 'Calendar',
  },
  {
    title: 'Webhook to Slack alerts',
    description: 'Stripe events to formatted messages',
    prompt: 'Set up a webhook endpoint that receives Stripe events and posts formatted notifications to a Slack channel',
    icon: 'Zap',
  },
];

const EXTENDED_PROMPTS: StarterPromptItem[] = [
  {
    title: 'Personal portfolio site',
    description: 'Showcase your work beautifully',
    prompt: 'Build me a personal portfolio website with sections for my projects, about me, and contact information',
    icon: 'User',
  },
  {
    title: 'Email newsletter signup',
    description: 'Grow your audience',
    prompt: 'Create a newsletter signup landing page with email validation and a thank you confirmation',
    icon: 'Mail',
  },
  {
    title: 'API documentation site',
    description: 'Interactive docs for your API',
    prompt: 'Build an API documentation page with interactive examples and code snippets',
    icon: 'FileCode',
  },
  {
    title: 'File upload portal',
    description: 'Secure file sharing',
    prompt: 'Create a secure file upload portal where users can submit documents',
    icon: 'Upload',
  },
];

function pickRandomPrompts(allPrompts: StarterPromptItem[], count: number) {
  const copy = [...allPrompts];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

interface WelcomeScreenProps {
  userId: string | null;
  userName: string | null;
  allApps: WorkerScriptWithCreator[];
  connections: Integration[];
  hostname?: string;
  renderedAt?: number;
  onPromptChange: (prompt: string) => void;
  onSubmit: () => void;
  onStartChatForApp: (app: WorkerScriptWithCreator) => void;
  inputValue: string;
  attachments: Attachment[];
  onFilesSelected: (files: File[]) => void;
  onAttachmentRemove: (id: string) => void;
  isCreatingThread: boolean;
}

export function WelcomeScreen({
  userId,
  userName,
  allApps,
  connections,
  renderedAt,
  onPromptChange,
  onSubmit,
  onStartChatForApp,
  inputValue,
  attachments,
  onFilesSelected,
  onAttachmentRemove,
  isCreatingThread,
}: WelcomeScreenProps) {
  const [hasInteracted, setHasInteracted] = useState(false);
  const [referenceTime] = useState(() => renderedAt ?? Date.now());

  useEffect(() => {
    if (inputValue.trim()) {
      setHasInteracted(true);
    }
  }, [inputValue]);

  const handleInputFocus = useCallback(() => {
    setHasInteracted(true);
  }, []);

  const userApps = useMemo(() => {
    if (!userId) return [];
    return allApps.filter((app) => app.created_by === userId);
  }, [allApps, userId]);

  const teamApps = useMemo(() => {
    if (!userId) return allApps;
    return allApps.filter((app) => app.created_by !== userId);
  }, [allApps, userId]);

  const hasUserApps = userApps.length > 0;
  const hasTeamApps = teamApps.length > 0;
  const hasConnections = connections.length > 0;

  const showUserAppsSection = hasUserApps;
  const showTeamAppsSection = !hasUserApps && hasTeamApps;
  const showStarterPrompts = !hasUserApps;
  const showYourConnections = hasConnections;
  const showConnectSuggestions = !hasConnections;

  const promptsToDisplay = useMemo(
    () => pickRandomPrompts([...STARTER_PROMPTS, ...EXTENDED_PROMPTS], 4),
    []
  );

  const shouldAnimatePlaceholder = !hasInteracted && !inputValue.trim();
  const handlePromptSelect = useCallback((item: StarterPromptItem) => {
    setHasInteracted(true);
    onPromptChange(item.prompt);
  }, [onPromptChange]);

  const handleConnectionSelect = useCallback((connection: Integration) => {
    setHasInteracted(true);
    onPromptChange(`Use my ${connection.name || connection.integration_type} connection to create `);
  }, [onPromptChange]);

  const handleIntegrationSelect = useCallback((integration: { type: string; displayName: string }) => {
    setHasInteracted(true);
    onPromptChange(`Let's connect ${integration.displayName}`);
  }, [onPromptChange]);

  return (
    <div className="w-full max-w-5xl space-y-10">
      <WelcomeGreeting userName={userName} />

      <AnimatedPlaceholder isActive={shouldAnimatePlaceholder}>
        {(animatedText) => (
          <PromptInput
            value={inputValue}
            onChange={onPromptChange}
            onSubmit={onSubmit}
            placeholder="Ask anything..."
            animatedPlaceholder={shouldAnimatePlaceholder ? animatedText : undefined}
            isLoading={isCreatingThread}
            minHeight="80px"
            attachments={attachments}
            onFilesSelected={onFilesSelected}
            onAttachmentRemove={onAttachmentRemove}
            onFocus={handleInputFocus}
          />
        )}
      </AnimatedPlaceholder>

      {showStarterPrompts && (
        <section className="space-y-4">
          <SectionHeader title="Need inspiration? Try one of these" />
          <StarterPrompts
            prompts={promptsToDisplay}
            onSelect={handlePromptSelect}
          />
        </section>
      )}

      {showUserAppsSection && (
        <section className="space-y-4">
          <SectionHeader title="Pick up where you left off" linkHref="/apps" />
          <AppCardsRow
            apps={userApps.slice(0, 4)}
            renderedAt={referenceTime}
            onStartChat={onStartChatForApp}
          />
        </section>
      )}

      {showTeamAppsSection && (
        <section className="space-y-4">
          <SectionHeader title="What your team is working on" linkHref="/apps" />
          <AppCardsRow
            apps={teamApps.slice(0, 4)}
            renderedAt={referenceTime}
            onStartChat={onStartChatForApp}
          />
        </section>
      )}

      {showYourConnections && (
        <section className="space-y-4">
          <SectionHeader title="Your connected tools" linkHref="/connections" />
          <ConnectedTools
            connections={connections}
            onSelect={handleConnectionSelect}
          />
        </section>
      )}

      {showConnectSuggestions && (
        <section className="space-y-4">
          <SectionHeader title="Connect your tools" linkHref="/connections" />
          <IntegrationButtons
            onSelect={handleIntegrationSelect}
          />
        </section>
      )}
    </div>
  );
}
