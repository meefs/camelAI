'use client';

import { Suspense, useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Await, useNavigate } from 'react-router';
import { ChevronUp, Plus } from 'lucide-react';
import type {
  AtMentionEntity,
  CondensedTranscript,
  GroupNewChatAttachmentCard,
  GroupNewChatPayload,
  GroupNewChatTranscriptCard,
  WorkerScriptWithCreator,
  Integration,
  LlmModel,
  Thread,
} from '@/types';
import type { Attachment } from '@/components/attachment-list';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { PromptInput } from '@/components/prompt-input';
import { ConnectionPicker } from '@/components/connection-picker';
import { Skeleton } from '@/components/ui/skeleton';
import { getAllIntegrations } from '@/lib/integration-registry';
import { IntegrationIcon } from '@/lib/integration-icons';
import {
  buildSlugMap,
  slugForMentionable,
  filterMentionables,
  type MentionableProject,
} from '@/lib/mentions';
import { AnimatedPlaceholder } from './animated-placeholder';
import { createSeededRandom, hashStringToSeed } from './deterministic-random';
import { WelcomeGreeting } from './welcome-greeting';
import { SectionHeader } from './section-header';
import { StarterPrompts, type StarterPromptItem } from './starter-prompts';
import { IntegrationButtons, FEATURED_CONNECTIONS, LOGO_STACK_CONNECTIONS } from './integration-buttons';
import { ConnectedTools } from './connected-tools';
import { AppCardsRow } from './app-cards-row';
import { RecentChatsRow } from './recent-chats-row';
import { GroupNewChatHeader } from './group-new-chat-header';
import { RecentlyUsedInGroup } from './recently-used-in-group';
import { STARTER_PROMPTS, pickStarterPrompts } from './starter-prompt-catalog';
import { useResolvedList } from './use-resolved-list';
import type {
  ModelPausedReason,
  ModelPickerOption,
} from '@/lib/model-picker-access';
import type { RecentModelScope } from '@/lib/recent-model';

interface WelcomeScreenProps {
  userId: string | null;
  userName: string | null;
  workspaceId: string | null;
  allApps: WorkerScriptWithCreator[] | Promise<WorkerScriptWithCreator[]>;
  connections: Integration[] | Promise<Integration[]>;
  projects: MentionableProject[] | Promise<MentionableProject[]>;
  recentThreads: Thread[] | Promise<Thread[]>;
  renderedAt?: number;
  group?: GroupNewChatPayload;
  onPromptChange: (prompt: string) => void;
  onSubmit: () => void;
  onStartChatForApp: (app: WorkerScriptWithCreator) => void;
  inputValue: string;
  attachments: Attachment[];
  onFilesSelected: (files: File[]) => void;
  onRecentAttachmentSelect: (card: GroupNewChatAttachmentCard) => void;
  onTranscriptAttach: (
    transcript: CondensedTranscript,
    card: GroupNewChatTranscriptCard,
  ) => Promise<void> | void;
  onAttachmentRemove: (id: string) => void;
  isCreatingThread: boolean;
  model: LlmModel;
  onModelChange: (model: LlmModel) => void;
  modelOptions: ReadonlyArray<ModelPickerOption>;
  isOrgAdmin?: boolean;
  onLockedModelSelect?: (model: LlmModel) => void;
  onUnlockRequest?: () => void;
  showMoreModelsCta?: boolean;
  pausedSection?: { reason: ModelPausedReason } | null;
  recentModelScope?: RecentModelScope | null;
  noModelsMessage?: string | null;
  noModelsNotice?: ReactNode;
}

const EMPTY_INTEGRATIONS: Integration[] = [];
const EMPTY_PROJECTS: MentionableProject[] = [];
const ALL_INTEGRATION_DEFS = getAllIntegrations().map((def) => ({
  type: def.type,
  displayName: def.displayName,
  category: def.category,
}));

function RecentChatsFallback() {
  return (
    <section className="space-y-4">
      <SectionHeader title="Recent chats" linkHref="/history" />
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
      <SectionHeader title="Your apps" linkHref="/apps" />
      <div className="flex gap-4 overflow-x-auto pb-2 no-scrollbar">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="aspect-video w-[260px] shrink-0 rounded-xl" />
        ))}
      </div>
    </section>
  );
}

function RecentChatsSection({
  resolvedRecentThreads,
  referenceTime,
  onOpenThread,
}: {
  resolvedRecentThreads: Thread[];
  referenceTime: number;
  onOpenThread: (threadId: string) => void;
}) {
  if (resolvedRecentThreads.length === 0) return null;

  return (
    <section className="space-y-4">
      <SectionHeader title="Recent chats" linkHref="/history" />
      <RecentChatsRow
        threads={resolvedRecentThreads.slice(0, 4)}
        renderedAt={referenceTime}
        onOpenThread={onOpenThread}
      />
    </section>
  );
}

function AppsSection({
  userId,
  resolvedApps,
  referenceTime,
  onStartChatForApp,
}: {
  userId: string | null;
  resolvedApps: WorkerScriptWithCreator[];
  referenceTime: number;
  onStartChatForApp: (app: WorkerScriptWithCreator) => void;
}) {
  const userApps = userId
    ? resolvedApps.filter((app) => app.created_by === userId)
    : [];
  const teamApps = userId
    ? resolvedApps.filter((app) => app.created_by !== userId)
    : resolvedApps;

  if (userApps.length > 0) {
    return (
      <section className="space-y-4">
        <SectionHeader title="Your apps" linkHref="/apps" />
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
        <SectionHeader title="Team apps" linkHref="/apps" />
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
  workspaceId,
  allApps,
  connections,
  projects,
  recentThreads,
  renderedAt,
  group,
  onPromptChange,
  onSubmit,
  onStartChatForApp,
  inputValue,
  attachments,
  onFilesSelected,
  onRecentAttachmentSelect,
  onTranscriptAttach,
  onAttachmentRemove,
  isCreatingThread,
  model,
  onModelChange,
  modelOptions,
  isOrgAdmin = false,
  onLockedModelSelect,
  onUnlockRequest,
  showMoreModelsCta = false,
  pausedSection = null,
  recentModelScope,
  noModelsMessage,
  noModelsNotice,
}: WelcomeScreenProps) {
  const navigate = useNavigate();
  const [referenceTime] = useState(() => renderedAt ?? Date.now());
  const resolvedConnections = useResolvedList(connections, EMPTY_INTEGRATIONS);
  const resolvedProjects = useResolvedList(projects, EMPTY_PROJECTS);
  const mentionableConnections = useMemo(
    () => filterMentionables(
      resolvedConnections.map((connection) => ({
        ...connection,
        kind: 'connection' as const,
      })),
    ),
    [resolvedConnections],
  );
  const mentionEntities = useMemo<AtMentionEntity[]>(() => [
    ...mentionableConnections,
    ...resolvedProjects,
  ], [mentionableConnections, resolvedProjects]);
  const hasConnections = mentionableConnections.length > 0;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const connectionSlugMap = useMemo(
    () => buildSlugMap(mentionEntities),
    [mentionEntities],
  );

  const focusInput = useCallback(() => {
    textareaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  const handleOpenThread = useCallback((threadId: string) => {
    navigate(`/chat/${threadId}`);
  }, [navigate]);
  const [addConnectionOpen, setAddConnectionOpen] = useState(false);

  const [shuffleKey, setShuffleKey] = useState(0);
  const initialPromptSeed = useMemo(
    () => hashStringToSeed(`starter-prompts:${referenceTime}:${userId ?? 'anonymous'}`),
    [referenceTime, userId]
  );
  const promptsToDisplay = useMemo(
    () =>
      shuffleKey === 0
        ? pickStarterPrompts(STARTER_PROMPTS, 4, createSeededRandom(initialPromptSeed))
        : pickStarterPrompts(STARTER_PROMPTS, 4),
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
    const computedSlug = slugForMentionable(
      { ...connection, kind: 'connection' as const },
      connectionSlugMap,
    );
    if (!computedSlug) return;
    onPromptChange(`@${computedSlug} `);
    focusInput();
  }, [connectionSlugMap, onPromptChange, focusInput]);

  const handleGroupTagSelect = useCallback((item: AtMentionEntity) => {
    const computedSlug = slugForMentionable(item, connectionSlugMap);
    if (!computedSlug) return;
    const separator = inputValue && !inputValue.endsWith(' ') ? ' ' : '';
    onPromptChange(`${inputValue}${separator}@${computedSlug} `);
    focusInput();
  }, [connectionSlugMap, focusInput, inputValue, onPromptChange]);

  const handleIntegrationSelect = useCallback((integration: { type: string; displayName: string }) => {
    onPromptChange(`Let's connect ${integration.displayName}`);
    focusInput();
  }, [onPromptChange, focusInput]);
  const promptComposer = (
    <div>
      <AnimatedPlaceholder isActive={shouldAnimatePlaceholder}>
        {(animatedText) => (
          <PromptInput
            textareaRef={textareaRef}
            value={inputValue}
            onChange={onPromptChange}
            onSubmit={onSubmit}
            placeholder="Ask anything..."
            animatedPlaceholder={
              shouldAnimatePlaceholder ? animatedText : undefined
            }
            isLoading={isCreatingThread}
            minHeight="80px"
            autoFocus
            attachments={attachments}
            onFilesSelected={onFilesSelected}
            onAttachmentRemove={onAttachmentRemove}
            workspaceId={workspaceId}
            model={model}
            onModelChange={onModelChange}
            modelOptions={modelOptions}
            modelDisabled={isCreatingThread}
            disabled={Boolean(noModelsMessage)}
            isOrgAdmin={isOrgAdmin}
            onLockedModelSelect={onLockedModelSelect}
            onUnlockRequest={onUnlockRequest}
            showMoreModelsCta={showMoreModelsCta}
            pausedSection={pausedSection}
            recentModelScope={recentModelScope}
            mentionables={mentionEntities}
            mentionMenuSide="top"
            onMentionAddNewClick={() => navigate('/connections')}
          />
        )}
      </AnimatedPlaceholder>
    </div>
  );

  if (group) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-10">
        <GroupNewChatHeader group={group} />

        <div>
          {promptComposer}

          {noModelsNotice ? (
            <div className="mt-2">{noModelsNotice}</div>
          ) : noModelsMessage ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {noModelsMessage}
            </p>
          ) : null}
        </div>

        <RecentlyUsedInGroup
          group={group}
          connections={mentionableConnections}
          projects={resolvedProjects}
          inputValue={inputValue}
          attachments={attachments}
          workspaceId={workspaceId}
          mentionSlugMap={connectionSlugMap}
          onTagSelect={handleGroupTagSelect}
          onAttachmentSelect={onRecentAttachmentSelect}
          onTranscriptAttach={onTranscriptAttach}
        />
      </div>
    );
  }

  return (
    <div className="w-full max-w-5xl space-y-10">
      <WelcomeGreeting userName={userName} seed={referenceTime} />

      {promptComposer}

      {noModelsNotice ? (
        <div className="-mt-8">{noModelsNotice}</div>
      ) : noModelsMessage ? (
        <p className="-mt-8 text-sm text-muted-foreground">
          {noModelsMessage}
        </p>
      ) : null}

      <Suspense fallback={<RecentChatsFallback />}>
        <Await resolve={recentThreads}>
          {(resolvedRecentThreads) => (
            <RecentChatsSection
              resolvedRecentThreads={resolvedRecentThreads}
              referenceTime={referenceTime}
              onOpenThread={handleOpenThread}
            />
          )}
        </Await>
      </Suspense>

      <Suspense fallback={<AppsFallback />}>
        <Await resolve={allApps}>
          {(resolvedApps) => (
            <AppsSection
              userId={userId}
              resolvedApps={resolvedApps}
              referenceTime={referenceTime}
              onStartChatForApp={onStartChatForApp}
            />
          )}
        </Await>
      </Suspense>

      <section className="space-y-4">
        <SectionHeader title="Connections" linkHref="/connections" />

        {hasConnections ? (
          <ConnectedTools connections={mentionableConnections} onSelect={handleConnectionSelect} />
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
                integrations={ALL_INTEGRATION_DEFS}
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
        <SectionHeader title="Try something new" onRefresh={handleShufflePrompts} />
        <StarterPrompts
          prompts={promptsToDisplay}
          onSelect={handlePromptSelect}
          shuffleKey={shuffleKey}
        />
      </section>
    </div>
  );
}
