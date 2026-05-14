# PWA & Mobile — Phase 3: Larger Mobile Investments

> Phase 3 of 3. Phase 1 is `pwa-mobile-phase-1-message-actions-plan.md`. Phase 2 is `pwa-mobile-phase-2-pwa-polish-plan.md`. Phases 1 and 2 should ship before Phase 3 work begins.

## Goal

Three larger mobile investments that need their own PRs (and likely their own follow-up plans). Each is **scoped, prioritized, and design-sketched** below — but not fully spec'd to coding-agent-implementation level. The intent is that the team picks one, the user (or a planning agent) writes the focused plan for that sub-investment, and the coding agent implements from that plan.

Recommended order:

1. **3.1 Mobile workspace switcher** — likely the smallest, may already be partially supported by shadcn primitives we're not using.
2. **3.2 Push notifications for completed agent turns** — the killer PWA feature for a coding assistant.
3. **3.3 Computer pane mobile layout** — only if mobile usage of the computer pane is non-zero.
4. **3.4 Service worker** (optional — pairs naturally with 3.2).

---

## 3.1 — Mobile Workspace Switcher

### Why

[src/components/sidebar/app-sidebar.tsx](src/components/sidebar/app-sidebar.tsx) uses `<Sidebar collapsible="icon">`. On narrow viewports the sidebar collapses to icon-only, hiding the workspace name. Switching workspaces on mobile is currently very awkward — a user has to expand the sidebar (if there's even a trigger surfaced on mobile) to see workspace names.

### Sketch

shadcn's `Sidebar` already supports a built-in mobile Sheet mode out of the box. The likely fix is small: just wire up the existing primitives that we're not currently using.

**Investigation step (do this first):**

1. Read [src/components/sidebar/app-sidebar.tsx](src/components/sidebar/app-sidebar.tsx) and [src/components/ui/sidebar.tsx](src/components/ui/sidebar.tsx).
2. Confirm whether the existing `<Sidebar>` already auto-switches to a Sheet on mobile widths (shadcn's default behavior with the `useIsMobile()` hook the component ships with).
3. Find where chat pages render — is there a `<SidebarTrigger>` (hamburger) visible on mobile? If not, that's likely the entire fix.

**Most likely fix (best case):** add a single `<SidebarTrigger>` at the top-left of the chat page header (or `chat-tab-bar.tsx`), wrapped in `md:hidden` so it only shows on mobile. The shadcn `<Sidebar>` will handle opening/closing as a Sheet automatically.

**If shadcn's auto-Sheet behavior isn't wired up**, the fix becomes slightly larger: add the `<SidebarProvider>` setup that shadcn requires, or build a custom sheet workspace switcher that reuses the workspace-list logic from the sidebar.

### Alternative design (if Sheet sidebar feels heavy)

Skip the full sidebar Sheet. Add a compact workspace switcher at the top of the mobile chat page:

```
┌─────────────────────────────────────────┐
│ ☰  [▼ Acme Co — production-app]    ⋯    │  ← sticky header on mobile
├─────────────────────────────────────────┤
│  …chat tabs…                            │
├─────────────────────────────────────────┤
│  …chat content…                         │
└─────────────────────────────────────────┘
```

The `[▼ ...]` is a shadcn `<DropdownMenu>` trigger that opens the workspace list. `☰` is the menu trigger that opens the full sidebar as a Sheet. Build with shadcn `<DropdownMenu>` + `<DropdownMenuTrigger>` + `<DropdownMenuItem>`, or `<Popover>` + `<Command>` if there are many workspaces.

### Effort estimate

- **Best case (just wire `<SidebarTrigger>`):** half a day.
- **Custom workspace dropdown header:** 1-2 days.

### Open Questions

1. Does shadcn `<Sidebar>` already auto-render as a Sheet on mobile in this codebase, or has the integration been customized to disable that?
2. How many workspaces does a typical user have? <5 → DropdownMenu. ≥5 → Popover with Command (searchable).

---

## 3.2 — Push Notifications for Completed Agent Turns

### Why this is the headline feature

The single biggest reason a user would install camelAI as a PWA on their phone is "I can switch apps and get pinged when the agent finishes a long task." Refactors, deploys, multi-step research — these can take 5-30 minutes. Today the user has to babysit the tab. Push notifications change that.

### Architecture sketch

```
                   ┌────────────────────────────┐
                   │ ChatThreadDO (existing)    │
                   │ - turn-complete event      │
                   └─────────────┬──────────────┘
                                 │ on turn complete
                                 │ if no live WS clients
                                 ▼
                   ┌────────────────────────────┐
                   │ Web Push sender (NEW)      │
                   │ - looks up subscriptions   │
                   │   for thread.user_id       │
                   │ - sends VAPID push         │
                   └─────────────┬──────────────┘
                                 ▼
                   ┌────────────────────────────┐
                   │ Service Worker (NEW)       │
                   │ - 'push' event handler     │
                   │ - showNotification()       │
                   │ - 'notificationclick'      │
                   │   focuses or opens         │
                   │   /chat/<workspace>/<id>   │
                   └────────────────────────────┘
```

### Required pieces

1. **Backend: VAPID setup**
   - Generate VAPID keys (one-time), store private key as Worker secret, expose public key via env var.
   - New `workers/main/src/web-push.ts` — `subscribe(userId, subscription)`, `unsubscribe(userId, endpoint)`, `sendPush(userId, payload)`.
   - Storage: KV or a new `PushSubscriptionDO`. Per-user list of subscription objects (endpoint + p256dh + auth keys).
   - Web Push protocol implementation: use a library compatible with Cloudflare Workers (e.g. `@block65/webcrypto-web-push` — has Worker compatibility) or hand-roll the VAPID JWT signing + encryption (~150 lines).

2. **Backend: trigger**
   - In `ChatThreadDO` turn-complete handler, check if any live WS clients are connected. If zero, fire `webPush.sendPush(userId, payload)`.
   - Payload includes `threadId`, `workspaceId`, short message preview.

3. **Frontend: service worker**
   - New `public/sw.js` (or generated by `vite-plugin-pwa` if we adopt it in 3.4).
   - Handle `push` event → `self.registration.showNotification(title, { body, icon, data: { url } })`.
   - Handle `notificationclick` → focus existing tab if open, else `clients.openWindow(data.url)`.
   - Register the SW from `src/root.tsx` (and **make sure the unregister script from Phase 2.1 is gone**, otherwise Phase 3 fights itself).

4. **Frontend: settings UI**
   - New route `src/routes/_app.settings.notifications.tsx`.
   - Use shadcn primitives: `<Card>`, `<Switch>`, `<Button>`, `<Alert>` for permission state explainers.
   - Components needed (all already in `src/components/ui/`):
     - `<Switch>` — master enable
     - `<Switch>` per workspace — per-workspace mute
     - `<Button>` — "Request permission" / "Send test notification"
     - `<Alert>` — explains denied state and how to re-enable in OS settings

   Layout:
   ```
   ┌── Notifications ──────────────────────────────┐
   │                                                │
   │  Push notifications                            │
   │  Get notified when an agent finishes a turn.   │
   │                                          [ ●━] │  ← master switch
   │                                                │
   │  Status: Enabled • iPhone (Safari)             │
   │                              [Send test push]  │
   │                                                │
   ├────────────────────────────────────────────────┤
   │  Per-workspace                                 │
   │                                                │
   │  Acme Co            All notifications     [●━] │
   │  Personal           Mentions only         [━●] │
   │  Old project        Off                   [━ ] │
   └────────────────────────────────────────────────┘
   ```

5. **Permission UX**
   - **Never** call `Notification.requestPermission()` on page load. Browsers penalize this and users reflexively click Block.
   - Trigger only from a user gesture in the settings page (after they flip the master Switch on).
   - Show an inline Alert explaining what notifications will be used for *before* the prompt fires.
   - After the first long agent turn, show a one-time `<Sonner>` toast that links to the settings page: "Want a notification next time? Enable push in Settings."

### Platform caveats

- **iOS PWA push** only works for installed PWAs (Add to Home Screen) on **iOS 16.4+**. Detect, show appropriate guidance.
- **Android Chrome push** works in any browser tab without install.
- **Desktop Safari, Chrome, Firefox, Edge:** all work with VAPID.
- **Firefox** — fine.

### Effort estimate

Medium PR, ~1 week:
- Day 1-2: VAPID + backend `web-push.ts` + storage.
- Day 2-3: Service worker + push event handling + click routing.
- Day 3-4: Settings UI (the shadcn part is straightforward).
- Day 4-5: Trigger logic in `ChatThreadDO` + tests.
- Day 5: Real-device QA (iPhone PWA, Android, desktop).

### Required follow-up plan

This sub-investment needs its own focused plan before implementation. The plan should cover:

- Storage schema for subscriptions (KV vs DO).
- Exact payload shape and notification copy.
- Notification-click routing (the canonical way to focus/open chat from a SW).
- Per-workspace mute storage (likely `org_info` JSON or a new field on workspace).
- Quiet-hours / rate-limiting (do not push 12 times in a row if the agent re-prompts itself in a loop).
- VAPID key rotation procedure.
- Test strategy — push events are hard to unit test; rely on Playwright + a real notification mock.

---

## 3.3 — Computer Pane Mobile Layout

### Why

[src/components/pages/computer/computer-page-content.tsx](src/components/pages/computer/computer-page-content.tsx) currently nests two `<ResizablePanelGroup>`s — file tree, file editor, diff/output. There is no `useIsMobile()` check. On a 375 px screen, three nested resizable panels fight for ~120 px each — completely unreadable.

### Design

Tabs-based layout on mobile, current panel layout on desktop. Reuse the `MobileViewSwitcher` pattern that already exists at [src/components/Chat.tsx:608](src/components/Chat.tsx#L608).

```
DESKTOP                                 MOBILE
─────────────────────────────────       ─────────────────────────
┌─────┬──────────────┬────────┐         ┌────────────────────────┐
│Tree │   Editor     │ Output │         │ [Tree] [Edit] [Output] │ ← Tabs
│     │              │        │         ├────────────────────────┤
│     │              │        │         │                        │
│     │              │        │         │  Active tab content    │
│     │              ├────────┤         │  (full width)          │
│     │              │        │         │                        │
└─────┴──────────────┴────────┘         └────────────────────────┘
```

### Implementation sketch

1. Add `const isMobile = useIsMobile()` from `@/hooks/use-mobile` near the top of `computer-page-content.tsx`.
2. Conditional render:

```tsx
{isMobile ? (
  <Tabs defaultValue="tree" className="flex h-full flex-col">
    <TabsList className="grid w-full grid-cols-3">
      <TabsTrigger value="tree">Files</TabsTrigger>
      <TabsTrigger value="editor">Editor</TabsTrigger>
      <TabsTrigger value="output">Output</TabsTrigger>
    </TabsList>
    <TabsContent value="tree" className="flex-1 overflow-auto">
      {/* existing file tree component */}
    </TabsContent>
    <TabsContent value="editor" className="flex-1 overflow-auto">
      {/* existing editor component */}
    </TabsContent>
    <TabsContent value="output" className="flex-1 overflow-auto">
      {/* existing output component */}
    </TabsContent>
  </Tabs>
) : (
  <ResizablePanelGroup>
    {/* existing nested panels — unchanged */}
  </ResizablePanelGroup>
)}
```

3. **Don't mount both at once.** The conditional render avoids `ResizablePanelGroup` running ResizeObserver on mobile (it's expensive and useless when the panels are hidden). This is one of the gotchas in the existing `Chat.tsx` mobile implementation that should not be repeated here.
4. The editor toolbar should collapse to a `<DropdownMenu>` on mobile to save vertical space. shadcn `<DropdownMenu>` is already in the codebase.

### Files touched

- `src/components/pages/computer/computer-page-content.tsx` — main change.
- Possibly editor toolbar component (find it via grep) — collapse to dropdown on mobile.

### Effort estimate

Small-to-medium PR, ~2 days. Most time is in untangling the existing nested panel JSX, not in writing the mobile branch.

### Open Questions

1. Does the editor (Monaco? CodeMirror?) handle 375 px width gracefully, or does it need its own minimap/line-number disabling on mobile?
2. Is the file tree usable at full mobile width, or does it need a tap-to-open-folder pattern instead of expand-in-place?

---

## 3.4 — Service Worker (Asset Cache + Offline Indicator)

### Why

Pairs naturally with 3.2 (push notifications need a SW anyway). Adds:

- **Asset precache:** the app loads instantly on a flaky train Wi-Fi connection.
- **Offline indicator:** when the user goes offline mid-chat, show a non-dismissable banner ("You're offline — messages can't be sent until reconnected"). Disable the prompt input. This is a much better UX than the current silent failure.

### Sketch

**Recommended:** adopt `vite-plugin-pwa`. It generates a Workbox service worker, handles precache manifest injection, and integrates with Vite's build. Saves ~300 lines of hand-rolled SW code.

Steps:

1. `bun add -d vite-plugin-pwa workbox-window`
2. Configure in `vite.config.ts` with manifest reference (re-uses `public/site.webmanifest` from Phase 2):

   ```ts
   VitePWA({
     registerType: "prompt",            // ask user before activating new SW
     strategies: "generateSW",
     workbox: {
       globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
       navigateFallback: "/",
       runtimeCaching: [
         {
           urlPattern: ({ request }) => request.destination === "font",
           handler: "CacheFirst",
           options: { cacheName: "fonts" },
         },
       ],
     },
   })
   ```

3. Register from `src/root.tsx` using `workbox-window`'s `Workbox`. Show a toast when an update is available with a "Reload" button.
4. Add an offline indicator: small `<Alert>` or sticky banner at the top of `Chat.tsx` when `navigator.onLine === false`. Disable the prompt input (`disabled` prop).

### What this plan does NOT cover

- **Offline message queue.** Replaying queued messages into `ChatThreadDO` is delicate — the DO is the source of truth and won't accept replays cleanly without idempotency keys. Defer until we add idempotent message IDs through `ChatThreadDO` (separate scoping work). v1 of the SW just shows "You're offline."
- **Service worker for chat WebSocket failover.** WS doesn't go through the SW; offline simply means WS reconnects when online again.

### Effort estimate

Small-to-medium PR, ~3 days for asset cache + offline indicator. Don't bundle with offline message queueing.

---

## Cross-Cutting Notes for All Phase 3 Sub-Investments

### Reuse what already exists

- `useIsMobile()` at [src/hooks/use-mobile.ts](src/hooks/use-mobile.ts) — 768 px breakpoint, used elsewhere. Don't rewrite.
- `MobileViewSwitcher` at [src/components/Chat.tsx:608](src/components/Chat.tsx#L608) — pattern reference, not a shared component yet. If 3.3 needs the same pattern, consider extracting it to `src/components/ui/mobile-view-switcher.tsx`.
- shadcn primitives in `src/components/ui/`: `Tabs`, `Sheet`, `DropdownMenu`, `Popover`, `Command`, `Switch`, `Alert`, `Sonner` (toaster), `Sidebar`. **All of these are available.** The agent should reach for them before building custom UI.

### Don't ship Phase 3 work without Phase 1 and 2

Phase 3.2 (push) requires Phase 2.1 (delete the SW unregister script) — otherwise the SW gets unregistered on every page load. Phase 3.4 same.

Phase 3.1 (workspace switcher) and 3.3 (computer pane) don't have a hard dependency, but they'll feel disjointed shipping before the touch-target work in Phase 1 and the safe-area work in Phase 2.

### Each sub-investment should get its own dedicated plan

This document is intentionally a sketch, not a spec. Before any of the four sub-investments above is implemented, the user (or a planning agent) should write a focused plan for it — same level of detail as Phase 1 and Phase 2 plans.

### Suggested next planning task after Phase 1 and Phase 2 ship

Write the **Phase 3.1 mobile-workspace-switcher plan**. Start by reading `src/components/sidebar/app-sidebar.tsx` and `src/components/ui/sidebar.tsx` to confirm whether the existing shadcn Sidebar already auto-Sheets on mobile — that determines whether the fix is half a day or two days.
