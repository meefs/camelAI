# Bug Report UX Improvements — Implementation Plan

Simplify the bug report modal, add voice-to-text input, and render a visible bug report card in the chat history.

---

## Current State

The bug report flow works like this today:

1. User clicks the bug icon (🐛) above the app preview panel in chat
2. A `BugReportDialog` modal opens with **two required fields**: "What did you expect to happen?" and "What actually happened?"
3. On submit, the system captures debug data (DOM snapshot, console logs, screenshot, session recording) from the iframe, uploads everything to R2, and sends a formatted message to the agent
4. The modal shows a success message, auto-dismisses after 1 second, and the agent starts typing
5. **No user message is rendered in the chat UI.** The bug report text is sent to the agent via WebSocket (`wsRef.current.send(...)`) but no local message is added to the `messages` state array — so nothing appears in the chat for the user. The agent sees the message (it's in the JSONL), but the user has no visible record of having submitted a bug report

**Key files:**
- `src/components/bug-report-dialog.tsx` — The modal component (two textarea fields, status display)
- `src/components/Chat.tsx` — `submitBugReport` function (~line 1766), bug report state management, WebSocket send

---

## Changes Overview

Two improvements:

1. **Simplify the modal** — Merge two fields into one optional description field with voice-to-text support
2. **Bug report preview card** — Show a recognizable card in the chat message list (like file upload previews), with a dialog for expanded details

---

## Part 1: Simplify the Bug Report Modal

### Current Layout

```
┌──────────────────────────────────────────────────┐
│  🐛 Report a Bug                                 │
│  Describe the issue with myapp. The agent will   │
│  investigate and fix it.                         │
│                                                  │
│  What did you expect to happen?                  │
│  ┌────────────────────────────────────────────┐  │
│  │ I expected the button to...                │  │
│  │                                            │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  What actually happened?                         │
│  ┌────────────────────────────────────────────┐  │
│  │ Instead, when I clicked it...              │  │
│  │                                            │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│                       [Cancel]  [Submit Bug Report]│
└──────────────────────────────────────────────────┘
```

### Target Layout

```
┌──────────────────────────────────────────────────┐
│  🐛 Report a Bug                                 │
│  Tell us what went wrong — what you expected vs  │
│  what actually happened, steps to reproduce, or  │
│  anything else that might help.                  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ e.g. "I clicked the submit button but      │  │
│  │ nothing happened — I expected it to save    │  │
│  │ my changes"                                 │  │
│  │                                    [🎤]    │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│                       [Cancel]  [Submit Bug Report]│
└──────────────────────────────────────────────────┘
```

When voice recording is active, the mic button area transitions to the VoiceRecorderBar inline:

```
┌──────────────────────────────────────────────────┐
│  🐛 Report a Bug                                 │
│  Tell us what went wrong — what you expected vs  │
│  what actually happened, steps to reproduce, or  │
│  anything else that might help.                  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ (existing text the user already typed)     │  │
│  │                                            │  │
│  │                                            │  │
│  │                                            │  │
│  └────────────────────────────────────────────┘  │
│  [✕]  ┈┈┈▏▎▍▌▋▊▉█▊▋▌▍▎▏┈┈┈  0:03  [✓]         │
│                                                  │
│                       [Cancel]  [Submit Bug Report]│
└──────────────────────────────────────────────────┘
```

### Requirements

#### 1a. Single optional description field

- **Remove** the two separate `Textarea` fields (`expected` and `actual`) and their `Label` components
- **Replace** with a single `Textarea` with no label (the dialog description serves as the prompt)
- **Header:** "Report a Bug" (unchanged)
- **Subheader (DialogDescription):** "Tell us what went wrong — what you expected vs what actually happened, steps to reproduce, or anything else that might help."
- **Placeholder text:** `e.g. "I clicked the submit button but nothing happened — I expected it to save my changes"`
- **Optional:** The user should be able to submit with an empty description. Remove the validation that requires text (`canSubmit` currently checks `expected.trim() && actual.trim()`)
- **State change:** Replace `expected` and `actual` state with a single `description` state
- **onSubmit signature change:** Update from `(report: { expected: string; actual: string })` to `(report: { description: string })`

#### 1b. Voice-to-text button

Add voice recording support to the bug description textarea, reusing the existing `useVoiceRecording` hook and `VoiceRecorderBar` component from the chat prompt input.

**Implementation approach:**

- Import `useVoiceRecording` from `@/hooks/use-voice-recording` and `VoiceRecorderBar` from `@/components/voice-recorder`
- Import `Mic`, `Loader2` from `lucide-react` (Mic may need adding to imports)
- Import `Tooltip`, `TooltipContent`, `TooltipTrigger` from `@/components/ui/tooltip`
- Initialize the hook inside `BugReportDialog`:

```tsx
const {
  state: voiceState,
  startRecording,
  stopRecording,
  cancelRecording,
  isSupported: isVoiceSupported,
  analyser,
  recordingStartTime,
} = useVoiceRecording({
  onTranscript: (text) => {
    setDescription(prev => prev.trim() ? `${prev} ${text}` : text);
  },
});
```

- When `voiceState` is `idle` and `isVoiceSupported` is true, render a small mic icon button in the **bottom-right corner** of the textarea area (positioned absolutely within a relative wrapper, or placed below the textarea)
- When `voiceState` is `warming_up`, `recording`, or `transcribing`, render the `VoiceRecorderBar` below the textarea (between the textarea and the dialog footer)
- The textarea should be disabled during active recording (`isWarmingUp || isRecording`)
- Mirror the prompt-input pattern: Escape key cancels recording

**UI layout for mic button (idle state):**

Place the mic button absolutely inside the textarea container, bottom-right:

```tsx
<div className="relative">
  <Textarea
    value={description}
    onChange={(e) => setDescription(e.target.value)}
    placeholder='e.g. "I clicked the submit button but nothing happened..."'
    disabled={isLoading || isActiveRecording}
    className="min-h-[100px] resize-none pr-10"
  />
  {isVoiceSupported && voiceState === 'idle' && (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleMicClick}
          className="absolute bottom-2 right-2 rounded-full text-muted-foreground hover:text-foreground"
          aria-label="Dictate"
        >
          <Mic className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Dictate</TooltipContent>
    </Tooltip>
  )}
</div>

{(isActiveRecording || isTranscribing) && (
  <VoiceRecorderBar
    analyser={analyser}
    recordingStartTime={recordingStartTime}
    isWarmingUp={isWarmingUp}
    isTranscribing={isTranscribing}
    onCancel={cancelRecording}
    onConfirm={stopRecording}
  />
)}
```

#### Propagated changes in Chat.tsx

Update `submitBugReport` to match the new single-field signature and fix missing UI message:

- **Fix missing user message:** Add a local user message to `messages` state after constructing `agentMessage`, using the same optimistic pattern as the normal `sendMessage` flow (line ~2036). Currently the bug report is sent via WebSocket but no message appears in the chat UI.
- Change callback signature from `(report: { expected: string; actual: string })` to `(report: { description: string })`
- Update the `bugReport` JSON object:
  ```typescript
  userReport: {
    description: report.description,  // replaces expected/actual
  },
  ```
- Update the agent message template:
  ```typescript
  const agentMessage = report.description
    ? `I found a bug in the deployed app "${deployedApp}".

  **Description:** ${report.description}

  I've captured a debug report with the DOM snapshot and console logs. Please investigate and fix this bug.

  (bug report: ${uploadData.path})`
    : `I found a bug in the deployed app "${deployedApp}".

  I've captured a debug report with the DOM snapshot and console logs. Please investigate and fix this bug.

  (bug report: ${uploadData.path})`;
  ```

### Files to modify

| File | Changes |
|------|---------|
| `src/components/bug-report-dialog.tsx` | Replace two fields with one, add voice recording, update onSubmit type |
| `src/components/Chat.tsx` | Update `submitBugReport` callback signature and agent message format |

---

## Part 2: Bug Report Preview Card in Chat

### Problem

When a user submits a bug report, **no user message is rendered in the chat UI at all.** The `submitBugReport` function in Chat.tsx sends the message to the agent via WebSocket (`wsRef.current.send(...)`) but does **not** add a local message to the `messages` state array (unlike the normal `sendMessage` flow at line ~2036 which calls `setMessages(prev => [...prev, userMsg])`). The agent receives and acts on the bug report, but the user has zero visual record in their chat history.

### Solution

Two changes needed:

1. **Add a local user message to the chat** when submitting a bug report (same pattern as the normal `sendMessage` flow — optimistically add to `messages` state)
2. **Detect bug report messages in `MessageBubble`** and render them as a compact card (similar to how `FilePreviewChip` works for uploaded files). Clicking the card opens a `Dialog` with expanded details.

### Step 1: Add local user message on bug report submit

In `submitBugReport` in Chat.tsx, after constructing `agentMessage` and before/alongside the WebSocket send, add the message to local state:

```typescript
// Add user message to chat (optimistic, same as sendMessage)
const userMsg: Message = {
  id: `local_${Date.now()}`,
  thread_id: threadId,
  role: 'user',
  content: agentMessage,
  created_at: Date.now(),
};
forceScrollOnNextUpdate.current = true;
setMessages(prev => [...prev, userMsg]);
```

This ensures the bug report message appears in chat immediately. `MessageBubble` will then detect it and render the card (step 2).

### Step 2: Detect and render bug report cards

Bug report messages follow a consistent pattern. The message contains the text `(bug report: ` followed by a path. Parse this similarly to how `parseUploadRefs` works:

```typescript
const BUG_REPORT_REGEX = /\(bug report: ([^\s)]+)\)/;
```

Additionally, the message starts with `I found a bug in the deployed app "`. We can detect on either or both signals.

Create a parser function:

```typescript
interface ParsedBugReport {
  appName: string;           // Extracted from "I found a bug in the deployed app "myapp""
  description: string | null; // The user's description (from **Description:** ...) or null
  reportPath: string;        // The R2 path to the bug report JSON
  originalText: string;      // Full message text
}

function parseBugReport(content: string): ParsedBugReport | null
```

### Compact Card Design (inline in chat)

The bug report card replaces the normal user message bubble when a bug report is detected. It should be right-aligned like user messages.

```
                              ┌─────────────────────────────────┐
                              │  🐛  Bug Report                 │
                              │                                 │
                              │  "I clicked the submit button   │
                              │  but nothing happened"          │
                              │                                 │
                              │  myapp.chiridion.app            │
                              └─────────────────────────────────┘
```

When the user submitted without a description:

```
                              ┌─────────────────────────────────┐
                              │  🐛  Bug Report                 │
                              │                                 │
                              │  myapp.chiridion.app            │
                              └─────────────────────────────────┘
```

**Styling — use shadcn `Card` component:**

Use the existing `Card` component from `@/components/ui/card` (`bg-card text-card-foreground ring-foreground/10 ring-1 rounded-lg`) to match the design system. The card should feel like a native part of the chat, not a custom one-off.

- Use `Card` with `size="sm"` for compact padding
- `max-w-[280px]`
- `Bug` icon from lucide-react in `text-muted-foreground`
- "Bug Report" label in `CardTitle` (`text-sm font-medium`)
- User description (if any) in `CardContent`, `text-sm text-muted-foreground` with `line-clamp-3`
- App name in `CardContent` or `CardFooter`, `text-xs text-muted-foreground`
- Entire card wrapped in a `<button>` — clicking opens the expanded dialog
- Hover state: `hover:bg-accent/50 transition-colors` (standard shadcn hover pattern)

### Expanded Dialog Design

When the user clicks the compact card, open a `Dialog` (same pattern as `FilePreviewPopover`) showing more detail about the bug report.

```
┌──────────────────────────────────────────────────┐
│  🐛 Bug Report                              ✕   │
├──────────────────────────────────────────────────┤
│                                                  │
│  App          myapp.chiridion.app                │
│  Reported     Jan 30, 2026 at 2:15 PM           │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │ "I clicked the submit button but nothing   │  │
│  │ happened — I expected it to save my         │  │
│  │ changes"                                    │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  Screenshot captured  •  DOM snapshot captured   │
│                                                  │
└──────────────────────────────────────────────────┘
```

Without user description:

```
┌──────────────────────────────────────────────────┐
│  🐛 Bug Report                              ✕   │
├──────────────────────────────────────────────────┤
│                                                  │
│  App          myapp.chiridion.app                │
│  Reported     Jan 30, 2026 at 2:15 PM           │
│                                                  │
│  Screenshot captured  •  DOM snapshot captured   │
│                                                  │
└──────────────────────────────────────────────────┘
```

**What to show in the expanded dialog:**

- **App name** — extracted from the message text
- **Timestamp** — from `message.created_at`, formatted as a readable date/time
- **User description** — if provided, shown in a subtle quoted block (`bg-muted/30 rounded-md p-3 text-sm italic`)
- **Capture summary** — A simple line indicating what was captured. Rather than fetching and parsing the full bug report JSON from R2, derive this from what we know the system always captures: "Screenshot captured · DOM snapshot captured · Console logs captured". These are static since the `submitBugReport` function always captures the same set of data. This keeps the dialog lightweight with no additional API calls.

**Implementation notes:**
- The dialog does NOT need to fetch the bug report JSON from R2. The summary is informational for the user's benefit. The actual debug data is consumed by the agent.
- Use the same `Dialog`/`DialogContent`/`DialogClose` pattern from `FilePreviewPopover`

### Component Architecture

Create a new directory `src/components/bug-report-preview/` with:

| File | Purpose |
|------|---------|
| `parse-bug-report.ts` | `parseBugReport()` function to detect and parse bug report messages |
| `bug-report-card.tsx` | Compact card rendered inline in chat (replaces message bubble) |
| `bug-report-detail-dialog.tsx` | Expanded dialog shown on card click |
| `index.ts` | Barrel exports |

### Integration into MessageBubble

In `src/components/message-bubble.tsx`, in the user message rendering path, **before** the normal bubble rendering:

1. Extract the raw text content from the message (handling both `string` and `ContentBlock[]`)
2. Call `parseBugReport(textContent)`
3. If it returns non-null, render `BugReportCard` instead of the normal message bubble
4. If null, continue with the existing rendering (file preview chips + message bubble)

```tsx
// In the user message block of MessageBubble, early return for bug reports:
const rawText = typeof displayContent === 'string'
  ? displayContent
  : displayContent.filter(b => b.type === 'text').map(b => b.text).join('\n');

const bugReport = parseBugReport(rawText);

if (bugReport) {
  return (
    <div className="flex flex-col items-end gap-1">
      <BugReportCard
        appName={bugReport.appName}
        description={bugReport.description}
        reportPath={bugReport.reportPath}
        timestamp={message.created_at}
      />
      {/* Hover action row (same as existing) */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 ...">
        <span className="text-muted-foreground text-xs mr-1">
          {formatMessageTime(message.created_at)}
        </span>
        {/* Copy button etc */}
      </div>
    </div>
  );
}
```

### BugReportCard Props

```typescript
interface BugReportCardProps {
  appName: string;
  description: string | null;
  reportPath: string;
  timestamp: number;
}
```

### BugReportDetailDialog Props

```typescript
interface BugReportDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appName: string;
  description: string | null;
  timestamp: number;
}
```

### Files to create

| File | Purpose |
|------|---------|
| `src/components/bug-report-preview/parse-bug-report.ts` | Detection and parsing of bug report messages |
| `src/components/bug-report-preview/bug-report-card.tsx` | Compact inline card component |
| `src/components/bug-report-preview/bug-report-detail-dialog.tsx` | Expanded detail dialog |
| `src/components/bug-report-preview/index.ts` | Barrel exports |

### Files to modify

| File | Changes |
|------|---------|
| `src/components/message-bubble.tsx` | Import bug report components, detect bug reports, render card instead of bubble |

---

## Summary of All Changes

### New Files

| File | Purpose |
|------|---------|
| `src/components/bug-report-preview/parse-bug-report.ts` | Parse bug report messages from chat content |
| `src/components/bug-report-preview/bug-report-card.tsx` | Compact bug report card for inline chat display |
| `src/components/bug-report-preview/bug-report-detail-dialog.tsx` | Dialog showing expanded bug report details |
| `src/components/bug-report-preview/index.ts` | Barrel exports |

### Modified Files

| File | Changes |
|------|---------|
| `src/components/bug-report-dialog.tsx` | Merge two textarea fields into one optional field, add voice-to-text mic button using `useVoiceRecording` hook, update `onSubmit` signature to `{ description: string }` |
| `src/components/Chat.tsx` | Update `submitBugReport` to accept `{ description }` instead of `{ expected, actual }`, update `bugReport` JSON structure, update agent message template, **add local user message to `messages` state** (fix: currently no message is rendered in the UI) |
| `src/components/message-bubble.tsx` | Import `BugReportCard` and `parseBugReport`, detect bug report messages, render card instead of normal bubble |

### Existing components/hooks reused (no changes needed)

| Component/Hook | Usage |
|------|---------|
| `useVoiceRecording` (`@/hooks/use-voice-recording`) | Voice recording in bug report dialog |
| `VoiceRecorderBar` (`@/components/voice-recorder`) | Recording UI in bug report dialog |
| `Dialog` / `DialogContent` / `DialogClose` (`@/components/ui/dialog`) | Bug report detail dialog |
| `Tooltip` (`@/components/ui/tooltip`) | Mic button tooltip |
| `Badge` (`@/components/ui/badge`) | Optional, for capture summary tags |

---

## Implementation Order

1. **Simplify `bug-report-dialog.tsx`** — Merge fields, make optional, update types
2. **Add voice-to-text to `bug-report-dialog.tsx`** — Integrate `useVoiceRecording` hook and UI
3. **Update `Chat.tsx`** — Adapt `submitBugReport` to new single-field signature, add local user message to `messages` state (fix missing UI message)
4. **Create `parse-bug-report.ts`** — Bug report message detection
5. **Create `bug-report-card.tsx`** — Compact card component
6. **Create `bug-report-detail-dialog.tsx`** — Expanded detail dialog
7. **Create `index.ts`** barrel export
8. **Update `message-bubble.tsx`** — Integrate bug report card rendering

---

## Edge Cases

- **Empty description:** User submits without typing anything — the card shows just the app name, no description block. The agent message omits the `**Description:**` line.
- **Very long description:** Clamp to 3 lines in the compact card with `line-clamp-3`. Full text shown in the dialog.
- **Old bug report messages:** Messages submitted before this change used `**What I expected:**` / `**What actually happened:**` format. The parser should handle both formats — detect the old format and extract both fields as the description (e.g., concatenate them).
- **Voice recording permission denied:** Show the same error handling as the chat prompt input (console error, no crash). The mic button is only shown if `isVoiceSupported` is true.
- **Bug report without deployed app:** The bug report button only appears when there's an app preview, so `deployedApp` is always available. No edge case here.
- **Non-bug-report messages that mention "bug report":** The parser should be strict — require the exact `(bug report: path)` pattern AND the `I found a bug in the deployed app` prefix to avoid false positives.
