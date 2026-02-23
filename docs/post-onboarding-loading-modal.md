# Post-Onboarding Loading Modal

## Problem

After completing onboarding, new users land on `/chat/{threadId}?newThread=1`. The first message to Claude Code takes ~6 seconds to return a response (SDK startup + Anthropic cache time). During this window the user stares at an empty chat with a generic loading indicator. For someone who has never used the product, this feels broken — they have no context for what's happening or what to expect.

## Solution

A fake loading modal. It's a timed animation (~6s) that plays on top of the chat page immediately after onboarding. It is not connected to any real backend state. It does not detect when the agent is "ready." It simply plays its animation sequence, auto-dismisses, and by the time it's gone, Claude's first response is typically streaming in.

The modal uses a "terminal boot sequence" aesthetic — monospace text, dark background, lines appearing one at a time — to reinforce the mental model that camelAI gives you a real persistent machine. Each line teaches the user something about what they have access to.

---

## Design

### Modal (mid-animation, ~3s in)

```
                 ┌────────────────────────────────────────────────────┐
                 │                                                    │
                 │   ◉ Setting up your machine                       │
                 │                                                    │
                 │   › Creating your workspace                       │
                 │                                                    │
                 │   › Mounting persistent filesystem                 │
                 │     Your files live here permanently —             │
                 │     even between sessions                         │
                 │                                                    │
                 │   › Loading onboarding context                     │
                 │     Claude already knows what you                  │
                 │     want to build                                  │
                 │                                                    │
                 │   █              ← blinking cursor                 │
                 │                                                    │
                 │                                                    │
                 │   camelAI                       one-time setup     │
                 │                                                    │
                 └────────────────────────────────────────────────────┘

         ◉ = amber, pulsing              Dialog overlay dims the
         › = muted chevron prefix         chat behind it
         █ = blinking block cursor
```

### Final state (last ~600ms before dismiss)

```
                 ┌────────────────────────────────────────────────────┐
                 │                                                    │
                 │   ◉ Machine ready              ← green, no pulse  │
                 │                                                    │
                 │   › Creating your workspace                       │
                 │   › Mounting persistent filesystem                 │
                 │     Your files live here permanently —             │
                 │     even between sessions                         │
                 │   › Loading onboarding context                     │
                 │     Claude already knows what you want to build    │
                 │   › Enabling live publishing                       │
                 │     Anything you build can go live with            │
                 │     a shareable link                               │
                 │   › Preparing integrations                         │
                 │     Slack, databases, APIs — ready to              │
                 │     connect when you are                           │
                 │   › Installing tools                               │
                 │     Image generation, web search,                  │
                 │     deep research                                  │
                 │   ● Your machine is ready ✓     ← bright, green ✓ │
                 │                                                    │
                 │   camelAI                       one-time setup     │
                 │                                                    │
                 └────────────────────────────────────────────────────┘

         ● = filled dot (not chevron)
         Text is brighter (zinc-100 instead of zinc-300)
         Cursor is gone
```

---

## How It Works (the simple version)

```
Onboarding completes
  │
  ├─ sessionStorage.setItem('showBootModal', '1')
  ├─ sessionStorage.setItem('pendingMessage:newThread', ...)   (existing)
  ├─ navigate('/chat/{threadId}?newThread=1')
  │
  ▼
Chat page mounts
  │
  ├─ Reads 'showBootModal' from sessionStorage → true
  ├─ Removes flag immediately (one-shot)
  ├─ Renders <OnboardingLoadingModal open={true} />
  │
  ├─ Meanwhile, chat does its normal thing underneath:
  │     WebSocket connects → pending message sent → Claude responds
  │
  ▼
Modal plays ~6s animation (purely on a timer)
  │
  ├─ Lines appear one by one (~850ms apart)
  ├─ After last boot line: ready line appears
  ├─ After ready line: 600ms pause
  ├─ onDismiss() → modal closes immediately (standard Dialog dismiss)
  │
  ▼
User sees the chat (Claude's response is typically already streaming)
```

There is no "container ready" detection. The modal is a fixed-duration animation. The chat page boots underneath it in parallel.

---

## Component Architecture

### New files

| File | Purpose |
|------|---------|
| `src/components/onboarding-loading-modal.tsx` | Self-contained modal with timer-driven animation |

Uses the existing `Dialog` from `src/components/ui/dialog.tsx` for portal + overlay + focus trapping.

### Integration point

The modal renders inside `Chat.tsx`. The sessionStorage flag is the only communication between onboarding and the chat page.

---

## Implementation

### Step 1: Set sessionStorage flag in onboarding

**File:** `src/routes/_onboarding.tsx`

In `completeOnboarding()`, add one line right before `navigate()`:

```typescript
// existing: sessionStorage.setItem(PENDING_NEW_THREAD_MESSAGE_KEY, ...)
// existing: clearStoredProgress()
try { sessionStorage.setItem('showBootModal', '1'); } catch {}  // ← ADD
navigate(data.redirectTo || '/chat');                             // existing
```

That's the only change to onboarding.

### Step 2: Read the flag in the chat route

**File:** `src/routes/_app.chat.$id.tsx`

In the `ChatPage` component, read and consume the flag:

```typescript
const [showBootModal] = useState(() => {
  if (typeof window === 'undefined') return false;
  if (!isNewThread) return false;
  const flag = sessionStorage.getItem('showBootModal');
  if (flag) {
    sessionStorage.removeItem('showBootModal');
    return true;
  }
  return false;
});
```

Pass it down to `<Chat>`:

```tsx
<Chat
  // ...existing props
  showBootModal={showBootModal}
/>
```

### Step 3: Render the modal in Chat

**File:** `src/components/Chat.tsx`

Accept the new prop and manage open state:

```typescript
// In the Chat component props type:
showBootModal?: boolean;

// Inside the component:
const [bootModalOpen, setBootModalOpen] = useState(showBootModal ?? false);
```

Render the modal at the bottom of the return JSX (inside the `TooltipProvider`/`ChatPreviewProvider` wrapper, alongside the existing chat content):

```tsx
{bootModalOpen && (
  <OnboardingLoadingModal
    open={bootModalOpen}
    onDismiss={() => setBootModalOpen(false)}
  />
)}
```

### Step 4: Build the modal component

**File:** `src/components/onboarding-loading-modal.tsx`

**Props:**

```typescript
interface OnboardingLoadingModalProps {
  open: boolean;
  onDismiss: () => void;
}
```

**Boot line data (hardcoded):**

```typescript
const BOOT_LINES = [
  { text: 'Creating your workspace' },
  {
    text: 'Mounting persistent filesystem',
    subtitle: 'Your files live here permanently — even between sessions',
  },
  {
    text: 'Loading onboarding context',
    subtitle: 'Claude already knows what you want to build',
  },
  {
    text: 'Enabling live publishing',
    subtitle: 'Anything you build can go live with a shareable link',
  },
  {
    text: 'Preparing integrations',
    subtitle: 'Slack, databases, APIs — ready to connect when you are',
  },
  {
    text: 'Installing tools',
    subtitle: 'Image generation, web search, deep research',
  },
] as const;
```

**Timing constants:**

```typescript
const LINE_INTERVAL_MS = 850;    // time between each boot line appearing
const READY_DELAY_MS = 400;      // pause after last boot line before ready line
const DISMISS_DELAY_MS = 600;    // pause after ready line before closing
```

Total: `(6 × 850) + 400 + 600 = 6,100ms`

**Internal state and timer logic:**

```typescript
const [visibleLines, setVisibleLines] = useState(0);     // 0..6 (boot lines shown)
const [showReadyLine, setShowReadyLine] = useState(false);
```

Single `useEffect` drives the sequence:

```typescript
useEffect(() => {
  if (!open) return;

  let lineCount = 0;

  // Phase 1: Show boot lines one at a time
  const lineTimer = setInterval(() => {
    lineCount++;
    setVisibleLines(lineCount);
    if (lineCount >= BOOT_LINES.length) {
      clearInterval(lineTimer);

      // Phase 2: Show ready line after short pause
      const readyTimer = setTimeout(() => {
        setShowReadyLine(true);

        // Phase 3: Dismiss after user can read it
        const dismissTimer = setTimeout(() => {
          onDismiss();
        }, DISMISS_DELAY_MS);

        return () => clearTimeout(dismissTimer);
      }, READY_DELAY_MS);

      return () => clearTimeout(readyTimer);
    }
  }, LINE_INTERVAL_MS);

  return () => clearInterval(lineTimer);
}, [open, onDismiss]);
```

Note: the `onDismiss` in the dependency array should be stable (wrapped in `useCallback` at the call site or the coding agent should use a ref internally to avoid re-triggering the effect).

**Derived state:**

```typescript
const isComplete = showReadyLine;
```

### Step 5: Modal JSX structure

Use `Dialog` with custom styling to achieve the terminal look within a standard centered modal:

```tsx
<Dialog open={open} modal>
  <DialogPortal>
    <DialogOverlay className="bg-black/80 backdrop-blur-sm" />
    <DialogContent
      showCloseButton={false}
      onPointerDownOutside={(e) => e.preventDefault()}
      onEscapeKeyDown={(e) => e.preventDefault()}
      className={cn(
        // Override default max-width for more terminal breathing room
        "sm:max-w-md",
        // Terminal aesthetic
        "bg-zinc-950 text-zinc-300 ring-zinc-800",
        "font-mono text-[13px] leading-relaxed",
        // Padding
        "p-6",
      )}
    >
      {/* Status header */}
      <div className="flex items-center gap-2.5 mb-5">
        <div
          className={cn(
            "h-2 w-2 rounded-full transition-colors duration-300",
            isComplete
              ? "bg-emerald-400"
              : "bg-amber-400 animate-pulse"
          )}
        />
        <span className="text-zinc-200 text-sm font-medium">
          {isComplete ? 'Machine ready' : 'Setting up your machine'}
        </span>
      </div>

      {/* Boot lines */}
      <div className="space-y-2.5 min-h-[200px]">
        {BOOT_LINES.slice(0, visibleLines).map((line, i) => (
          <div
            key={i}
            className="animate-in fade-in slide-in-from-left-2 duration-300 ease-out"
          >
            <div className="flex items-start gap-2">
              <span className="text-zinc-600 shrink-0">›</span>
              <div>
                <span className="text-zinc-300">{line.text}</span>
                {line.subtitle && (
                  <p className="text-[11px] text-zinc-600 mt-0.5">
                    {line.subtitle}
                  </p>
                )}
              </div>
            </div>
          </div>
        ))}

        {/* Blinking cursor (visible while lines are printing) */}
        {!showReadyLine && visibleLines > 0 && (
          <div className="ml-5 mt-1">
            <div className="h-4 w-1.5 bg-zinc-500 animate-blink" />
          </div>
        )}

        {/* Ready line */}
        {showReadyLine && (
          <div className="animate-in fade-in slide-in-from-left-2 duration-300 ease-out">
            <div className="flex items-start gap-2">
              <span className="text-emerald-400 shrink-0">●</span>
              <span className="text-zinc-100 font-medium">
                Your machine is ready
                <span className="ml-1.5 text-emerald-400">✓</span>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between mt-6 text-[11px] text-zinc-700">
        <span>camelAI</span>
        <span>one-time setup</span>
      </div>
    </DialogContent>
  </DialogPortal>
</Dialog>
```

### Step 6: Blink keyframe

**File:** `src/styles/globals.css`

Add a `blink` keyframe and utility class:

```css
@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
```

Then in the Tailwind `@theme` block (or via arbitrary value in class), expose it so `animate-blink` works. The simplest way is to use the arbitrary value in the class directly: `animate-[blink_1s_steps(1)_infinite]`. If the coding agent prefers a named utility, add to the theme config:

```css
@theme {
  --animate-blink: blink 1s steps(1) infinite;
}
```

Either approach is fine.

---

## Animation Specification

| Element | Animation | Duration / Timing |
|---------|-----------|-------------------|
| Boot line entrance | `fade-in` + `slide-in-from-left-2` | 300ms, ease-out |
| Line interval | timer | 850ms between lines |
| Block cursor | opacity blink | 1s cycle, `steps(1)` (hard on/off, not fade) |
| Status dot (loading) | Tailwind `animate-pulse` | 2s opacity cycle (built-in) |
| Status dot (ready) | `transition-colors` | 300ms swap to emerald |
| Ready line entrance | Same as boot lines | 300ms, ease-out |
| Modal dismiss | Standard Dialog close | Immediate (no fade-out, matches existing modal behavior) |

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Claude responds faster than 6s | Modal still plays its full animation. User sees response when modal dismisses. No harm — they got a nice intro. |
| Claude takes longer than 6s | Modal dismisses on its timer. User sees the normal chat loading state briefly. Acceptable — they now have context for what's happening. |
| User refreshes during modal | `showBootModal` was consumed from sessionStorage on mount. Won't reappear. Normal chat loads. |
| User navigates away and back | Same — flag consumed, no modal. |
| Non-onboarding new threads | Flag is only set by `completeOnboarding()`. Welcome-screen threads never set it. |
| SSR render | `useState` initializer checks `typeof window === 'undefined'` → returns `false`. |

---

## Files Changed

| File | Change |
|------|--------|
| `src/components/onboarding-loading-modal.tsx` | **New.** Self-contained modal with timer-driven boot animation. |
| `src/routes/_onboarding.tsx` | **One line.** `sessionStorage.setItem('showBootModal', '1')` before `navigate()`. |
| `src/routes/_app.chat.$id.tsx` | **Small.** Read + consume `showBootModal` flag, pass as prop to `Chat`. |
| `src/components/Chat.tsx` | **Small.** Accept `showBootModal` prop, manage `bootModalOpen` state, render `<OnboardingLoadingModal>`. |
| `src/styles/globals.css` | **Tiny.** Add `blink` keyframe (or use arbitrary Tailwind value inline, in which case no CSS change needed). |
