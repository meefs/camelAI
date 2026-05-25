# Collapsed Agent Work — Implementation Plan

**May 25, 2026**

---

## Overview

When an agent finishes a turn, collapse every tool call and thinking block in that turn into a single low-profile summary line:

```
worked for 2:18 · 14 steps · show work  ›
```

The agent's final natural-language reply (its text message) stays visible below a hairline. Clicking the summary line re-expands the full trace inline. The collapse is the resting state of any finished assistant turn.

The trigger is the Pi runtime event `turn/completed` (already plumbed end-to-end through the chat WebSocket and `applyRuntimeEventToMessages`). The collapse animation runs immediately when that event fires; historical turns loaded from the database render in the collapsed state by default.

**Technical audit note:** keep the implementation centered on the Pi main-agent runtime event. Threads whose `provider` is `codex` still run through the Pi session in `ChatThreadDO` and are rendered through the client-side Codex-style runtime adapter. Do **not** add a second completion event from the Pi subagent helper around `workers/main/src/chat-thread-do.ts:6635`; that code is for nested `Explore`/`Agent` tool execution and is not the visible chat turn boundary.

---

## Visual Anatomy

A finished assistant turn has four stacked elements inside the existing turn group container:

```
┌─── assistant turn (group/turn) ────────────────────────┐
│                                                        │
│  worked for 2:18 · 14 steps · show work    ›   ← (1)   │
│                                                        │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   ← (3)  │ hairline
│                                                        │
│  Here you go! A pink-themed screensaver — open it      │
│  in your browser and enjoy the show.                   │
│                                                        │
│  **What it does:**                                     │
│  - Floating particles — circles and little hearts…     │ ← (4) final
│  - Glow trails — each particle leaves a soft trail     │   message
│  - Sparkles — tiny twinkling stars with a gentle pulse │
│  - Connection lines — nearby particles linked          │
│  - Vignette — a subtle dark edge fade                  │
│                                                        │
│  All pink, all smooth, all animated. The cursor        │
│  auto-hides after a second too…                        │
│                                                        │
└────────────────────────────────────────────────────────┘
```

Expanded (after clicking the summary line):

```
┌─── assistant turn (group/turn) ────────────────────────┐
│                                                        │
│  worked for 2:18 · 14 steps · hide work    ⌄   ← (1)   │
│                                                        │
│  │  ● Reasoning about screensaver design        ← (2) │
│  │  ● Created screensaver.html                        │
│  │  ● Edited screensaver.html (+42 lines)             │
│  │  Thinking…                                         │
│  │  ● Read screensaver.html (1.2 kB)                  │
│  │  …                                                 │
│  │  ● Published screensaver.html → /apps/…            │
│                                                        │
│  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   ← (3)  │ hairline (same)
│                                                        │
│  Here you go! A pink-themed screensaver — open it      │
│  in your browser and enjoy the show.                   │ ← (4) final
│  …                                                     │   message
│                                                        │
└────────────────────────────────────────────────────────┘
```

Elements:

1. **Summary line** — monospace, muted, single click toggles
2. **Trace region** — vertical column of tool-call rows + thinking blocks, indented behind a thin vertical rule (`border-l border-border/40`). Zero height when collapsed, natural height when expanded
3. **Hairline separator** — thin horizontal rule, same muted color as the dots in the summary line, always present in both states
4. **Final message** — agent's natural-language text reply, rendered exactly as today

---

## Lifecycle

```
┌──────────┐  prompt sent   ┌──────────┐  turn/completed   ┌───────────┐
│  idle    │ ─────────────▶ │ running  │ ────────────────▶ │ collapsed │
└──────────┘                └──────────┘                   └─────┬─────┘
                                                                 │
                                                          click summary
                                                                 │
                                                                 ▼
                                                           ┌──────────┐
                                                           │ expanded │
                                                           └─────┬────┘
                                                                 │
                                                          click summary
                                                                 │
                                                                 ▼
                                                           ┌──────────┐
                                                           │ collapsed│
                                                           └──────────┘
```

- **Running** is the rendering we have today: trace streams in live, no summary line. Nothing changes about running-state rendering.
- **Collapsed (default after completion)** is the new state. The moment Pi emits `turn/completed` for the turn, the trace region animates closed and the summary line fades in. Persists across navigation (re-rendered from messages on load).
- **Expanded** is transient — the user can flip back to collapsed freely. Every refresh starts collapsed.

A *previously collapsed* turn stays collapsed when a new turn starts below it.

---

## How "a turn" is identified

The codebase already groups consecutive assistant `Message` objects into a turn inside `src/components/chat-messages-view.tsx:95-139` (`messageGroups`). Each group exposes:

- `messages: Message[]` — every assistant message in the turn (often just one, but compaction/multi-segment streams produce more)
- `actionMessageId: string` — id of the last message in the group; we'll reuse this as the **turn id**
- `isAssistantTurn: boolean`

We use `actionMessageId` as the stable turn identifier for collapse state and for the `turn/completed` event mapping.

The **user prompt that started the turn** is the nearest preceding direct user-authored message, not blindly `visibleMessages[firstIndexOfGroup - 1]`. The adjacent message can be a compact summary, interrupt marker, slash command, local stdout shim, or other operational user-role message. Reuse the existing `isDirectUserMessage` predicate in `chat-messages-view.tsx` and walk backward from the assistant group start to find the fallback-duration anchor; pass it through as `precedingUserMessageId` on each group.

---

## Detecting completion (Pi harness wiring)

### Backend — already exists, small augmentation

`workers/main/src/chat-thread-do.ts:7120` already publishes:

```ts
this.pushPiRuntimeEvent("turn/completed", {
  threadId,
  ...(forkEntryId ? { forkEntryId } : {}),
});
```

The Pi runtime already tracks `this.piTurnStartedAtMs` (line 1638, set on every `turn_start` event) for usage recording. Do **not** reuse that value for the UI duration if Pi can emit more than one internal `turn_start` during a visible agent run, because it can undercount the trace the user watched. Add a separate main-run field, for example `private piAgentStartedAtMs: number = 0;`, set it on `agent_start`, and compute the collapsed-summary duration from `agent_start` → `agent_end`.

```ts
// workers/main/src/chat-thread-do.ts:6864 — on agent_start
this.piAgentStartedAtMs = Date.now();

// workers/main/src/chat-thread-do.ts:7120 — on agent_end, extend payload
const completedAtMs = Date.now();
const turnStartedAtMs = this.piAgentStartedAtMs || this.piTurnStartedAtMs || completedAtMs;
const turnDurationMs = Math.max(0, completedAtMs - turnStartedAtMs);

this.pushPiRuntimeEvent("turn/completed", {
  threadId,
  ...(forkEntryId ? { forkEntryId } : {}),
  completedAtMs,
  turnDurationMs,
});
```

Leave the existing `piTurnStartedAtMs` behavior in place for usage recording in `turn_end`. The only worker-side UI change is enriching the existing main-agent `agent_end` `turn/completed` event. Everything else is client-side.

### Frontend — wire `turn/completed` to per-turn state

`src/components/Chat.tsx:2341-2353` already has the runtime-event handler. Add per-turn metadata capture there, but capture the completing message id **before** calling `applyRuntimeEventToMessages`. The runtime adapter finalizes the assistant message and clears `runtimeStreamingMessageIdsRef.current[threadId]` inside the `turn/completed` branch, so the current plan's `nextStreamingId` lookup after apply will usually be `null`.

```ts
// New ref next to lastCompletedAssistantMessageIdRef (~line 713)
const completedTurnsRef = useRef<Map<string, { durationMs: number; completedAtMs: number }>>(new Map());
const [completedTurns, setCompletedTurns] = useState<
  Map<string, { durationMs: number; completedAtMs: number }>
>(new Map());
const [freshlyCompletedTurnId, setFreshlyCompletedTurnId] = useState<string | null>(null);

// In the existing threadId reset effect:
completedTurnsRef.current = new Map();
setCompletedTurns(new Map());
setFreshlyCompletedTurnId(null);

// Inside the data.type === "runtime_event" branch, before applyRuntimeEventToMessages:
const isTurnCompleted =
  runtimeEvent &&
  typeof runtimeEvent === "object" &&
  (runtimeEvent as { method?: unknown }).method === "turn/completed";
const params = isTurnCompleted
  ? ((runtimeEvent as { params?: { forkEntryId?: unknown; completedAtMs?: unknown; turnDurationMs?: unknown } }).params ?? {})
  : {};
const completingStreamingId = isTurnCompleted
  ? runtimeStreamingMessageIdsRef.current[id] ?? streamingMessageIdRef.current
  : null;

// Then call applyRuntimeEventToMessages as today. After that:
if (isTurnCompleted) {
  const forkEntryId = typeof params.forkEntryId === "string" && params.forkEntryId.trim()
    ? params.forkEntryId.trim()
    : null;
  const completedTurnId = forkEntryId || completingStreamingId;
  const completedAtMs = typeof params.completedAtMs === "number" ? params.completedAtMs : Date.now();
  const durationMs = typeof params.turnDurationMs === "number" ? params.turnDurationMs : 0;
  if (completedTurnId) {
    completedTurnsRef.current.set(completedTurnId, { durationMs, completedAtMs });
    setCompletedTurns(new Map(completedTurnsRef.current));
    setFreshlyCompletedTurnId(completedTurnId);
  }
  lastCompletedAssistantMessageIdRef.current = completedTurnId;
  setStreamingMessageId(null);
  // …existing cleanup…
}
```

Pass `completedTurns` and `freshlyCompletedTurnId` down to `<ChatMessagesView />` so each turn group can look up its precise duration when available, with a derived fallback for historical turns.

### Derived fallback (historical turns)

For turns rendered from messages loaded out of the DB (page refresh, new tab, fork), `completedTurns` is empty. Derive in `chat-messages-view.tsx`:

```ts
const precedingUserMsg = findPrecedingDirectUserMessage(visibleMessages, firstAssistantIndex);
const lastAssistantMsg = group.messages[group.messages.length - 1];
const fallbackDurationMs =
  precedingUserMsg && lastAssistantMsg
    ? Math.max(0, lastAssistantMsg.created_at - precedingUserMsg.created_at)
    : 0;
```

Prefer the live metric when present:

```ts
const completed = completedTurns.get(group.actionMessageId);
const durationMs = completed?.durationMs ?? fallbackDurationMs;
```

The fallback is approximate because persisted Pi messages depend on provider message timestamps and local render timestamps, not a durable turn-duration column. Prefer the live event value whenever it exists; use the fallback only so historical turns do not show `0:00` everywhere.

---

## Counting "steps"

Per the spec, a step = every visible work row in the expanded trace. The baseline rows are `tool_use` blocks and non-empty, non-redacted `thinking` blocks across all assistant messages in the turn. Also count orphan `tool_result`, `teammate_message`, and `task_notification` blocks if the renderer would show them as standalone trace rows; do not double-count `tool_result` blocks attached to an already-counted `tool_use`.

```ts
function countTurnSteps(messages: Message[]): number {
  let count = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    const toolUseIds = new Set(
      message.content
        .filter((block) => block.type === 'tool_use')
        .map((block) => block.id)
    );
    for (const block of message.content) {
      if (block.type === 'tool_use') count += 1;
      else if (block.type === 'thinking' && isVisibleThinkingBlock(block)) count += 1;
      else if (block.type === 'tool_result' && !toolUseIds.has(block.tool_use_id)) count += 1;
      else if (block.type === 'teammate_message' || block.type === 'task_notification') count += 1;
    }
  }
  return count;
}
```

`redacted_thinking`, OpenRouter-redacted thinking, and empty `thinking` blocks do not count (they're filtered out of the visual trace too — mirror `isRedactedThinkingBlock` in `message-bubble.tsx` and `finalizeStreamingMessage` in `src/lib/streaming.ts:286`).

If `countTurnSteps(turn) === 0`, **suppress the summary line entirely** (spec § Edge cases). The turn renders identically to today — just the final text.

---

## Component design

### New component: `TurnSummaryBar`

**Location:** `src/components/turn-summary-bar.tsx`

A small presentational component owning its expanded/collapsed state and rendering the summary line, the trace slot, and the hairline.

```tsx
"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface TurnSummaryBarProps {
  durationMs: number;
  stepCount: number;
  /** Trace UI rendered when expanded (tool calls + thinking). */
  children: ReactNode;
  /** Optional initial state (default: collapsed). */
  defaultExpanded?: boolean;
  /** Mount expanded, then collapse on the next frame for the live completion transition. */
  animateOnMount?: boolean;
  /** Clear the parent's one-shot animation marker after the auto-collapse is scheduled. */
  onAutoCollapseScheduled?: () => void;
}

export function TurnSummaryBar({
  durationMs,
  stepCount,
  children,
  defaultExpanded = false,
  animateOnMount = false,
  onAutoCollapseScheduled,
}: TurnSummaryBarProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded || animateOnMount);
  const timeLabel = formatTurnDuration(durationMs);
  const stepLabel = `${stepCount} step${stepCount === 1 ? "" : "s"}`;
  const toggleLabel = isExpanded ? "hide work" : "show work";
  const a11yLabel = `${isExpanded ? "Hide" : "Show"} work — ${stepLabel}, ${formatTurnDurationForScreenReader(durationMs)}`;

  useEffect(() => {
    if (!animateOnMount) return;
    const id = requestAnimationFrame(() => {
      setIsExpanded(false);
      onAutoCollapseScheduled?.();
    });
    return () => cancelAnimationFrame(id);
  }, [animateOnMount, onAutoCollapseScheduled]);

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-label={a11yLabel}
          className={cn(
            "turn-summary group/turn-summary flex w-full items-center gap-1.5 py-1 text-left",
            "font-mono text-xs cursor-pointer",
            "text-muted-foreground/60 hover:text-foreground transition-colors duration-150",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50 rounded",
            "motion-reduce:transition-none",
          )}
        >
          <span>worked for</span>
          <span className="text-muted-foreground/80">{timeLabel}</span>
          <span className="text-muted-foreground/30">·</span>
          <span className="text-muted-foreground/80">{stepLabel}</span>
          <span className="text-muted-foreground/30">·</span>
          <span>{toggleLabel}</span>
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground/40 transition-transform",
              "duration-[250ms] ease-out",
              "motion-reduce:transition-none",
              isExpanded && "rotate-90",
            )}
            aria-hidden="true"
          />
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent
        className={cn(
          "overflow-hidden",
          "data-[state=open]:animate-turn-trace-down",
          "data-[state=closed]:animate-turn-trace-up",
          "motion-reduce:animate-none",
        )}
      >
        <div className="ml-1 border-l border-border/40 pl-4 py-2 space-y-1">
          {children}
        </div>
      </CollapsibleContent>

      <hr className="my-2 border-t border-border/40" />
    </Collapsible>
  );
}

function formatTurnDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatTurnDurationForScreenReader(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} seconds`;
  if (seconds === 0) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"} ${seconds} second${seconds === 1 ? "" : "s"}`;
}
```

#### Styling notes

- **Monospace**: `font-mono` resolves to `var(--font-mono) = var(--font-geist-mono)` (`src/styles/globals.css:98`). Already loaded.
- **Two muted tiers**: `text-muted-foreground/60` for words ("worked for", "show work"), `text-muted-foreground/80` for the values (`2:18`, `14 steps`), `text-muted-foreground/30` for the `·` separators. This produces the "two tiers of muted" effect called for in the spec.
- **Hover**: text color transitions from `text-muted-foreground/60` to `text-foreground`. No background, no border, no underline.
- **Hairline separator**: a single `<hr>` with `border-t border-border/40` matching the dot color used inside the summary line and the existing thinking-block left-rule. Persistent — never animates.

### New animation: `animate-turn-trace-down` / `animate-turn-trace-up`

The existing `animate-collapsible-down` (250ms ease-out) is faster than the spec asks for (~350–400ms). Add a longer-duration sibling animation specifically for the turn trace so the existing one keeps its tighter feel everywhere else.

**File:** `src/styles/globals.css`

```css
/* Just below the existing --animate-collapsible-down / -up lines (~line 137) */
--animate-turn-trace-down: collapsible-down 0.36s ease-out;
--animate-turn-trace-up: collapsible-up 0.32s ease-in forwards;
```

Reuses the existing `@keyframes collapsible-down` / `collapsible-up` (`globals.css:344-364`) — they already animate height from 0 to `var(--radix-collapsible-content-height)` plus opacity. No new keyframes required.

The chevron rotation timing (`duration-[250ms]`) is slightly faster than the height transition, which matches the spec ("Chevron rotation: runs in parallel with the height transition, slightly faster (~250 ms) so it feels responsive").

---

## Wiring into the message tree

Two integration points: `chat-messages-view.tsx` (decide which turns are eligible, surface duration + step count) and `message-bubble.tsx` (suppress the inline-rendered tools/thinking when the parent has wrapped them in a summary bar).

### `src/components/chat-messages-view.tsx`

Extend the props and the `messageGroups` memo to pass turn metadata, then wrap each finished assistant turn in `TurnSummaryBar`.

```ts
// New prop on ChatMessagesViewProps
completedTurns: Map<string, { durationMs: number; completedAtMs: number }>;
activeTurnActionMessageId: string | null; // = activeAssistantMessageId for the running turn
freshlyCompletedTurnId: string | null;
onFreshlyCompletedTurnAnimationScheduled: () => void;
```

In `messageGroups`, capture the preceding direct user message:

```ts
const copyContent = isAssistantTurn
  ? messages
      .map((message) => userFacingContentToString(message.content))
      .filter(Boolean)
      .join('\n\n')
  : undefined;

let precedingUserMessageId: string | undefined;
if (isAssistantTurn) {
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const candidate = visibleMessages[previous];
    if (isDirectUserMessage(candidate)) {
      precedingUserMessageId = candidate.id;
      break;
    }
  }
}
groups.push({
  key: …,
  messages,
  isAssistantTurn,
  actionMessageId,
  copyContent,
  precedingUserMessageId,
});
```

This replaces the current `reverse().find(Boolean)` copy-content behavior for assistant groups. Once final text can be rendered from more than one assistant message, the action row should copy the whole visible final answer, not only the latest non-empty chunk.

Where each assistant turn renders today (the `messageGroups.map(...)` at line 165), introduce a helper that decides whether to wrap:

```tsx
const isActiveTurn = group.actionMessageId === activeTurnActionMessageId;
const stepCount = isAssistantTurn ? countTurnSteps(group.messages) : 0;
const shouldShowSummary = isAssistantTurn && !isActiveTurn && stepCount > 0;

// Look up duration: live first, derive as fallback
const completed = completedTurns.get(group.actionMessageId);
const userMsg = group.precedingUserMessageId
  ? visibleMessages.find(m => m.id === group.precedingUserMessageId)
  : undefined;
const lastAssistantMsg = group.messages[group.messages.length - 1];
const fallbackDurationMs = userMsg && lastAssistantMsg
  ? Math.max(0, lastAssistantMsg.created_at - userMsg.created_at)
  : 0;
const durationMs = completed?.durationMs ?? fallbackDurationMs;
```

When `shouldShowSummary` is true, render the turn as:

```tsx
<TurnSummaryBar
  durationMs={durationMs}
  stepCount={stepCount}
  animateOnMount={group.actionMessageId === freshlyCompletedTurnId}
  onAutoCollapseScheduled={onFreshlyCompletedTurnAnimationScheduled}
>
  {/* Trace: re-render each message but hide its final text block */}
  {group.messages.map((msg) => (
    <MessageBubble
      key={msg.id}
      message={msg}
      …existingProps…
      renderMode="trace-only"          // NEW prop — see below
      showActionRow={false}
    />
  ))}
</TurnSummaryBar>

{/* Final-message-only render below the hairline.
    Build a synthetic view message from all visible final-output blocks
    across the group so multi-message turns do not lose earlier natural
    language chunks, and so the action row remains anchored to actionMessageId. */}
{finalOutputMessage ? (
  <MessageBubble
    key={`${group.actionMessageId}-final`}
    message={finalOutputMessage}
    …existingProps…
    renderMode="final-text-only"        // NEW prop
    showActionRow
    actionCopyContent={group.copyContent || undefined}
  />
) : null}
```

`finalOutputMessage` should be a view-only object, not written back to message state:

```ts
const finalOutputMessage = buildFinalOutputMessageView(group.messages, group.actionMessageId);
```

`buildFinalOutputMessageView` should collect visible `text` blocks and `error` blocks from every assistant message in the group, preserve their order, use the last assistant message's `created_at`, and copy `forkEntryId` from the action message. If there is no visible text/error content, return `null`.

Use `group.copyContent || undefined` for `actionCopyContent`; `MessageBubble` currently treats an empty string as an explicit copy payload, so passing `""` would make error-only final outputs copy nothing instead of falling back to `contentToString(finalOutputMessage.content)`.

DOM/ref detail: avoid duplicating `data-message-id={group.actionMessageId}` on both the trace-only copy and the final-output copy. For collapsed turns, put the normal `data-message-id` and any `assistantMeasureRef` / last-message ref on the final-output wrapper. Trace-only rows can omit `data-message-id` or use a trace-specific data attribute. This keeps scroll measurement, copy/fork targeting, and any future message lookup anchored to the visible final answer rather than to the hidden/expanded trace.

When `shouldShowSummary` is false (running turn, or zero-step turn), keep today's behavior: render each message in the group normally with `renderMode="full"` (the default).

### `src/components/message-bubble.tsx`

Add a `renderMode` prop driving which content blocks render:

```ts
type MessageRenderMode =
  | 'full'              // default — render every block (today's behavior)
  | 'trace-only'        // work blocks only: tool_use/result, thinking, teammate/task updates, errors
  | 'final-text-only';  // text/error blocks only (the agent's reply or final error)
```

Plumb it into `ContentBlockRenderer`, but filter content **before** `hasVisibleContent`, `hasContent`, tool-result indexing, and the existing `forEach` render loop. Filtering only inside the render loop leaves empty wrappers/action-row checks based on the unfiltered message.

```ts
function filterContentForRenderMode(
  content: string | ContentBlock[],
  renderMode: MessageRenderMode,
): string | ContentBlock[] {
  if (renderMode === 'full') return content;
  if (typeof content === 'string') {
    return renderMode === 'final-text-only' ? content : [];
  }
  return content.filter((block) => {
    if (renderMode === 'trace-only') {
      return block.type !== 'text';
    }
    return block.type === 'text' || block.type === 'error';
  });
}
```

`MessageBubbleBase` should compute `displayContent = filterContentForRenderMode(message.content, renderMode)` once, use `displayContent` for `hasVisibleContent`, `hasContent`, `ContentBlockRenderer`, and copy fallback where appropriate. `trace-only` hides the bubble's action row. `final-text-only` keeps the action row only for the group's `actionMessageId` so the user still gets the standard message controls under the final answer.

Update the `memo` equality function at the bottom of `message-bubble.tsx` to include `prev.renderMode === next.renderMode`; otherwise switching a message from `full` to `trace-only`/`final-text-only` can be skipped when the message object identity is unchanged.

The streaming indicator (`showStreamingIndicator`) is irrelevant for collapsed turns because by definition `isActiveTurn === false`, so it stays its current value of `false`.

#### Edge case: assistant turn with no text reply

Some turns (e.g., the agent only executes tools and waits for the user) have no text block. In this case each `final-text-only` `MessageBubble` returns `null`, which is fine — the summary bar + trace + hairline still represent the finished turn. To avoid an orphan hairline:

- In `TurnSummaryBar`, accept a `hideHairline?: boolean` prop and pass `true` only when there is no final text **and** no final error block.
- Or simpler: always render the final-text-only pass and let `MessageBubble` return `null` for messages with no text/error content. Do not skip it based only on visible text, because tool-backed failures need their error block below the hairline.

Pick the simpler approach (always render the hairline inside `TurnSummaryBar`). Spec doesn't explicitly call this out, and an extra hairline below a turn with no final reply is harmless.

---

## Animations — exact specs

| Element                         | Value                                      |
| ------------------------------- | ------------------------------------------ |
| Trace height (open)             | `0.36s ease-out` (new `--animate-turn-trace-down`) |
| Trace height (close)            | `0.32s ease-in forwards` (new `--animate-turn-trace-up`) |
| Trace opacity                   | inherits from existing keyframes (0 → 1)   |
| Chevron rotation                | `transition-transform duration-[250ms] ease-out` |
| Summary text color              | `transition-colors duration-150`           |
| Reduced-motion                  | `motion-reduce:animate-none` on the trace and `motion-reduce:transition-none` on summary/chevron transitions |

### Running → collapsed transition

When `turn/completed` fires:

1. The turn's `isActiveTurn` flips to `false`.
2. `chat-messages-view.tsx` re-renders the turn through `TurnSummaryBar` (`defaultExpanded={false}`).
3. Radix mounts `<CollapsibleContent>` already in the closed state — no animation runs (it didn't transition from "open").
4. The user perceives: the streaming trace they were watching is replaced by the summary line + final answer.

The spec describes this as: "the trace doesn't just *vanish*; it gracefully resolves into its summary." With a hard swap this could feel abrupt. To soften it:

- Set `animateOnMount={true}` only for the turn that **just** completed during this session (track in `Chat.tsx` as `freshlyCompletedTurnId`). `TurnSummaryBar` should initialize as open for that render, then schedule a `requestAnimationFrame(() => setExpanded(false))` so the trace animates from open → closed even though it was never user-opened.

**Recommended:** keep the implementation simple — render fresh-completed turns with `animateOnMount` and let an effect collapse them on the next frame. Implementation in `TurnSummaryBar`:

```tsx
interface TurnSummaryBarProps {
  …
  /** If true, mount expanded then animate to collapsed on the next frame (used for live transitions). */
  animateOnMount?: boolean;
  onAutoCollapseScheduled?: () => void;
}

const [isExpanded, setIsExpanded] = useState(defaultExpanded || animateOnMount);

useEffect(() => {
  if (animateOnMount) {
    const id = requestAnimationFrame(() => {
      setIsExpanded(false);
      onAutoCollapseScheduled?.();
    });
    return () => cancelAnimationFrame(id);
  }
}, [animateOnMount, onAutoCollapseScheduled]);
```

`chat-messages-view.tsx` passes `animateOnMount` when `group.actionMessageId === freshlyCompletedTurnId`. Clear that parent flag via `onAutoCollapseScheduled` after the RAF is scheduled so normal re-renders do not replay the collapse animation. The `requestAnimationFrame` is sufficient — Radix needs one paint cycle to register the "open" state before the transition to "closed" produces an animation.

---

## File-by-file change list

| File | Change |
| --- | --- |
| `src/components/turn-summary-bar.tsx` | **New.** The summary line + hairline + collapsible trace slot. |
| `src/components/chat-messages-view.tsx` | Add `completedTurns`, `activeTurnActionMessageId`, `freshlyCompletedTurnId`, and `onFreshlyCompletedTurnAnimationScheduled` props. Extend `messageGroups` to track nearest preceding direct user message. Wrap finished assistant turns in `<TurnSummaryBar>` and render a synthetic `final-text-only` view message below the hairline. Suppress wrapping for turns with zero steps. |
| `src/components/message-bubble.tsx` | Add `renderMode: 'full' \| 'trace-only' \| 'final-text-only'` prop. Filter display content before visibility checks and before `ContentBlockRenderer`. `trace-only` hides text + action row; `final-text-only` hides tool/thinking/task blocks. Include `renderMode` in the memo comparer. |
| `src/components/Chat.tsx` | Add `completedTurnsRef` + `completedTurns` state. In the `turn/completed` runtime-event branch, capture the completing id before `applyRuntimeEventToMessages`; key metadata by `params.forkEntryId || completingStreamingId`, not by post-apply `nextStreamingId`. Also track `freshlyCompletedTurnId` to drive the open→closed mount animation for the live transition. Pass completion props and `activeTurnActionMessageId = activeAssistantMessageId` to `<ChatMessagesView />`. |
| `src/styles/globals.css` | Add `--animate-turn-trace-down: collapsible-down 0.36s ease-out;` and `--animate-turn-trace-up: collapsible-up 0.32s ease-in forwards;` next to the existing collapsible animations (around line 137). |
| `workers/main/src/chat-thread-do.ts` | Main Pi path only: add a separate `piAgentStartedAtMs` set on `agent_start`, then include `completedAtMs` + `turnDurationMs` in the existing `agent_end` `turn/completed` event. Do not emit `turn/completed` from the subagent handler around line 6635. |
| `src/lib/turn-utils.ts` | **New.** `isRedactedThinkingBlock(...)` / `isVisibleThinkingBlock(...)`, `countTurnSteps(messages)`, `formatTurnDuration(ms)`, `formatTurnDurationForScreenReader(ms)`, `hasFinalOutput(messages)` (visible text or final error), `buildFinalOutputMessageView(...)`, and `filterContentForRenderMode` or equivalent exported helpers if they need to be shared. Pull these out so `chat-messages-view.tsx`, `message-bubble.tsx`, and `turn-summary-bar.tsx` share behavior and so they're unit-testable. |

---

## Components & dependencies used

Existing shadcn / app components — **no new dependencies needed**:

- `Collapsible` / `CollapsibleTrigger` / `CollapsibleContent` from `@/components/ui/collapsible` (radix-ui under the hood)
- `ChevronRight` from `lucide-react`
- `cn` from `@/lib/utils`
- `font-mono` Tailwind class → Geist Mono (already loaded, `src/styles/globals.css:98`)
- Existing animation keyframes `collapsible-down` / `collapsible-up` (`globals.css:344-364`) — reused with new duration variables
- Existing `MessageBubble` + `ContentBlockRenderer` (extended, not replaced)
- Existing `ToolCall` + `ThinkingBlock` components (rendered inside the trace region unchanged)

---

## Edge cases & behavioral notes

- **Zero work rows**: `shouldShowSummary === false`. Turn renders identically to today (just the text reply, no summary, no hairline).
- **One-step turn**: renders `1 step` (with no `s`).
- **Sub-minute runs**: `0:14` — keeps the `m:ss` rhythm steady (spec § Edge cases).
- **>1 hour runs**: `1:23:45` — `h:mm:ss`. Hours bucket only appears when needed.
- **Streaming (not yet completed)**: existing rendering. `isActiveTurn === true` short-circuits `shouldShowSummary`.
- **New turn underneath a previously collapsed turn**: each turn manages its own collapse state in `TurnSummaryBar`'s local `useState`. Starting a new turn doesn't disturb the collapsed state above.
- **Multiple expanded turns at once**: allowed. No coordination between `TurnSummaryBar` instances.
- **Page refresh / loaded from DB**: `completedTurns` is empty. Every finished turn renders collapsed via the fallback duration derived from message timestamps. The accuracy gap is acceptable because exact historical duration is explicitly out of scope.
- **Errored turns**: an `error` block renders in the expanded trace and, in `final-text-only`, below the hairline as the final failure state. It does not by itself force a summary; error-only turns with no work rows show no summary.
- **AskUserQuestion turns**: the question widget renders out-of-band in the composer area; the tool call appears in the trace as it does today. No special handling.
- **Compaction**: compaction renders as a `<CompactSummaryCard />` between turns (outside the assistant turn group). Not affected.
- **Fork from a collapsed turn**: forking is driven by `forkEntryId` on the message; it works identically because the synthetic final-output view copies `forkEntryId` from the group's action message and keeps the action row anchored to `actionMessageId`.

---

## Testing

### Manual verification

1. Send a short prompt that triggers one tool call (e.g., "read package.json"). After the agent responds, verify the turn collapses to `worked for 0:0X · N steps · show work ›`, hairline, then the final text, where `N` matches the rows shown when expanded.
2. Send a long-running prompt (`use 10+ tool calls`). Watch the live trace stream as today. The moment the final text appears, the trace should animate closed and the summary should slide into view above the hairline.
3. Click `show work` — trace expands smoothly over ~360ms, chevron rotates, label flips to `hide work`. Click again — collapses.
4. Hover the summary line — text brightens from muted to foreground with no underline or background.
5. Tab-focus the summary line — focus ring appears. Press Enter / Space — toggles.
6. Send a prompt that the agent answers without any tools (e.g., "what's 2+2"). No summary line should appear; just the text reply.
7. Refresh the page on a thread with several finished turns. All should render in the collapsed state.
8. Fork a turn — collapse state of all other turns is preserved; new branch starts collapsed once it completes.
9. With macOS "Reduce motion" on — no height animation, but the toggle still works instantly.
10. With a turn that has only thinking blocks and a text reply (no tool_use), confirm `stepCount` reflects only the thinking blocks and the summary appears.

### Unit tests

`src/lib/turn-utils.test.ts` (new):

- `countTurnSteps`:
  - Empty messages → 0
  - One message, two tool_use → 2
  - Tool_use + thinking + redacted_thinking + empty thinking → 2 (only tool_use + non-empty thinking count)
  - Tool_use + matching tool_result → 1 (tool result is attached to the tool row)
  - Orphan tool_result / teammate_message / task_notification → counted when rendered as standalone trace rows
  - Multiple messages in turn → sums across all
- `formatTurnDuration`:
  - 0 → `0:00`
  - 14_000 → `0:14`
  - 138_000 → `2:18`
  - 3_600_000 → `1:00:00`
  - 3_725_000 → `1:02:05`
- `formatTurnDurationForScreenReader`:
  - 0 → `0 seconds`
  - 60_000 → `1 minute`
  - 138_000 → `2 minutes 18 seconds`
- `hasFinalOutput`:
  - messages with no text block → false
  - messages with one text block → true
  - messages with empty/system-stripped text → false
  - messages with an error block → true
- `buildFinalOutputMessageView`:
  - combines visible text from multiple assistant messages in order
  - strips empty/system-only text
  - preserves final error blocks
  - copies `forkEntryId`, `id`, and `created_at` from the action message/last assistant message as specified

`tests/turn-summary-bar.test.tsx` (new, Vitest + Testing Library):

- Renders the summary line with formatted time and step count.
- Click toggles expanded; aria-label flips accordingly.
- `animateOnMount={true}` → expanded on first render, then collapses on next frame.
- Step count of 1 reads `1 step` (singular).
- Reduced motion: `motion-reduce:animate-none` class present on trace.

`tests/chat-messages-view.test.tsx` (extend if it exists, otherwise new):

- A finished assistant turn with 2 tool calls renders one `TurnSummaryBar` and a final-answer region below the hairline.
- A multi-message assistant turn with text in more than one assistant message preserves all visible text below the hairline.
- A multi-message assistant turn whose last assistant chunk has no text still shows one action row on the final-answer region.
- A streaming turn (`isActiveTurn` true) does **not** render a summary bar.
- A finished turn with zero steps does **not** render a summary bar.
- Duration prefers `completedTurns.get(id)` over the derived fallback.
- Completion metadata keyed by `forkEntryId` still matches the rendered `actionMessageId`.

### Worker tests

`workers/main/tests/chat-thread-pi-turn-completed.test.ts` (new or extend):

- After a Pi turn completes, the published `turn/completed` event params include `completedAtMs` and `turnDurationMs >= 0`.
- `turnDurationMs` is based on the main `agent_start` → `agent_end` window, not the nested/subagent `turn_end` handler and not a later overwritten internal `turn_start`.

### Test commands

```bash
bun run typecheck
bun run test:run -- src/lib/turn-utils.test.ts tests/turn-summary-bar.test.tsx tests/chat-messages-view.test.tsx
bun run test:workers -- workers/main/tests/chat-thread-pi-turn-completed.test.ts
```

---

## Implementation order

1. **`src/lib/turn-utils.ts`** — pure helpers + their tests. Lays the foundation, no UI dependencies.
2. **Worker change in `chat-thread-do.ts`** — add `completedAtMs` + `turnDurationMs` to the existing main Pi `turn/completed` event. Verify with worker tests.
3. **`src/components/turn-summary-bar.tsx`** + animation variables in `globals.css`. Visually verify in Storybook-style isolated render (or a route stub) before wiring.
4. **`src/components/message-bubble.tsx`** — `renderMode` prop. Verify each mode renders the correct subset by hitting the existing chat with the wrapper temporarily forced on.
5. **`src/components/chat-messages-view.tsx`** — wrap finished turns in `TurnSummaryBar`. Pipe `completedTurns`, `activeTurnActionMessageId`, and `freshlyCompletedTurnId` through props.
6. **`src/components/Chat.tsx`** — capture `turn/completed` payload into state; track `freshlyCompletedTurnId` for live mount animation.
7. **Manual QA + unit tests + worker tests.**

---

## Out of scope (explicit non-goals)

- Persisting `turn_duration_ms` to the database. Live captures use the precise value; historical turns use the fallback. If a future iteration wants exact historical durations, add a `turn_duration_ms` column on the last assistant message in a turn and have the worker write it when `turn/completed` fires.
- Auto-collapsing previous turns when a new one starts. Each turn manages its own state; only fresh-completed turns animate.
- Hover preview of the trace ("show me the work without clicking") — not in the spec.
- A "copy all tool calls" button on the summary — the existing copy action on the final message already grabs the visible reply.
- Showing per-tool-call timing inside the trace.
- Changing the Codex-adapter in-trace styling. The client already consumes Pi runtime events through the Codex-style runtime-message adapter; this plan only enriches the existing completion event payload.
