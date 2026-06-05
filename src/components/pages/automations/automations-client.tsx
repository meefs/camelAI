"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useFetcher,
  useNavigate,
  useNavigation,
  useRevalidator,
  useSearchParams,
  useSubmit,
} from "react-router";
import { Plus, Search, X } from "lucide-react";
import { toast } from "sonner";
import { APP_BUILD_ID } from "@/lib/app-build-id";
import {
  sortAutomations,
  type AutomationKind,
  type AutomationListItem,
  type AutomationRunsPage,
  type AutomationRunSummary,
  type RunsLoadingState,
} from "@/lib/automations-shared";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AutomationList } from "./automation-list";
import { AutomationPanel } from "./automation-panel";
import { cn } from "@/lib/utils";

type ActionData =
  | { success: true; automation: AutomationListItem }
  | { success: false; automation: AutomationListItem; error: string }
  | { success: true; id: string; kind: AutomationKind }
  | { error: string };

interface AutomationsClientProps {
  initialAutomations: AutomationListItem[];
  initialNow: number;
}

interface RenameState {
  id: string;
  kind: AutomationKind;
  value: string;
  original: AutomationListItem;
}

interface DeleteState {
  automation: AutomationListItem;
}

interface PendingAction {
  intent: "run" | "setEnabled" | "rename" | "delete";
  previous: AutomationListItem[];
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, [contenteditable='true']"));
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const updateMatches = () => setMatches(mediaQuery.matches);
    updateMatches();
    mediaQuery.addEventListener("change", updateMatches);
    return () => mediaQuery.removeEventListener("change", updateMatches);
  }, [query]);

  return matches;
}

interface RunsState {
  /** `${kind}:${id}` of the automation these runs belong to. */
  key: string;
  runs: AutomationRunSummary[];
  /** Cursor for the next (older) page; null when history is exhausted. */
  cursor: string | null;
}

function automationKey(kind: AutomationKind, id: string): string {
  return `${kind}:${id}`;
}

function parseAutomationKey(key: string): { kind: AutomationKind; id: string } {
  const separator = key.indexOf(":");
  return {
    kind: key.slice(0, separator) as AutomationKind,
    id: key.slice(separator + 1),
  };
}

function buildRunsUrl(
  id: string,
  kind: AutomationKind,
  cursor: string | null,
): string {
  const params = new URLSearchParams({ kind });
  if (cursor) params.set("cursor", cursor);
  return `/api/automations/${encodeURIComponent(id)}/runs?${params.toString()}`;
}

export default function AutomationsClient({
  initialAutomations,
  initialNow,
}: AutomationsClientProps) {
  const navigate = useNavigate();
  const submit = useSubmit();
  const navigation = useNavigation();
  const fetcher = useFetcher<ActionData>();
  const runsFetcher = useFetcher<AutomationRunsPage | { error: string }>();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [automations, setAutomations] = useState(initialAutomations);
  const [now, setNow] = useState(initialNow);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const [deleteState, setDeleteState] = useState<DeleteState | null>(null);
  const [runState, setRunState] = useState<RunsState | null>(null);
  const [runsLoading, setRunsLoading] = useState<RunsLoadingState>(null);
  const [mounted, setMounted] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const pendingAction = useRef<PendingAction | null>(null);
  const runsFetcherLoadRef = useRef(runsFetcher.load);
  const selectedId = searchParams.get("selected");
  const selectedIdRef = useRef<string | null>(selectedId);
  const selectedAutomation =
    automations.find((automation) => automation.id === selectedId) ?? null;
  const selectedRunsKey = selectedAutomation
    ? automationKey(selectedAutomation.kind, selectedAutomation.id)
    : null;
  const chatLoading =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "createThreadAndStart";
  const showMobileSheet = mounted && Boolean(selectedAutomation) && !isDesktop;

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    runsFetcherLoadRef.current = runsFetcher.load;
  }, [runsFetcher.load]);

  useEffect(() => {
    setAutomations(initialAutomations);
    setNow(initialNow);
  }, [initialAutomations, initialNow]);

  useEffect(() => {
    if (selectedId && !selectedAutomation) {
      setSearchParams({}, { replace: true });
    }
  }, [selectedAutomation, selectedId, setSearchParams]);

  const loadRunsPage = useCallback(
    (key: string, cursor: string | null, loading: RunsLoadingState) => {
      const { kind, id } = parseAutomationKey(key);
      if (loading) setRunsLoading(loading);
      runsFetcherLoadRef.current(buildRunsUrl(id, kind, cursor));
    },
    [],
  );

  // Load the first page of run history whenever the selected automation changes.
  // This is intentionally keyed only on selectedRunsKey; fetcher state changes
  // must not clear rows and restart the first-page request.
  useEffect(() => {
    if (!selectedRunsKey) {
      setRunState(null);
      setRunsLoading(null);
      return;
    }
    const { kind, id } = parseAutomationKey(selectedRunsKey);
    setRunState({ key: selectedRunsKey, runs: [], cursor: null });
    setRunsLoading("page");
    runsFetcherLoadRef.current(buildRunsUrl(id, kind, null));
  }, [selectedRunsKey]);

  // Apply run-history results. The endpoint echoes id/kind so a response for an
  // automation the user already left is discarded; fromCursor distinguishes the
  // first page (replace) from a "Show older runs" page (append + dedupe).
  useEffect(() => {
    const data = runsFetcher.data;
    if (!data) return;
    if ("error" in data) {
      setRunsLoading(null);
      toast.error(data.error);
      return;
    }
    const dataKey = automationKey(data.kind, data.id);
    if (dataKey !== selectedRunsKey) return;
    setRunState((current) => {
      const hasCurrentRuns =
        current != null && current.key === dataKey && current.runs.length > 0;
      const seen = new Set<string>();
      const merged: AutomationRunSummary[] = [];
      const pushUnique = (run: AutomationRunSummary) => {
        if (seen.has(run.id)) return;
        seen.add(run.id);
        merged.push(run);
      };
      if (data.fromCursor != null && hasCurrentRuns) {
        for (const run of current.runs) {
          pushUnique(run);
        }
      }
      for (const run of data.runs) {
        pushUnique(run);
      }
      if (data.fromCursor == null && hasCurrentRuns) {
        for (const run of current.runs) {
          pushUnique(run);
        }
      }
      const cursor =
        data.fromCursor == null && hasCurrentRuns ? current.cursor : data.cursor;
      return { key: dataKey, runs: merged, cursor };
    });
    setRunsLoading(null);
  }, [runsFetcher.data, selectedRunsKey]);

  const hasInFlightAutomation = automations.some(
    (automation) =>
      automation.runtime_status === "running" ||
      automation.runtime_status === "needs_input" ||
      automation.last_run_status === "started",
  );

  useEffect(() => {
    if (!hasInFlightAutomation) return;
    const interval = window.setInterval(() => {
      revalidator.revalidate();
      if (selectedRunsKey && runsLoading !== "more") {
        loadRunsPage(selectedRunsKey, null, null);
      }
      setNow(Date.now());
    }, 10_000);
    return () => window.clearInterval(interval);
  }, [hasInFlightAutomation, loadRunsPage, revalidator, runsLoading, selectedRunsKey]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        revalidator.revalidate();
        if (selectedRunsKey && runsLoading !== "more") {
          loadRunsPage(selectedRunsKey, null, null);
        }
        setNow(Date.now());
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [loadRunsPage, revalidator, runsLoading, selectedRunsKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "/" && !isTypingTarget(event.target)) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (event.key === "Escape" && selectedAutomation && !renaming) {
        setSearchParams({});
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [renaming, selectedAutomation, setSearchParams]);

  useEffect(() => {
    const data = fetcher.data;
    if (!data) return;
    const pending = pendingAction.current;
    if (!pending) return;
    pendingAction.current = null;

    if ("automation" in data) {
      const updatedAutomation = data.automation;
      setAutomations((current) =>
        sortAutomations(
          current.map((automation) =>
            automation.id === updatedAutomation.id &&
            automation.kind === updatedAutomation.kind
              ? updatedAutomation
              : automation,
          ),
        ),
      );
      if (data.success === false) {
        if (pending.intent === "run") {
          const key = automationKey(updatedAutomation.kind, updatedAutomation.id);
          if (selectedRunsKey === key) {
            loadRunsPage(key, null, null);
          }
        }
        toast.error(data.error);
        return;
      }
      if (pending.intent === "run") {
        toast.success("Run started");
        const key = automationKey(updatedAutomation.kind, updatedAutomation.id);
        if (selectedRunsKey === key) {
          loadRunsPage(key, null, null);
        }
      }
      if (pending.intent === "rename") toast.success("Automation renamed");
      return;
    }

    if ("error" in data) {
      setAutomations(pending.previous);
      toast.error(data.error);
      return;
    }

    const deleted = data;
    setAutomations((current) =>
      current.filter(
        (automation) =>
          automation.id !== deleted.id || automation.kind !== deleted.kind,
      ),
    );
    if (selectedIdRef.current === deleted.id) {
      setSearchParams({});
    }
    toast.success("Automation deleted");
  }, [fetcher.data, loadRunsPage, selectedRunsKey, setSearchParams]);

  const filteredAutomations = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return automations;
    return automations.filter((automation) =>
      automation.name.toLowerCase().includes(trimmed),
    );
  }, [automations, query]);

  const submitAutomation = useCallback(
    (
      automation: AutomationListItem,
      intent: PendingAction["intent"],
      fields: Record<string, string> = {},
      optimistic: (items: AutomationListItem[]) => AutomationListItem[],
    ) => {
      const previous = automations;
      pendingAction.current = { intent, previous };
      setAutomations((current) => sortAutomations(optimistic(current)));
      fetcher.submit(
        {
          intent,
          kind: automation.kind,
          id: automation.id,
          ...fields,
        },
        { method: "post", action: "/automations" },
      );
    },
    [automations, fetcher],
  );

  const handleNewAutomation = useCallback(() => {
    if (chatLoading) return;
    const systemMessage =
      `<camelai system message>I'd like to create a new scheduled automation. ` +
      `Help me set one up - ask me what I want it to do, how often it should run, ` +
      `and what kind of automation makes sense (scheduled agent task vs deterministic workflow). ` +
      `When ready, create it for me using your automation tools.</camelai system message>`;

    submit(
      {
        intent: "createThreadAndStart",
        clientBuildId: APP_BUILD_ID,
        initialTitle: "New automation",
        firstMessage: systemMessage,
      },
      { method: "post", action: "/chat" },
    );
  }, [chatLoading, submit]);

  const handleRun = useCallback(
    (automation: AutomationListItem) => {
      if (!automation.can_manage) {
        toast.error("You do not have permission to manage this automation");
        return;
      }
      submitAutomation(automation, "run", {}, (items) =>
        items.map((item) =>
          item.id === automation.id && item.kind === automation.kind
            ? {
                ...item,
                last_run_status: item.kind === "workflow" ? "started" : "success",
                runtime_status: "running",
                runtime_message: "Running now",
                runtime_updated_at: Date.now(),
              }
            : item,
        ),
      );
    },
    [submitAutomation],
  );

  const handleToggleEnabled = useCallback(
    (automation: AutomationListItem, enabled: boolean) => {
      if (!automation.can_manage) return;
      submitAutomation(
        automation,
        "setEnabled",
        { enabled: String(enabled) },
        (items) =>
          items.map((item) =>
            item.id === automation.id && item.kind === automation.kind
              ? { ...item, enabled }
              : item,
          ),
      );
    },
    [submitAutomation],
  );

  const handleOpen = useCallback(
    (automation: AutomationListItem) => {
      if (automation.kind === "agent_task") {
        if (!automation.thread_id || automation.thread_exists === false) {
          toast.error("Original thread is unavailable");
          return;
        }
        navigate(`/chat/${automation.thread_id}`);
        return;
      }

      const systemMessage =
        `<camelai system message>I'd like to work on the automation "${automation.name}". ` +
        `Automation id: ${automation.id}. ` +
        `Its source lives at /workspace/.camelai/automations/${automation.id}.js. ` +
        `Its current schedule is ${automation.cron_expression} UTC. ` +
        `Read it first, then ask me what I want to change.</camelai system message>`;

      submit(
        {
          intent: "createThreadAndStart",
          clientBuildId: APP_BUILD_ID,
          initialTitle: `Edit: ${automation.name}`,
          firstMessage: systemMessage,
        },
        { method: "post", action: "/chat" },
      );
    },
    [navigate, submit],
  );

  const handleSelect = useCallback(
    (automation: AutomationListItem) => {
      setSearchParams({ selected: automation.id });
    },
    [setSearchParams],
  );

  const handleClosePanel = useCallback(() => {
    setSearchParams({});
  }, [setSearchParams]);

  const handleLoadMoreRuns = useCallback(() => {
    if (!selectedRunsKey || !runState || runState.key !== selectedRunsKey) return;
    if (runState.cursor == null || runsLoading) return;
    loadRunsPage(selectedRunsKey, runState.cursor, "more");
  }, [selectedRunsKey, runState, runsLoading, loadRunsPage]);

  const startRename = useCallback((automation: AutomationListItem) => {
    if (!automation.can_manage) {
      toast.error("You do not have permission to manage this automation");
      return;
    }
    setRenaming({
      id: automation.id,
      kind: automation.kind,
      value: automation.name,
      original: automation,
    });
  }, []);

  const commitRename = useCallback(() => {
    if (!renaming) return;
    const name = renaming.value.trim();
    if (!name || name === renaming.original.name) {
      setRenaming(null);
      return;
    }
    setRenaming(null);
    submitAutomation(
      renaming.original,
      "rename",
      { name },
      (items) =>
        items.map((item) =>
          item.id === renaming.id && item.kind === renaming.kind
            ? { ...item, name }
            : item,
        ),
    );
  }, [renaming, submitAutomation]);

  const confirmDelete = useCallback(() => {
    const automation = deleteState?.automation;
    if (!automation) return;
    setDeleteState(null);
    submitAutomation(automation, "delete", {}, (items) =>
      items.filter(
        (item) => item.id !== automation.id || item.kind !== automation.kind,
      ),
    );
  }, [deleteState, submitAutomation]);

  const runsMatch = runState != null && runState.key === selectedRunsKey;
  const panelRuns = runsMatch ? runState.runs : [];
  const panelHasMoreRuns = runsMatch && runState.cursor != null;
  // Until the first page for the freshly selected automation lands, show the
  // skeleton rather than a flash of "No previous runs" or the prior list.
  const panelRunsLoading: RunsLoadingState = runsMatch ? runsLoading : "page";

  return (
    <>
      <div className="flex h-full min-h-0">
        <section className="flex min-w-0 flex-1 flex-col">
          <PageHeader breadcrumbs={[{ label: "Automations" }]} />
          <div className="min-h-0 flex-1">
            <ScrollArea className="h-full">
              <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h1 className="text-2xl font-semibold">Automations</h1>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Scheduled chats and workflows running on your behalf.
                    </p>
                  </div>
                  <Button type="button" onClick={handleNewAutomation}>
                    <Plus />
                    New automation
                  </Button>
                </div>

                <div className="relative mt-6">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={searchRef}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search automations..."
                    className="h-9 pl-9 pr-8"
                  />
                  {query ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="absolute right-1.5 top-1/2 -translate-y-1/2"
                      aria-label="Clear search"
                      onClick={() => setQuery("")}
                    >
                      <X />
                    </Button>
                  ) : null}
                </div>

                <AutomationList
                  automations={filteredAutomations}
                  filteredCount={automations.length}
                  searchQuery={query.trim()}
                  selectedId={selectedId}
                  renaming={renaming}
                  onRenameValueChange={(value) =>
                    setRenaming((current) =>
                      current ? { ...current, value } : current,
                    )
                  }
                  onCommitRename={commitRename}
                  onCancelRename={() => setRenaming(null)}
                  onSelect={handleSelect}
                  onRun={handleRun}
                  onOpen={handleOpen}
                  onStartRename={startRename}
                  onDelete={(automation) => setDeleteState({ automation })}
                  onNewAutomation={handleNewAutomation}
                />
              </div>
            </ScrollArea>
          </div>
        </section>

        <aside
          className={cn(
            "hidden shrink-0 overflow-hidden border-l bg-background transition-[width] duration-200 ease-out lg:flex lg:flex-col",
            selectedAutomation ? "w-[36rem]" : "w-0",
          )}
          aria-hidden={!selectedAutomation}
        >
          {selectedAutomation ? (
            <AutomationPanel
              automation={selectedAutomation}
              now={now}
              runs={panelRuns}
              runsLoading={panelRunsLoading}
              hasMoreRuns={panelHasMoreRuns}
              onLoadMoreRuns={handleLoadMoreRuns}
              onClose={handleClosePanel}
              onRun={handleRun}
              onOpen={handleOpen}
              onToggleEnabled={handleToggleEnabled}
              onStartRename={startRename}
              onDelete={(automation) => setDeleteState({ automation })}
            />
          ) : null}
        </aside>
      </div>

      <Sheet
        open={showMobileSheet}
        onOpenChange={(open) => {
          if (!open) handleClosePanel();
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          className="w-[90vw] max-w-none p-0 sm:max-w-none lg:hidden"
        >
          <SheetTitle className="sr-only">Automation details</SheetTitle>
          <SheetDescription className="sr-only">
            View and manage the selected automation.
          </SheetDescription>
          {selectedAutomation ? (
            <AutomationPanel
              automation={selectedAutomation}
              now={now}
              runs={panelRuns}
              runsLoading={panelRunsLoading}
              hasMoreRuns={panelHasMoreRuns}
              onLoadMoreRuns={handleLoadMoreRuns}
              onClose={handleClosePanel}
              onRun={handleRun}
              onOpen={handleOpen}
              onToggleEnabled={handleToggleEnabled}
              onStartRename={startRename}
              onDelete={(automation) => setDeleteState({ automation })}
            />
          ) : null}
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={Boolean(deleteState)}
        onOpenChange={(open) => {
          if (!open) setDeleteState(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete &quot;{deleteState?.automation.name ?? "automation"}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteState?.automation.kind === "workflow"
                ? "This automation will stop running and its history will be removed. The automation source will no longer appear in your workspace automation files."
                : "This automation will stop running and its history will be removed. The underlying chat thread will not be deleted."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              Delete automation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
