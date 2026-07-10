import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading placeholder for the app's main content area (chat welcome screen).
 *
 * This is rendered as the Suspense fallback while deferred Durable Object RPC
 * and queries resolve on initial load — the workspace migration gate in
 * `_app.tsx` and the model picker / billing / chat-group bundle in the chat
 * welcome loader. Because those are streamed instead of awaited, the app shell
 * (sidebar + this skeleton) flushes to the browser as soon as auth resolves,
 * so a slow cold Durable Object no longer shows a blank screen.
 *
 * Two variants mirror the two new-chat screens so the swap to live content is
 * visually minimal:
 * - `welcome`: greeting + composer + section rows (`WelcomeScreen` without a
 *   group, inside `Chat`'s scrollable welcome container).
 * - `group`: `ChatTabBar` strip, then the group new-chat header, composer,
 *   and "Recently used in this group" sections (`GroupNewChatHeader` +
 *   `RecentlyUsedInGroup`).
 */
export function AppMainSkeleton({
  variant = "welcome",
}: {
  variant?: "welcome" | "group";
}) {
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      aria-busy="true"
      aria-label="Loading"
    >
      {variant === "group" ? (
        // Matches the ChatTabBar strip shown above a group's new-chat screen.
        <div className="shrink-0 [--safe-area-padding-top:5px] pt-safe">
          <div className="flex h-9 items-end gap-2 bg-muted/20 pl-2 pr-1 shadow-[inset_0_-1px_0_0_var(--border)]">
            <div className="mr-1 flex h-9 shrink-0 items-center pb-0.5 md:hidden">
              <Skeleton className="size-7" />
            </div>
            <Skeleton className="mb-1.5 h-6 w-44 rounded-md" />
          </div>
        </div>
      ) : (
        // Matches the welcome screen's mobile header row height.
        <div className="flex h-11 shrink-0 items-center border-b bg-muted/20 px-2 md:hidden">
          <Skeleton className="size-7" />
        </div>
      )}
      {/* Matches Chat's welcome container: top-aligned scroll area. */}
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 py-8">
        {variant === "group" ? <GroupNewChatSkeleton /> : <WelcomeSkeleton />}
      </div>
    </div>
  );
}

/** Mirrors `WelcomeScreen` without a group: greeting, composer, section rows. */
function WelcomeSkeleton() {
  return (
    <div className="w-full max-w-5xl space-y-10">
      {/* Greeting: centered serif heading + subtitle. */}
      <div className="mb-8 flex flex-col items-center gap-3">
        <Skeleton className="h-9 w-72 md:h-10" />
        <Skeleton className="h-5 w-64" />
      </div>

      {/* Composer. */}
      <Skeleton className="h-32 w-full rounded-2xl" />

      {/* Recent chats row. */}
      <section className="space-y-4">
        <SectionHeaderSkeleton />
        <div className="flex gap-4 overflow-hidden pb-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton
              key={index}
              className="h-[116px] w-[260px] shrink-0 rounded-xl"
            />
          ))}
        </div>
      </section>

      {/* Apps row. */}
      <section className="space-y-4">
        <SectionHeaderSkeleton />
        <div className="flex gap-4 overflow-hidden pb-2">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton
              key={index}
              className="aspect-video w-[260px] shrink-0 rounded-xl"
            />
          ))}
        </div>
      </section>

      {/* Connections: tool pills + dashed "add connection" trigger. */}
      <section className="space-y-4">
        <SectionHeaderSkeleton />
        <div className="flex flex-wrap gap-3">
          <Skeleton className="h-10 w-32 rounded-lg" />
          <Skeleton className="h-10 w-28 rounded-lg" />
          <Skeleton className="h-10 w-36 rounded-lg" />
          <Skeleton className="h-10 w-28 rounded-lg" />
        </div>
        <div className="h-11 w-full rounded-lg border border-dashed border-muted-foreground/25" />
      </section>

      {/* Starter prompts grid. */}
      <section className="space-y-4">
        <SectionHeaderSkeleton />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-[84px] w-full rounded-xl" />
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * Mirrors `WelcomeScreen` with a group: centered "New chat in <group>"
 * header, composer, and the "Recently used in this group" subsections
 * (projects & connections tags, attachments, transcripts).
 */
function GroupNewChatSkeleton() {
  return (
    <div className="w-full max-w-3xl space-y-10">
      {/* Group header: avatar + "New chat in" eyebrow + group name. */}
      <div className="flex items-center justify-center gap-3">
        <Skeleton className="size-10 rounded-[28%]" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-48 md:h-8" />
        </div>
      </div>

      {/* Composer. */}
      <Skeleton className="h-32 w-full rounded-2xl" />

      {/* Recently used in this group. */}
      <section className="space-y-6">
        <div className="border-b border-border pb-3">
          <Skeleton className="h-3 w-48" />
        </div>

        {/* Projects & connections tags. */}
        <div className="space-y-3">
          <Skeleton className="h-3 w-36" />
          <div className="flex flex-wrap gap-3">
            <Skeleton className="h-10 w-32 rounded-lg" />
            <Skeleton className="h-10 w-40 rounded-lg" />
            <Skeleton className="h-10 w-28 rounded-lg" />
          </div>
        </div>

        {/* Attachments. */}
        <div className="space-y-3">
          <Skeleton className="h-3 w-24" />
          <div className="flex flex-wrap gap-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-[88px] w-[88px] rounded-lg" />
            ))}
          </div>
        </div>

        {/* Transcripts. */}
        <div className="space-y-3">
          <Skeleton className="h-3 w-24" />
          <div className="flex flex-wrap gap-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton
                key={index}
                className="h-[110px] w-[200px] rounded-xl"
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

/** Mirrors `SectionHeader`: xs uppercase title left, "View all" link right. */
function SectionHeaderSkeleton() {
  return (
    <div className="flex items-center justify-between">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-4 w-16" />
    </div>
  );
}
