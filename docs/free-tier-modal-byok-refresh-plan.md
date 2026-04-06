# Free Tier Info Modal + API Key Page Redesign + BYOK Container Refresh

**Date:** 2026-04-05

---

## Objective

Three connected improvements:

1. **Free tier info modal** — show users a friendly one-time modal on their 3rd message explaining free tier limits and linking to the API key page
2. **API key page redesign** — make the AI Provider settings page approachable for non-technical users with guided step-by-step key generation instructions per provider
3. **BYOK container refresh** — after a user saves an API key, force active chat WebSocket reconnection so the new key is used immediately (no manual page refresh)

---

## Part 1: Free Tier Info Modal

### Trigger Logic

Show the modal on the user's **3rd message send across any thread**. Track this with a `localStorage` key so it fires exactly once per browser and persists across sessions.

**Why 3rd message:** First two messages let the user get comfortable. By the 3rd, they're engaged enough to absorb the info without feeling overwhelmed.

**Storage keys:**
- `freeTierModalSeen:{userId}` — set to `"true"` after modal is dismissed or shown
- `userMessageCount:{userId}` — incremented on each send, checked before send completes

**Location:** Intercept in `Chat.tsx` `sendMessage()` function (~line 3923). Before the WebSocket send, increment the counter and check:

```typescript
// In sendMessage(), before ws.send():
const countKey = `userMessageCount:${userId}`;
const seenKey = `freeTierModalSeen:${userId}`;
const count = Number(localStorage.getItem(countKey) || '0') + 1;
localStorage.setItem(countKey, String(count));

if (count === 3 && localStorage.getItem(seenKey) !== 'true') {
  setShowFreeTierModal(true);
  // Don't block the send — message still goes through, modal overlays
}
```

The message sends normally. The modal appears on top after the 3rd message is dispatched — it does not block the send.

### Modal Design

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│                        camelAI is free to use                       │
│                                                                     │
│   We want everyone to have access to a powerful coding assistant.   │
│   Your free tier includes:                                          │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                                                             │   │
│   │   ⏱  $25 every 5 hours  (rolling)                          │   │
│   │                                                             │   │
│   │   📅  $100 every 7 days  (rolling)                          │   │
│   │                                                             │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│   Want unlimited usage? Add your own API key — we pass it          │
│   through at cost with zero markup.                                 │
│                                                                     │
│              [Add API key]              [Got it]                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Visual spec:**

- **Component:** shadcn `Dialog` (not `AlertDialog` — user can dismiss freely)
- **Container:** `DialogContent className="sm:max-w-md"`
- **Mobile:** Use the existing `useIsMobile()` + `Sheet` pattern (see `create-org-dialog.tsx` for reference)
- **Title:** `"camelAI is free to use"` — `DialogTitle`, centered, `text-lg font-semibold`
- **Subtitle:** `"We want everyone to have access to a powerful coding assistant."` — `text-sm text-muted-foreground text-center`
- **Limits card:** `rounded-lg border bg-muted/50 p-4 space-y-3 mt-4`
  - Each limit row: icon + text in `flex items-center gap-3`
  - Icon: `Clock` for 5-hour, `CalendarDays` for 7-day (both from lucide-react, `size-4 text-muted-foreground`)
  - Text: `text-sm` — e.g. `"$25 every 5 hours"` with `"(rolling)"` in `text-muted-foreground`
- **Unlimited pitch:** `text-sm text-muted-foreground text-center mt-4`
  - Key phrase: `"zero markup"` — emphasize that we charge nothing extra
- **Footer buttons:** `DialogFooter` with two buttons, `flex gap-3 justify-center`
  - `[Add API key]` — `Button variant="default"`, navigates to `/settings/organization/ai-provider` via `Link`
  - `[Got it]` — `Button variant="outline"`, dismisses the modal

**On dismiss (either button):**
```typescript
localStorage.setItem(`freeTierModalSeen:${userId}`, 'true');
setShowFreeTierModal(false);
```

### New File

**File:** `src/components/free-tier-modal.tsx`

```typescript
interface FreeTierModalProps {
  open: boolean;
  onClose: () => void;
}
```

Uses: `Dialog`/`Sheet` (mobile), `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, `Button`, `Link`, `Clock`, `CalendarDays` from lucide-react.

### Chat.tsx Integration

**File:** `src/components/Chat.tsx`

1. Add state: `const [showFreeTierModal, setShowFreeTierModal] = useState(false);`
2. In `sendMessage()` (~line 3923): add the counter + check logic shown above
3. Render `<FreeTierModal>` alongside the existing modal stack (near `OnboardingLoadingModal` ~line 4499):
   ```tsx
   <FreeTierModal
     open={showFreeTierModal}
     onClose={() => {
       localStorage.setItem(`freeTierModalSeen:${userId}`, 'true');
       setShowFreeTierModal(false);
     }}
   />
   ```
4. The `userId` is available from the auth context already passed into `Chat.tsx`

---

## Part 2: API Key Page Redesign

### Current Problems

1. The page is developer-oriented — assumes users know what API keys are and where to find them
2. No step-by-step guidance for generating keys
3. Provider names like "AWS Bedrock" are intimidating to non-technical users
4. No explanation of what adding a key actually does (removes limits, at-cost billing)

### Redesigned Page Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│                                                                          │
│  AI Provider                                                             │
│  Add your own API key to remove usage limits. You're billed directly     │
│  by the provider — camelAI adds zero markup.                             │
│                                                                          │
│  ─────────────────────────────────────────────────────────────────────── │
│                                                                          │
│  ┌─ Current Key ─────────────────────────────────────────────────────┐   │
│  │  Provider: Anthropic          Key: sk-ant-···abc    Updated 4/1   │   │
│  │                                            [Test]   [Remove]      │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  Choose a provider                                                       │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐   │
│  │  ◉ Anthropic (recommended)                                        │   │
│  │    Direct access to Claude models                                 │   │
│  │                                                                   │   │
│  │  ○ OpenAI                                                         │   │
│  │    For Codex-powered threads                                      │   │
│  │                                                                   │   │
│  │  ○ AWS Bedrock                                                    │   │
│  │    Claude via your AWS account                                    │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ── Anthropic selected ─────────────────────────────────────────────    │
│                                                                          │
│  Anthropic API Key                                                       │
│  ┌──────────────────────────────────────────────────────────┐           │
│  │  sk-ant-...                                               │           │
│  └──────────────────────────────────────────────────────────┘           │
│                                                                          │
│  ┌─ How to get your API key ───────────────── [▾ collapse] ─────────┐   │
│  │                                                                   │   │
│  │  1. Go to console.anthropic.com/settings/keys                     │   │
│  │     (opens in new tab)                      [Open Anthropic ↗]    │   │
│  │                                                                   │   │
│  │  2. Click "Create Key"                                            │   │
│  │                                                                   │   │
│  │  3. Name it anything (e.g. "camelAI")                             │   │
│  │                                                                   │   │
│  │  4. Copy the key and paste it above                               │   │
│  │                                                                   │   │
│  │  Note: You'll need to add a payment method on Anthropic's         │   │
│  │  site first if you haven't already.                               │   │
│  │                                                                   │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  [Save]                                                                  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Key Changes

#### A. Updated Header Description

**Before:** `"Configure your own provider key for Claude or Codex. Keys are encrypted at rest and used through the sandbox proxy."`

**After:** `"Add your own API key to remove usage limits. You're billed directly by the provider — camelAI adds zero markup."`

This immediately tells non-technical users *why* they'd add a key.

#### B. Radio Group with Descriptions

Replace bare radio labels with descriptive radio cards. Each option gets a one-line description:

| Provider | Label | Description |
|----------|-------|-------------|
| Default | `Default (free tier)` | `Free with usage limits ($25/5hrs, $100/7days)` |
| Anthropic | `Anthropic (recommended)` | `Direct access to Claude models` |
| OpenAI | `OpenAI` | `For Codex-powered threads` |
| Bedrock | `AWS Bedrock` | `Claude via your AWS account` |

**Style:** Each radio row becomes a selectable card-style row using `rounded-lg border p-3 cursor-pointer` with `border-primary` on the selected item. The description sits below the label in `text-xs text-muted-foreground`.

#### C. Guided Setup Instructions (Collapsible)

For each provider, add a collapsible instruction panel using shadcn `Collapsible` (`@/components/ui/collapsible`). **Default state: expanded** for users who don't have a key configured yet, collapsed for users who already have a key.

**Install collapsible if not present:** `npx shadcn@latest add collapsible`

**Anthropic instructions:**

```
How to get your API key

1. Go to console.anthropic.com/settings/keys     [Open Anthropic ↗]
2. Click "Create Key"
3. Name it anything (e.g. "camelAI")
4. Copy the key and paste it above

Note: You'll need to add a payment method on Anthropic's site first
if you haven't already.
```

**OpenAI instructions:**

```
How to get your API key

1. Go to platform.openai.com/api-keys            [Open OpenAI ↗]
2. Click "Create new secret key"
3. Name it anything (e.g. "camelAI")
4. Copy the key and paste it above

Note: You'll need to add a payment method on OpenAI's platform first
if you haven't already.
```

**Bedrock instructions:**

```
How to get your API key

1. Go to your AWS Console → Bedrock              [Open AWS ↗]
2. Make sure Claude models are enabled in your region
   (Model access → Request access for Anthropic models)
3. Go to Bedrock → API keys and create a new key
4. Copy the key and paste it above
5. Select your AWS region below

Note: AWS Bedrock is billed through your AWS account.
```

**Implementation:**

```tsx
<Collapsible defaultOpen={!config}>
  <div className="rounded-lg border bg-muted/50">
    <CollapsibleTrigger asChild>
      <button className="flex w-full items-center justify-between p-3 text-sm font-medium">
        How to get your API key
        <ChevronDown className="size-4 transition-transform" />
      </button>
    </CollapsibleTrigger>
    <CollapsibleContent className="px-3 pb-3">
      <ol className="list-decimal list-inside space-y-2 text-sm text-muted-foreground">
        {/* Steps */}
      </ol>
    </CollapsibleContent>
  </div>
</Collapsible>
```

Icons used: `ChevronDown` (for collapse toggle), `ExternalLink` (for "Open" links).

Each "Open [Provider]" link is a `Button variant="link" size="sm"` with `target="_blank"` and `ExternalLink` icon.

#### D. Remove "Default (camelAI proxy)" Jargon

The "Default" option should not mention "proxy." Rename to `"Default (free tier)"` with description `"Free with usage limits ($25/5hrs, $100/7days)"`. This reinforces what the free tier includes and creates a natural visual comparison with the BYOK options.

### Files to Modify

| File | Change |
|------|--------|
| `src/routes/_app.settings.organization.ai-provider.tsx` | Redesign layout: updated header, radio cards with descriptions, collapsible guided instructions per provider, "Default (free tier)" label |

No new files needed for this part — it's a rewrite of the existing page component.

### Components to Install

Check if `collapsible` exists in `src/components/ui/`. If not:
```bash
npx shadcn@latest add collapsible
```

---

## Part 3: BYOK Container Refresh on Key Save

### The Problem

Currently, BYOK credentials are passed as headers during the chat WebSocket upgrade to sandbox-host. When a user saves a new API key:

1. The key is stored in the Org Durable Object (immediate)
2. Active `ChatThreadDO` instances have **no notification** of the change
3. The existing runner WebSocket to sandbox-host continues using the old (or no) credentials
4. The user must manually refresh the page or wait for a natural reconnect

This is especially frustrating when a user hits a usage limit, adds their BYOK key, and returns to chat — the limit error persists because the runner is still using the old proxy path.

### Solution: Force Runner Reconnect on BYOK Change

When the AI provider config is saved, broadcast a signal to all active `ChatThreadDO` instances for the org, causing them to tear down and re-establish the runner WebSocket with fresh credentials.

#### Flow

```
AI Provider Page              API Route               OrgDO              ChatThreadDO(s)
     │                           │                      │                      │
     │── POST setProvider ──────►│                      │                      │
     │                           │── setLlmProvider ───►│                      │
     │                           │                      │── (stored) ──►       │
     │                           │                      │                      │
     │                           │── broadcast          │                      │
     │                           │   byokChanged ──────────────────────────►  │
     │                           │                      │              reconnectRunner()
     │                           │                      │              (tears down WS,
     │                           │                      │               fetches fresh creds,
     │                           │                      │               opens new WS)
     │                           │                      │                      │
     │◄── 200 OK ───────────────│                      │                      │
```

#### Implementation Steps

##### Step 1: Add `reconnectRunner()` to ChatThreadDO

**File:** `workers/main/src/durable-objects.ts`

Add a public RPC method on `ChatThreadDO`:

```typescript
async byokChanged(): Promise<void> {
  // Only reconnect if there's an active runner connection
  if (!this.runnerWs) return;

  // Close the existing runner WebSocket — this triggers reconnect logic
  // on the next user message or via the existing reconnect-grace path
  this.runnerWs.close(4001, 'BYOK credentials changed');
}
```

When the runner WebSocket closes, the existing `ensureRunnerConnectedUnlocked()` path will re-establish it on the next interaction, fetching fresh BYOK credentials via `fetchByokProxyCredentials()`. This leverages the existing reconnect infrastructure rather than duplicating it.

**Important:** Use close code `4001` (or another app-specific code) so the reconnect-grace logic in the DO can distinguish this from network failures and reconnect promptly rather than waiting for the grace period.

##### Step 2: Track Active Thread IDs on OrgDO

**File:** `workers/main/src/auth.ts` (OrgDO)

The org already stores thread records in its `threads` SQLite table. To broadcast to active threads, query for recently active threads:

```typescript
// In OrgDO, after setLlmProviderConfig():
async notifyByokChanged(): Promise<void> {
  // Get threads that have been active recently (last 30 minutes)
  const rows = this.sql.exec(
    `SELECT id FROM threads WHERE updated_at > ? LIMIT 100`,
    Date.now() - 30 * 60 * 1000
  ).toArray();

  const promises = rows.map((row) => {
    const threadId = row.id as string;
    const stub = this.env.CHAT_THREAD.get(
      this.env.CHAT_THREAD.idFromName(threadId)
    );
    return stub.byokChanged().catch(() => {
      // Thread may not be active — swallow errors
    });
  });

  await Promise.allSettled(promises);
}
```

##### Step 3: Call notifyByokChanged from the API Route

**File:** `src/routes/api/orgs.$id.llm-provider.ts`

After the `setProvider` intent succeeds (after `orgStub.setLlmProviderConfig()`), trigger the broadcast:

```typescript
// After successful setLlmProviderConfig:
waitUntil(orgStub.notifyByokChanged().catch(console.error));
```

Use `waitUntil` so the response returns immediately and the broadcast happens in the background.

##### Step 4: Handle Reconnect-Grace for Code 4001

**File:** `workers/main/src/durable-objects.ts`

In the runner WebSocket close handler, check for the `4001` close code and skip the reconnect-grace delay:

```typescript
// In the runner WS close handler:
if (event.code === 4001) {
  // BYOK changed — reconnect immediately without grace period
  this.scheduleReconnect(0);
} else {
  // Normal close — use existing grace period
  this.scheduleReconnect(RECONNECT_GRACE_MS);
}
```

If there is no `scheduleReconnect` with a delay parameter, the simplest approach is to immediately call `ensureRunnerConnectedUnlocked()` in a `waitUntil` when close code is `4001`, so the new runner connection is established proactively rather than waiting for the next user message.

##### Step 5: Client-Side Success Feedback

**File:** `src/routes/_app.settings.organization.ai-provider.tsx`

After a successful save, show a brief success message that reinforces the key is now active:

```tsx
{fetcherData?.success && !fetcherData?.message && (
  <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-3">
    <p className="text-sm text-green-700 dark:text-green-300">
      API key saved. Your active chats are now using your key — no refresh needed.
    </p>
  </div>
)}
```

This reassures the user that the key change has taken effect immediately.

---

## Files Summary

| File | Change |
|------|--------|
| `src/components/free-tier-modal.tsx` | **New** — Dialog/Sheet modal explaining free tier limits with CTA to API key page |
| `src/components/Chat.tsx` | Add localStorage message counter, show `FreeTierModal` on 3rd message |
| `src/routes/_app.settings.organization.ai-provider.tsx` | Full redesign: updated header copy, radio cards with descriptions, collapsible guided instructions per provider, success feedback after save |
| `src/routes/api/orgs.$id.llm-provider.ts` | Call `orgStub.notifyByokChanged()` in `waitUntil` after successful `setProvider` |
| `workers/main/src/auth.ts` | Add `notifyByokChanged()` method to `OrgDO` — broadcasts to recent active threads |
| `workers/main/src/durable-objects.ts` | Add `byokChanged()` RPC method to `ChatThreadDO`; handle close code `4001` for immediate reconnect |

### Components to Verify/Install

```bash
# Verify these exist in src/components/ui/, install if missing:
npx shadcn@latest add dialog        # likely already installed
npx shadcn@latest add collapsible   # may need to install
```

---

## Out of Scope

- **Showing real-time spend in the modal** — the modal is informational, not a live dashboard. The existing usage page (`/settings/organization/usage`) handles that.
- **Changing the actual spend limits** — limits remain $25/5hr and $100/7day rolling. This plan only communicates them.
- **Non-admin BYOK messaging** — free-tier orgs are single-user (user is admin). Team account edge cases are deferred.
- **Desktop app** — the desktop prototype has its own provider picker; this plan covers web only.
- **Proactive spend warnings before hitting limits** — separate future enhancement. The `ContextIndicator` pattern could be adapted.
