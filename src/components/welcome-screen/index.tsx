'use client';

import { Suspense, use, useCallback, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ChevronUp, Plus } from 'lucide-react';
import type { WorkerScriptWithCreator, Integration, LlmModel, Thread } from '@/types';
import type { Attachment } from '@/components/attachment-list';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { PromptInput } from '@/components/prompt-input';
import { ConnectionPicker } from '@/components/connection-picker';
import { GetHelpDialog } from '@/components/get-help-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { INTEGRATION_REGISTRY } from '@/lib/integration-registry';
import { IntegrationIcon } from '@/lib/integration-icons';
import { AnimatedPlaceholder } from './animated-placeholder';
import { BetaNotice } from './beta-notice';
import { createSeededRandom, hashStringToSeed } from './deterministic-random';
import { WelcomeGreeting } from './welcome-greeting';
import { SectionHeader } from './section-header';
import { StarterPrompts, type StarterPromptItem } from './starter-prompts';
import { IntegrationButtons, FEATURED_CONNECTIONS, LOGO_STACK_CONNECTIONS } from './integration-buttons';
import { ConnectedTools } from './connected-tools';
import { AppCardsRow } from './app-cards-row';
import { RecentChatsRow } from './recent-chats-row';

const STARTER_PROMPTS: StarterPromptItem[] = [
  // Strong keepers from before
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
    title: 'Webhook to Slack alerts',
    description: 'Stripe events → formatted messages',
    prompt: 'Set up a webhook endpoint that receives Stripe events and posts formatted notifications to a Slack channel',
    icon: 'Zap',
  },
  {
    title: 'Booking page',
    description: 'Let people grab time on your calendar',
    prompt: 'Build a booking page where visitors can see my availability, pick a slot, and get a calendar invite automatically',
    icon: 'Calendar',
  },
  {
    title: 'Waitlist with referrals',
    description: 'Track signups and who invited who',
    prompt: 'Create a waitlist page that gives each signup a unique referral link and shows their position in line',
    icon: 'Users',
  },
  {
    title: 'Changelog',
    description: 'Ship notes your users will actually read',
    prompt: 'Build a changelog page where I can post updates with dates, tags, and nice formatting',
    icon: 'Megaphone',
  },
  {
    title: 'Invoice generator',
    description: 'Pull from Stripe, email as PDF',
    prompt: 'Build an invoice generator that pulls customer and payment data from Stripe and lets me send branded PDF invoices',
    icon: 'Receipt',
  },
  {
    title: 'Status page',
    description: 'Show uptime, post incidents',
    prompt: 'Create a public status page for my API where I can post incidents and show current system health',
    icon: 'Activity',
  },
  {
    title: 'Team standup bot',
    description: 'Async check-ins, daily digest',
    prompt: 'Build a standup tool where my team submits daily updates and everyone gets a morning summary',
    icon: 'MessageCircle',
  },
  {
    title: 'Customer health dashboard',
    description: 'Usage signals across all your tools',
    prompt: 'Create a dashboard that pulls from Stripe, PostHog, and my database to show which customers are thriving vs at risk',
    icon: 'HeartPulse',
  },
  {
    title: 'Bug report portal',
    description: 'Intake, triage, track status',
    prompt: 'Build an internal bug reporting form that collects screenshots and details, with a board to track status',
    icon: 'Bug',
  },
  {
    title: 'Event RSVP page',
    description: 'Signups, cap, waitlist',
    prompt: 'Create an event page where people can RSVP, with a capacity limit and automatic waitlist when full',
    icon: 'Ticket',
  },
  {
    title: 'Content calendar',
    description: "Plan and track what you're shipping",
    prompt: 'Build a simple content calendar where I can plan posts, set publish dates, and mark things as done',
    icon: 'CalendarDays',
  },
  {
    title: 'Competitive intel tracker',
    description: 'Log what competitors ship',
    prompt: 'Create a simple tool where my team can log competitor updates with links, screenshots, and tags',
    icon: 'Eye',
  },
  {
    title: 'Simple poll',
    description: 'Quick vote, shareable link',
    prompt: 'Build a poll maker where I can create a question with options and share a link to collect votes',
    icon: 'Vote',
  },
  {
    title: 'Link in bio page',
    description: 'Your links + click analytics',
    prompt: 'Create a link-in-bio page where I can add links and see how many clicks each one gets',
    icon: 'Link',
  },

  // Your new additions
  {
    title: 'Chrome extension',
    description: 'Add superpowers to your browser',
    prompt: 'Build a Chrome extension that lets me save and pin anything I find on the internet to a personal collection',
    icon: 'Puzzle',
  },
  {
    title: 'Personal site',
    description: 'Your corner of the internet',
    prompt: 'Build me a personal website with my bio, work history, projects, and a way for people to get in touch',
    icon: 'Globe',
  },
  {
    title: 'Launch page',
    description: 'Build hype before you ship',
    prompt: 'Create a coming soon page for my product with a signup form, countdown timer, and social links',
    icon: 'Rocket',
  },
  {
    title: 'Report from CSV',
    description: 'Turn raw data into insights',
    prompt: 'Take this CSV and turn it into a clean report with charts, key metrics, and a summary I can share with my team',
    icon: 'FileSpreadsheet',
  },
  {
    title: 'Daily Wordle clone',
    description: 'A word game for your friends',
    prompt: 'Build a Wordle-style word guessing game with daily puzzles and a way to share my score',
    icon: 'Dices',
  },
  {
    title: 'Sudoku',
    description: 'Classic puzzle, fresh build',
    prompt: 'Create a Sudoku game with multiple difficulty levels, a timer, and the ability to check my progress',
    icon: 'Grid3x3',
  },

  // A couple more I think could hit
  {
    title: 'Meeting notes → action items',
    description: 'Paste transcript, get tasks',
    prompt: 'Build a tool where I paste meeting notes or a transcript and it extracts action items with owners and deadlines',
    icon: 'ListChecks',
  },
  {
    title: 'Price calculator',
    description: 'Interactive quote builder',
    prompt: 'Create a pricing calculator for my service where visitors can select options and see a live quote',
    icon: 'Calculator',
  },
];
function pickRandomPrompts(
  allPrompts: StarterPromptItem[],
  count: number,
  random: () => number = Math.random
) {
  const copy = [...allPrompts];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

interface WelcomeScreenProps {
  userId: string | null;
  userName: string | null;
  allApps: WorkerScriptWithCreator[] | Promise<WorkerScriptWithCreator[]>;
  connections: Integration[];
  recentThreads: Thread[] | Promise<Thread[]>;
  renderedAt?: number;
  onPromptChange: (prompt: string) => void;
  onSubmit: () => void;
  onStartChatForApp: (app: WorkerScriptWithCreator) => void;
  inputValue: string;
  attachments: Attachment[];
  onFilesSelected: (files: File[]) => void;
  onAttachmentRemove: (id: string) => void;
  isCreatingThread: boolean;
  model: LlmModel;
  onModelChange: (model: LlmModel) => void;
  modelOptions: ReadonlyArray<{
    value: LlmModel;
    label: string;
    description: string;
  }>;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T>).then === 'function';
}

function useDeferredValue<T>(value: T | Promise<T>): T {
  return isPromiseLike(value) ? use(value) : value;
}

function RecentChatsFallback() {
  return (
    <section className="space-y-4">
      <SectionHeader title="Your recent chats" linkHref="/history" />
      <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-[116px] w-[260px] shrink-0 rounded-xl" />
        ))}
      </div>
    </section>
  );
}

function AppsFallback() {
  return (
    <section className="space-y-4">
      <SectionHeader title="Continue building an app" linkHref="/apps" />
      <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="aspect-video w-[260px] shrink-0 rounded-xl" />
        ))}
      </div>
    </section>
  );
}

function DeferredRecentChatsSection({
  recentThreads,
  referenceTime,
  onOpenThread,
}: {
  recentThreads: Thread[] | Promise<Thread[]>;
  referenceTime: number;
  onOpenThread: (threadId: string) => void;
}) {
  const resolvedRecentThreads = useDeferredValue(recentThreads);
  if (resolvedRecentThreads.length === 0) return null;

  return (
    <section className="space-y-4">
      <SectionHeader title="Your recent chats" linkHref="/history" />
      <RecentChatsRow
        threads={resolvedRecentThreads.slice(0, 4)}
        renderedAt={referenceTime}
        onOpenThread={onOpenThread}
      />
    </section>
  );
}

function DeferredAppsSection({
  userId,
  allApps,
  referenceTime,
  onStartChatForApp,
}: {
  userId: string | null;
  allApps: WorkerScriptWithCreator[] | Promise<WorkerScriptWithCreator[]>;
  referenceTime: number;
  onStartChatForApp: (app: WorkerScriptWithCreator) => void;
}) {
  const resolvedApps = useDeferredValue(allApps);
  const userApps = userId
    ? resolvedApps.filter((app) => app.created_by === userId)
    : [];
  const teamApps = userId
    ? resolvedApps.filter((app) => app.created_by !== userId)
    : resolvedApps;

  if (userApps.length > 0) {
    return (
      <section className="space-y-4">
        <SectionHeader title="Continue building an app" linkHref="/apps" />
        <AppCardsRow
          apps={userApps.slice(0, 4)}
          renderedAt={referenceTime}
          onStartChat={onStartChatForApp}
        />
      </section>
    );
  }

  if (teamApps.length > 0) {
    return (
      <section className="space-y-4">
        <SectionHeader title="What your team is working on" linkHref="/apps" />
        <AppCardsRow
          apps={teamApps.slice(0, 4)}
          renderedAt={referenceTime}
          onStartChat={onStartChatForApp}
        />
      </section>
    );
  }

  return null;
}

export function WelcomeScreen({
  userId,
  userName,
  allApps,
  connections,
  recentThreads,
  renderedAt,
  onPromptChange,
  onSubmit,
  onStartChatForApp,
  inputValue,
  attachments,
  onFilesSelected,
  onAttachmentRemove,
  isCreatingThread,
  model,
  onModelChange,
  modelOptions,
}: WelcomeScreenProps) {
  const navigate = useNavigate();
  const [referenceTime] = useState(() => renderedAt ?? Date.now());
  const [helpOpen, setHelpOpen] = useState(false);
  const hasConnections = connections.length > 0;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const focusInput = useCallback(() => {
    textareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  const handleOpenThread = useCallback((threadId: string) => {
    navigate(`/chat/${threadId}`);
  }, [navigate]);
  const [addConnectionOpen, setAddConnectionOpen] = useState(false);

  const allIntegrationDefs = useMemo(
    () =>
      Object.values(INTEGRATION_REGISTRY).map((def) => ({
        type: def.type,
        displayName: def.displayName,
        category: def.category,
      })),
    []
  );

  const [shuffleKey, setShuffleKey] = useState(0);
  const initialPromptSeed = useMemo(
    () => hashStringToSeed(`starter-prompts:${referenceTime}:${userId ?? 'anonymous'}`),
    [referenceTime, userId]
  );
  const promptsToDisplay = useMemo(
    () =>
      shuffleKey === 0
        ? pickRandomPrompts(STARTER_PROMPTS, 4, createSeededRandom(initialPromptSeed))
        : pickRandomPrompts(STARTER_PROMPTS, 4),
    [initialPromptSeed, shuffleKey]
  );

  const handleShufflePrompts = useCallback(() => {
    setShuffleKey((k) => k + 1);
  }, []);

  const shouldAnimatePlaceholder = !inputValue.trim();
  const handlePromptSelect = useCallback((item: StarterPromptItem) => {
    onPromptChange(item.prompt);
    focusInput();
  }, [onPromptChange, focusInput]);

  const handleConnectionSelect = useCallback((connection: Integration) => {
    onPromptChange(`Use my ${connection.name || connection.integration_type} connection to `);
    focusInput();
  }, [onPromptChange, focusInput]);

  const handleIntegrationSelect = useCallback((integration: { type: string; displayName: string }) => {
    onPromptChange(`Let's connect ${integration.displayName}`);
    focusInput();
  }, [onPromptChange, focusInput]);

  return (
    <div className="w-full max-w-5xl space-y-10">
      <WelcomeGreeting userName={userName} seed={referenceTime} />

      <div className="-mt-6">
        <BetaNotice onFeedbackClick={() => setHelpOpen(true)} />
      </div>

      <AnimatedPlaceholder isActive={shouldAnimatePlaceholder}>
        {(animatedText) => (
          <PromptInput
            textareaRef={textareaRef}
            value={inputValue}
            onChange={onPromptChange}
            onSubmit={onSubmit}
            placeholder="Ask anything..."
            animatedPlaceholder={shouldAnimatePlaceholder ? animatedText : undefined}
            isLoading={isCreatingThread}
            minHeight="80px"
            autoFocus
            attachments={attachments}
            onFilesSelected={onFilesSelected}
            onAttachmentRemove={onAttachmentRemove}
            model={model}
            onModelChange={onModelChange}
            modelOptions={modelOptions}
            modelDisabled={isCreatingThread}
          />
        )}
      </AnimatedPlaceholder>

      <Suspense fallback={<RecentChatsFallback />}>
        <DeferredRecentChatsSection
          recentThreads={recentThreads}
          referenceTime={referenceTime}
          onOpenThread={handleOpenThread}
        />
      </Suspense>

      <Suspense fallback={<AppsFallback />}>
        <DeferredAppsSection
          userId={userId}
          allApps={allApps}
          referenceTime={referenceTime}
          onStartChatForApp={onStartChatForApp}
        />
      </Suspense>

      <section className="space-y-4">
        <SectionHeader
          title={hasConnections ? 'Your connected tools' : 'Connect your tools'}
          linkHref="/connections"
        />

        {hasConnections ? (
          <ConnectedTools connections={connections} onSelect={handleConnectionSelect} />
        ) : (
          <IntegrationButtons
            integrations={FEATURED_CONNECTIONS}
            onSelect={handleIntegrationSelect}
          />
        )}

        <Collapsible open={addConnectionOpen} onOpenChange={setAddConnectionOpen}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="group w-full flex items-center justify-between rounded-lg border border-dashed border-muted-foreground/25 px-4 py-2.5 text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground transition-colors"
            >
              <span className="flex items-center gap-2 text-sm">
                {addConnectionOpen ? (
                  <ChevronUp className="size-4" />
                ) : (
                  <Plus className="size-4" />
                )}
                {addConnectionOpen
                  ? 'Hide connections'
                  : hasConnections
                    ? 'Add another connection'
                    : 'Explore all connections'}
              </span>
              <div className="flex items-center -space-x-1 opacity-50 transition-opacity duration-200 group-hover:opacity-100">
                {LOGO_STACK_CONNECTIONS.map((item) => (
                  <div
                    key={item.type}
                    className="flex size-7 items-center justify-center rounded-md bg-background ring-2 ring-background"
                  >
                    <IntegrationIcon type={item.type} size={16} />
                  </div>
                ))}
              </div>
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up">
            <div className="pt-4">
              <ConnectionPicker
                integrations={allIntegrationDefs}
                mode="single-action"
                variant="compact"
                maxHeight="240px"
                onSelect={handleIntegrationSelect}
                excludeTypes={['other']}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </section>

      <section className="space-y-4">
        <SectionHeader title="Need inspiration? Try one of these" onRefresh={handleShufflePrompts} />
        <StarterPrompts
          prompts={promptsToDisplay}
          onSelect={handlePromptSelect}
          shuffleKey={shuffleKey}
        />
      </section>

      <GetHelpDialog
        open={helpOpen}
        onOpenChange={setHelpOpen}
        defaultCategory="feature"
      />
    </div>
  );
}
