import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Link,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigation,
  useSearchParams,
} from 'react-router';
import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Clock,
  ExternalLink,
  Loader2,
  MessagesSquare,
  Sparkles,
} from 'lucide-react';
import type { Route } from './+types/_admin.chat-explorer';
import { requireSuperuser } from '@/lib/auth.server';
import * as authDO from '@/lib/auth-do.server';
import { AdminPageHeader } from '@/components/admin/admin-page-header';
import { AdminSearch } from '@/components/admin/admin-search';
import { ChannelLogoStack } from '@/components/chat/channel-logo';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { BILLING_PLAN_LIMITS } from '@/lib/billing-plans';
import {
  normalizeChannelIndicatorKind,
  parseChannelIndicatorKindsJson,
} from '@/lib/channel-kinds';
import { cn } from '@/lib/utils';
import type {
  AdminChatExplorerRow,
  ChatExplorerFilters,
} from '../../workers/main/src/admin-index-types';

const PAGE_SIZE = 50;
const VISITED_STORAGE_KEY = 'qaml-chat-explorer-visited-v1';
const PLAN_VALUES = ['payg', 'starter', 'pro', 'team', 'enterprise'] as const;
type ExplorerPlan = (typeof PLAN_VALUES)[number];

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const shortDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

export function meta() {
  return [
    { title: 'Chat Explorer - Admin - camelAI' },
    { name: 'description', content: 'Explore user chat threads' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireSuperuser(request, context);

  const url = new URL(request.url);
  const offset = parsePositiveInt(url.searchParams.get('offset'), 0);
  const search = url.searchParams.get('search')?.trim() || '';
  const plan = parsePlan(url.searchParams.get('plan'));
  const first = url.searchParams.get('first') === '1';
  const automated = url.searchParams.get('automated') === '1';
  const errors = url.searchParams.get('errors') === '1';
  const hideInternal = url.searchParams.get('internal') === '0';
  const sort = url.searchParams.get('sort') === 'created' ? 'created' : 'activity';
  const filters: ChatExplorerFilters = {
    ...(plan ? { plan } : {}),
    ...(first ? { first_chats_only: true } : {}),
    ...(automated ? { automated_only: true } : {}),
    ...(errors ? { errors_only: true } : {}),
    ...(hideInternal ? { exclude_internal: true } : {}),
    sort_by: sort === 'created' ? 'created_at' : 'updated_at',
  };
  const page = await authDO.adminGetChatExplorerThreads(context, {
    offset,
    limit: PAGE_SIZE,
    search: search || undefined,
    filters,
  });

  return {
    ...page,
    search,
    plan,
    first,
    automated,
    errors,
    internal: hideInternal ? '0' : '1',
    sort,
  };
}

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: {
  currentUrl?: URL;
  nextUrl?: URL;
  defaultShouldRevalidate: boolean;
}) {
  if (!currentUrl || !nextUrl) return defaultShouldRevalidate;
  if (currentUrl.pathname !== nextUrl.pathname) return true;

  const currentParams = new URLSearchParams(currentUrl.search);
  const nextParams = new URLSearchParams(nextUrl.search);
  const currentThread = currentParams.get('thread');
  const nextThread = nextParams.get('thread');
  currentParams.delete('thread');
  nextParams.delete('thread');
  currentParams.sort();
  nextParams.sort();

  if (
    currentThread !== nextThread &&
    currentParams.toString() === nextParams.toString()
  ) {
    return false;
  }

  return defaultShouldRevalidate;
}

export default function AdminChatExplorerPage() {
  const loaderData = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const fetcher = useFetcher<typeof loader>();
  const selectedThreadId = searchParams.get('thread');
  const filterKey = useMemo(
    () =>
      JSON.stringify([
        loaderData.search,
        loaderData.plan,
        loaderData.first,
        loaderData.automated,
        loaderData.errors,
        loaderData.internal,
        loaderData.sort,
      ]),
    [
      loaderData.search,
      loaderData.plan,
      loaderData.first,
      loaderData.automated,
      loaderData.errors,
      loaderData.internal,
      loaderData.sort,
    ],
  );
  const [items, setItems] = useState<AdminChatExplorerRow[]>(loaderData.items);
  const [hasMore, setHasMore] = useState(loaderData.hasMore);
  const [visited, setVisited] = useState<Set<string>>(() => new Set());
  const [iframeLoading, setIframeLoading] = useState(Boolean(selectedThreadId));
  const listViewportRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingAdvanceRef = useRef<{ startLength: number } | null>(null);
  const appendedFetchKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setItems(loaderData.items);
    setHasMore(loaderData.hasMore);
    appendedFetchKeyRef.current = null;
    pendingAdvanceRef.current = null;
    listViewportRef.current?.scrollTo({ top: 0 });
  }, [filterKey, loaderData.items, loaderData.hasMore]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const parsed = JSON.parse(
        window.localStorage.getItem(VISITED_STORAGE_KEY) || '[]',
      );
      if (Array.isArray(parsed)) {
        setVisited(new Set(parsed.filter((id) => typeof id === 'string')));
      }
    } catch {
      setVisited(new Set());
    }
  }, []);

  const fetcherData = fetcher.data;
  useEffect(() => {
    if (!fetcherData || !Array.isArray(fetcherData.items)) return;
    const fetchFilterKey = JSON.stringify([
      fetcherData.search,
      fetcherData.plan,
      fetcherData.first,
      fetcherData.automated,
      fetcherData.errors,
      fetcherData.internal,
      fetcherData.sort,
    ]);
    if (fetchFilterKey !== filterKey) return;
    const fetchKey = `${fetchFilterKey}:${fetcherData.offset}:${fetcherData.items
      .map((item) => item.id)
      .join(',')}`;
    if (appendedFetchKeyRef.current === fetchKey) return;
    appendedFetchKeyRef.current = fetchKey;

    setItems((current) => {
      const existing = new Set(current.map((item) => item.id));
      return [
        ...current,
        ...fetcherData.items.filter((item) => !existing.has(item.id)),
      ];
    });
    setHasMore(fetcherData.hasMore);
  }, [fetcherData, filterKey]);

  const selectedIndex = selectedThreadId
    ? items.findIndex((item) => item.id === selectedThreadId)
    : -1;
  const selectedThread =
    selectedIndex >= 0 ? items[selectedIndex] : selectedThreadId ? null : undefined;
  const hideInternal = loaderData.internal === '0';
  const inPageNavigationLoading =
    navigation.state === 'loading' &&
    navigation.location?.pathname === location.pathname;
  const pageIsLoading = items.length === 0 && inPageNavigationLoading;
  const listDimmed = items.length > 0 && inPageNavigationLoading;

  const markVisited = useCallback((threadId: string) => {
    setVisited((current) => {
      if (current.has(threadId)) return current;
      const nextIds = [...current, threadId].slice(-1000);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(VISITED_STORAGE_KEY, JSON.stringify(nextIds));
      }
      return new Set(nextIds);
    });
  }, []);

  const selectThread = useCallback(
    (threadId: string) => {
      const params = new URLSearchParams(searchParams);
      params.set('thread', threadId);
      params.delete('offset');
      navigate(`${location.pathname}?${params.toString()}`, {
        preventScrollReset: true,
      });
      markVisited(threadId);
      window.setTimeout(() => {
        rowRefs.current.get(threadId)?.scrollIntoView({ block: 'nearest' });
      }, 0);
    },
    [location.pathname, markVisited, navigate, searchParams],
  );

  useEffect(() => {
    if (selectedThreadId || inPageNavigationLoading) return;
    const firstThread = items[0];
    if (!firstThread) return;
    const params = new URLSearchParams(searchParams);
    params.set('thread', firstThread.id);
    params.delete('offset');
    navigate(`${location.pathname}?${params.toString()}`, {
      replace: true,
      preventScrollReset: true,
    });
    markVisited(firstThread.id);
  }, [
    inPageNavigationLoading,
    items,
    location.pathname,
    markVisited,
    navigate,
    searchParams,
    selectedThreadId,
  ]);

  useEffect(() => {
    if (!selectedThreadId) return;
    setIframeLoading(true);
    rowRefs.current.get(selectedThreadId)?.scrollIntoView({ block: 'nearest' });
  }, [selectedThreadId]);

  const loadMore = useCallback(
    (advanceAfterLoad = false) => {
      if (!hasMore || fetcher.state !== 'idle') return;
      if (advanceAfterLoad) {
        pendingAdvanceRef.current = { startLength: items.length };
      }
      const params = new URLSearchParams(searchParams);
      params.delete('thread');
      params.set('offset', String(items.length));
      fetcher.load(`${location.pathname}?${params.toString()}`);
    },
    [fetcher, hasMore, items.length, location.pathname, searchParams],
  );

  useEffect(() => {
    const pending = pendingAdvanceRef.current;
    if (!pending) return;
    if (items.length <= pending.startLength) return;
    pendingAdvanceRef.current = null;
    const nextThread = items[pending.startLength];
    if (nextThread) {
      selectThread(nextThread.id);
    }
  }, [items, selectThread]);

  const moveSelection = useCallback(
    (direction: 1 | -1) => {
      if (items.length === 0) return;
      if (selectedIndex < 0) {
        selectThread(direction > 0 ? items[0].id : items[items.length - 1].id);
        return;
      }
      const nextIndex = selectedIndex + direction;
      if (nextIndex >= 0 && nextIndex < items.length) {
        selectThread(items[nextIndex].id);
        return;
      }
      if (direction > 0 && hasMore) {
        loadMore(true);
      }
    },
    [hasMore, items, loadMore, selectThread, selectedIndex],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          'input, textarea, select, [role="combobox"], [contenteditable="true"]',
        )
      ) {
        return;
      }
      if (event.key === 'ArrowDown' || event.key.toLowerCase() === 'j') {
        event.preventDefault();
        moveSelection(1);
      } else if (event.key === 'ArrowUp' || event.key.toLowerCase() === 'k') {
        event.preventDefault();
        moveSelection(-1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [moveSelection]);

  const updateFilter = useCallback(
    (name: string, value: string | null) => {
      const params = new URLSearchParams(searchParams);
      if (value) {
        params.set(name, value);
      } else {
        params.delete(name);
      }
      params.delete('offset');
      params.delete('thread');
      const query = params.toString();
      navigate(query ? `${location.pathname}?${query}` : location.pathname);
    },
    [location.pathname, navigate, searchParams],
  );

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: 'Admin', href: '/qaml-backdoor' },
          { label: 'Chat Explorer' },
        ]}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
          <AdminSearch
            placeholder="Search by user email, org, or title..."
            className="w-72"
            clearParams={['thread']}
          />
          <Select
            value={loaderData.plan ?? 'all'}
            onValueChange={(value) =>
              updateFilter('plan', value === 'all' ? null : value)
            }
          >
            <SelectTrigger size="sm" className="w-36">
              <SelectValue placeholder="All plans" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All plans</SelectItem>
              {PLAN_VALUES.map((plan) => (
                <SelectItem key={plan} value={plan}>
                  {BILLING_PLAN_LIMITS[plan].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Label className="h-7 rounded-md border border-border bg-input/20 px-2">
            <Switch
              size="sm"
              checked={loaderData.first}
              onCheckedChange={(checked) =>
                updateFilter('first', checked ? '1' : null)
              }
            />
            First chats only
          </Label>
          <Label className="h-7 rounded-md border border-border bg-input/20 px-2">
            <Switch
              size="sm"
              checked={loaderData.automated}
              onCheckedChange={(checked) =>
                updateFilter('automated', checked ? '1' : null)
              }
            />
            Automated only
          </Label>
          <Label className="h-7 rounded-md border border-border bg-input/20 px-2">
            <Switch
              size="sm"
              checked={loaderData.errors}
              onCheckedChange={(checked) =>
                updateFilter('errors', checked ? '1' : null)
              }
            />
            Errors only
          </Label>
          <Label className="h-7 rounded-md border border-border bg-input/20 px-2">
            <Switch
              size="sm"
              checked={hideInternal}
              onCheckedChange={(checked) =>
                updateFilter('internal', checked ? '0' : null)
              }
            />
            Hide internal
          </Label>
          <Select
            value={loaderData.sort}
            onValueChange={(value) =>
              updateFilter('sort', value === 'created' ? 'created' : null)
            }
          >
            <SelectTrigger size="sm" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="activity">Last activity</SelectItem>
              <SelectItem value="created">Created</SelectItem>
            </SelectContent>
          </Select>
          <div className="ml-auto inline-flex items-center gap-2 text-sm text-muted-foreground">
            {inPageNavigationLoading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : null}
            {loaderData.total.toLocaleString()} threads
          </div>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <aside className="flex w-[360px] shrink-0 flex-col border-r bg-background">
            <ScrollArea
              className="min-h-0 flex-1"
              viewportRef={listViewportRef}
            >
              {pageIsLoading ? (
                <ThreadListSkeleton />
              ) : items.length === 0 ? (
                <EmptyThreadList />
              ) : (
                <div
                  className={cn(
                    'transition-opacity',
                    listDimmed && 'pointer-events-none opacity-50',
                  )}
                >
                  {items.map((thread) => (
                    <ThreadListItem
                      key={thread.id}
                      thread={thread}
                      selected={thread.id === selectedThreadId}
                      visited={visited.has(thread.id)}
                      onSelect={() => selectThread(thread.id)}
                      refCallback={(node) => {
                        if (node) {
                          rowRefs.current.set(thread.id, node);
                        } else {
                          rowRefs.current.delete(thread.id);
                        }
                      }}
                    />
                  ))}
                  <div className="border-t p-2">
                    <div className="mb-1 text-center text-xs text-muted-foreground">
                      {items.length.toLocaleString()} of{' '}
                      {loaderData.total.toLocaleString()}
                    </div>
                    {hasMore ? (
                      <Button
                        type="button"
                        variant="ghost"
                        className="w-full"
                        onClick={() => loadMore(false)}
                        disabled={fetcher.state !== 'idle'}
                      >
                        {fetcher.state !== 'idle' ? (
                          <Loader2 className="animate-spin" />
                        ) : null}
                        Load more
                      </Button>
                    ) : null}
                  </div>
                </div>
              )}
            </ScrollArea>
          </aside>

          <main className="flex min-w-0 flex-1 flex-col bg-background">
            {selectedThreadId ? (
              <ReaderPane
                threadId={selectedThreadId}
                thread={selectedThread ?? null}
                selectedIndex={selectedIndex}
                loadedCount={items.length}
                hasMore={hasMore}
                iframeLoading={iframeLoading}
                onIframeLoad={() => setIframeLoading(false)}
                onPrevious={() => moveSelection(-1)}
                onNext={() => moveSelection(1)}
              />
            ) : (
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <div className="flex max-w-sm flex-col items-center gap-2 text-center text-muted-foreground">
                  <MessagesSquare className="size-8" />
                  <div className="text-sm font-medium text-foreground">
                    Select a thread to read
                  </div>
                  <div className="text-xs">Arrow keys or j/k move between threads</div>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </>
  );
}

function ThreadListItem({
  thread,
  selected,
  visited,
  onSelect,
  refCallback,
}: {
  thread: AdminChatExplorerRow;
  selected: boolean;
  visited: boolean;
  onSelect: () => void;
  refCallback: (node: HTMLButtonElement | null) => void;
}) {
  const title = thread.title?.trim();
  const channelKinds = getExplorerChannelKinds(thread);
  const sourceBadge = getSourceBadgeLabel(thread, channelKinds);
  const messageCount = formatUserMessageCount(thread);
  return (
    <button
      ref={refCallback}
      type="button"
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'block w-full border-b border-border/50 px-3 py-2.5 text-left transition-colors hover:bg-muted/60',
        selected && 'bg-accent',
      )}
      onClick={onSelect}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div
          className={cn(
            'min-w-0 truncate text-sm font-medium',
            !title && 'italic text-muted-foreground',
            visited && !selected && 'text-muted-foreground',
          )}
        >
          {title || 'Untitled'}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
              suppressHydrationWarning
            >
              {visited && !selected ? (
                <Check className="size-3" aria-hidden="true" />
              ) : null}
              {formatCompactRelativeTime(thread.updated_at)}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <div>Created {formatDateTime(thread.created_at)}</div>
            {thread.last_user_message_at ? (
              <div>Last user message {formatDateTime(thread.last_user_message_at)}</div>
            ) : null}
          </TooltipContent>
        </Tooltip>
      </div>
      {thread.first_user_message ? (
        <div className="mt-1 line-clamp-2 text-xs leading-snug text-muted-foreground">
          “{thread.first_user_message}”
        </div>
      ) : null}
      <div className="mt-1 truncate text-xs text-muted-foreground">
        {thread.user_email ?? thread.created_by ?? 'unknown'} ·{' '}
        {thread.org_name ?? 'Unknown org'}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <PlanBadge thread={thread} />
        {messageCount ? (
          <Badge variant="outline" className="h-4 px-1.5 py-0 text-[10px]">
            {messageCount}
          </Badge>
        ) : null}
        <ModelHistoryBadges thread={thread} />
        <ThreadErrorBadge thread={thread} />
        {channelKinds.length > 0 ? (
          <ChannelLogoStack
            channels={channelKinds}
            tooltipFor={(label) => `Contains messages sent via ${label}`}
          />
        ) : null}
        {sourceBadge ? (
          <Badge variant="outline" className="h-4 px-1.5 py-0 text-[10px] capitalize">
            {sourceBadge}
          </Badge>
        ) : null}
        {isAutomatedThread(thread) ? (
          <Badge
            variant="outline"
            className="h-4 px-1.5 py-0 text-[10px] text-muted-foreground"
          >
            <Clock className="size-2.5" />
            Automated
          </Badge>
        ) : null}
        {thread.is_first_thread ? (
          <Badge
            variant="outline"
            className="h-4 border-amber-500/50 px-1.5 py-0 text-[10px] text-amber-600 dark:text-amber-400"
          >
            <Sparkles className="size-2.5" />
            first chat
          </Badge>
        ) : null}
      </div>
    </button>
  );
}

function ReaderPane({
  threadId,
  thread,
  selectedIndex,
  loadedCount,
  hasMore,
  iframeLoading,
  onIframeLoad,
  onPrevious,
  onNext,
}: {
  threadId: string;
  thread: AdminChatExplorerRow | null;
  selectedIndex: number;
  loadedCount: number;
  hasMore: boolean;
  iframeLoading: boolean;
  onIframeLoad: () => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const title = thread?.title?.trim() || threadId;
  const planLabel = thread ? getPlanLabel(thread.org_plan) : null;
  const channelKinds = thread ? getExplorerChannelKinds(thread) : [];
  const messageCount = thread ? formatUserMessageCount(thread) : null;
  const modelHistory = thread ? getModelHistory(thread) : [];
  const createdLabel = thread ? `created ${shortDateFormatter.format(new Date(thread.created_at))}` : null;
  const nextDisabled = selectedIndex >= 0 && selectedIndex === loadedCount - 1 && !hasMore;

  return (
    <>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {thread ? (
              <div className="min-w-0 truncate">
                <span>{thread.user_email ?? thread.created_by ?? 'unknown'}</span>
                <span> · </span>
                {thread.org_id ? (
                  <Link
                    to={`/qaml-backdoor/orgs/${thread.org_id}`}
                    className="hover:underline"
                  >
                    {thread.org_name ?? 'Unknown org'}
                  </Link>
                ) : (
                  <span>{thread.org_name ?? 'Unknown org'}</span>
                )}
                {planLabel ? <span> · {planLabel}</span> : null}
                {messageCount ? <span> · {messageCount}</span> : null}
                {modelHistory.length > 0 ? (
                  <span> · models {formatModelHistoryInline(modelHistory, thread.model)}</span>
                ) : null}
                {createdLabel ? <span> · {createdLabel}</span> : null}
                {isAutomatedThread(thread) ? <span> · Automated</span> : null}
              </div>
            ) : (
              <span>Thread metadata is not loaded</span>
            )}
            {channelKinds.length > 0 ? (
              <ChannelLogoStack
                channels={channelKinds}
                tooltipFor={(label) => `Contains messages sent via ${label}`}
              />
            ) : null}
            {thread && thread.chat_error_count > 0 ? (
              <ThreadErrorBadge thread={thread} />
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={onPrevious}
                disabled={selectedIndex <= 0}
                aria-label="Previous thread"
              >
                <ChevronUp />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Previous thread</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={onNext}
                disabled={nextDisabled}
                aria-label="Next thread"
              >
                <ChevronDown />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Next thread</TooltipContent>
          </Tooltip>
          <Button asChild variant="outline" size="sm">
            <a
              href={`/chat/${encodeURIComponent(threadId)}?adminReadonly=1`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink />
              Open
            </a>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to={`/qaml-backdoor/threads/${encodeURIComponent(threadId)}`}>
              Thread admin
            </Link>
          </Button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {iframeLoading ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/80">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading thread
            </div>
          </div>
        ) : null}
        <iframe
          key={threadId}
          src={`/chat/${encodeURIComponent(threadId)}?adminReadonly=1&embed=1`}
          title="Thread preview"
          className="h-full w-full border-0 bg-background"
          onLoad={onIframeLoad}
        />
      </div>
    </>
  );
}

function ThreadErrorBadge({ thread }: { thread: AdminChatExplorerRow }) {
  if (!thread.chat_error_count || thread.chat_error_count <= 0) return null;
  const label = thread.chat_error_count > 1 ? `Error x${thread.chat_error_count}` : 'Error';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="h-4 border-destructive/60 px-1.5 py-0 text-[10px] text-destructive"
        >
          <CircleAlert className="size-2.5" />
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        <div className="space-y-1">
          <div className="font-medium">Last chat error</div>
          {thread.last_chat_error_message ? (
            <div className="text-muted-foreground">{thread.last_chat_error_message}</div>
          ) : null}
          <div className="text-xs text-muted-foreground">
            {[
              thread.last_chat_error_source ? `source ${thread.last_chat_error_source}` : null,
              thread.last_chat_error_status ? `status ${thread.last_chat_error_status}` : null,
              thread.last_chat_error_provider ? `provider ${thread.last_chat_error_provider}` : null,
              thread.last_chat_error_model ? `model ${thread.last_chat_error_model}` : null,
              thread.last_chat_error_at ? formatDateTime(thread.last_chat_error_at) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function ModelHistoryBadges({ thread }: { thread: AdminChatExplorerRow }) {
  const models = getModelHistory(thread);
  if (models.length === 0) return null;
  const visible = models.length > 3 ? [...models.slice(0, 2), `+${models.length - 2}`] : models;
  return (
    <>
      {visible.map((model) => (
        <Tooltip key={model}>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className={cn(
                'h-4 max-w-28 px-1.5 py-0 text-[10px]',
                model === thread.model && 'border-primary/40 text-foreground',
              )}
            >
              <span className="truncate">{model}</span>
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-80">
            <div className="space-y-1">
              <div className="font-medium">Models in thread</div>
              <div className="text-xs text-muted-foreground">
                {models
                  .map((entry) => (entry === thread.model ? `${entry} (current)` : entry))
                  .join(' · ')}
              </div>
            </div>
          </TooltipContent>
        </Tooltip>
      ))}
    </>
  );
}

function PlanBadge({ thread }: { thread: AdminChatExplorerRow }) {
  const hasBillingMetadata = Boolean(
    thread.org_name || thread.org_billing_plan || thread.org_billing_status,
  );
  if (!hasBillingMetadata) {
    return (
      <Badge variant="outline" className="h-4 px-1.5 py-0 text-[10px] text-muted-foreground">
        Unknown
      </Badge>
    );
  }

  const plan = parsePlan(thread.org_plan) ?? 'payg';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn(
            'h-4 px-1.5 py-0 text-[10px]',
            getPlanBadgeClassName(plan),
          )}
        >
          {getPlanLabel(plan)}
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        plan: {thread.org_billing_plan ?? '-'} - status:{' '}
        {thread.org_billing_status ?? '-'}
      </TooltipContent>
    </Tooltip>
  );
}

function ThreadListSkeleton() {
  return (
    <div>
      {Array.from({ length: 7 }).map((_, index) => (
        <div key={index} className="border-b border-border/50 px-3 py-2.5">
          <div className="flex justify-between gap-3">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-8" />
          </div>
          <Skeleton className="mt-2 h-8 w-full" />
          <Skeleton className="mt-2 h-3 w-56" />
          <div className="mt-2 flex gap-1.5">
            <Skeleton className="h-4 w-12 rounded-full" />
            <Skeleton className="h-4 w-14 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyThreadList() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sort = searchParams.get('sort') === 'created' ? 'created' : null;
  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center gap-2 px-6 text-center">
      <MessagesSquare className="size-7 text-muted-foreground" />
      <div className="text-sm text-muted-foreground">No threads match</div>
      <Button
        type="button"
        variant="ghost"
        onClick={() =>
          navigate(
            sort
              ? `/qaml-backdoor/chat-explorer?sort=${sort}`
              : '/qaml-backdoor/chat-explorer',
          )
        }
      >
        Clear filters
      </Button>
    </div>
  );
}

function parsePositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePlan(value: string | null | undefined): ExplorerPlan | null {
  return PLAN_VALUES.includes(value as ExplorerPlan) ? (value as ExplorerPlan) : null;
}

function getPlanLabel(plan: string): string {
  const parsed = parsePlan(plan) ?? 'payg';
  return BILLING_PLAN_LIMITS[parsed].label;
}

function getPlanBadgeClassName(plan: ExplorerPlan): string {
  switch (plan) {
    case 'starter':
      return 'border-sky-500/50 text-sky-600 dark:text-sky-400';
    case 'pro':
      return 'border-violet-500/50 text-violet-600 dark:text-violet-400';
    case 'team':
      return 'border-amber-500/50 text-amber-600 dark:text-amber-400';
    case 'enterprise':
      return 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400';
    case 'payg':
    default:
      return '';
  }
}

function formatUserMessageCount(thread: AdminChatExplorerRow): string | null {
  const count = thread.user_message_count;
  if (count === null || count === undefined) return null;
  if (thread.user_message_count_capped || count > 20) return '20+ msgs';
  if (count === 1) return '1 msg';
  return `${count} msgs`;
}

function getModelHistory(thread: AdminChatExplorerRow): string[] {
  const models: string[] = [];
  const addModel = (value: unknown) => {
    if (typeof value !== 'string') return;
    const model = value.trim();
    if (model && !models.includes(model)) models.push(model);
  };

  if (typeof thread.model_history === 'string' && thread.model_history.trim()) {
    try {
      const parsed = JSON.parse(thread.model_history) as unknown;
      if (Array.isArray(parsed)) {
        parsed.forEach(addModel);
      } else {
        addModel(thread.model_history);
      }
    } catch {
      addModel(thread.model_history);
    }
  }
  addModel(thread.model);
  return models;
}

function formatModelHistoryInline(models: string[], currentModel: string | null): string {
  if (models.length === 0) return '';
  if (models.length <= 3) {
    return models.map((model) => (model === currentModel ? `${model} current` : model)).join(', ');
  }
  return `${models.slice(0, 2).join(', ')}, +${models.length - 2}`;
}

function getExplorerChannelKinds(thread: AdminChatExplorerRow): string[] {
  const channelKinds = parseChannelIndicatorKindsJson(thread.channel_kinds);
  if (channelKinds?.length) return channelKinds;
  const originKind = normalizeChannelIndicatorKind(thread.channel_kind);
  return originKind ? [originKind] : [];
}

function getSourceBadgeLabel(
  thread: AdminChatExplorerRow,
  channelKinds: string[],
): string | null {
  if (channelKinds.length > 0) return null;
  const source = thread.source?.trim();
  if (source && source !== 'web' && source !== 'scheduled') return source;
  return null;
}

function isAutomatedThread(thread: AdminChatExplorerRow): boolean {
  return (
    thread.source === 'scheduled' ||
    thread.created_by === 'system' ||
    (thread.title?.startsWith('Scheduled: ') ?? false)
  );
}

function formatDateTime(value: number): string {
  return dateFormatter.format(new Date(value));
}

function formatCompactRelativeTime(value: number): string {
  const diffMs = Date.now() - value;
  const absMs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (absMs < minute) return 'now';
  if (absMs < hour) return `${Math.round(absMs / minute)}m`;
  if (absMs < day) return `${Math.round(absMs / hour)}h`;
  if (absMs < 30 * day) return `${Math.round(absMs / day)}d`;
  return shortDateFormatter.format(new Date(value));
}
