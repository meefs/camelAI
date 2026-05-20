# Chat Preview HTML Renderer Performance Audit

> Superseded for implementation by
> `docs/chat-performance-p0-prescriptive-plan.md`. Keep this file as background
> audit detail only.

## Scope

This is an audit-only handoff for the chat preview panel, with emphasis on HTML
file previews, app previews, notebook HTML outputs, and the standalone file
renderer used by published single-file apps. No production code was changed.

This extends `docs/chat-performance-p0-audit.md`. The preview path does not
replace the broader chat-route/transcript diagnosis, but it is a plausible
amplifier for the observed "many active chats with HTML renderer" slowdown.

## Short Answer

The HTML renderer suspicion is likely not coincidence.

The highest-confidence preview-specific issue is that `PreviewPanelShell`
renders every preview tab and hides inactive tabs with CSS:

- `src/components/chat-preview/chat-preview-shell.tsx:247-298`

That means inactive app iframes and inactive file previews are still mounted. If
those hidden tabs are app previews, direct HTML files, or notebook HTML outputs,
they can continue running script, animation, layout, network, and parser work
while the user is scrolling the chat transcript.

There is also a direct HTML file preview inefficiency: HTML preview mode fetches
the HTML into React state before rendering an iframe that loads the same URL:

- text fetch includes `previewType === 'html'` at
  `src/components/chat-file-preview/file-preview-content.tsx:223-252`
- iframe render is gated on `textStatus === 'ready'` at
  `src/components/chat-file-preview/file-preview-content.tsx:352-379`
- iframe source is the same `previewUrl` at
  `src/components/chat-file-preview/file-preview-content.tsx:130-149`

So a hidden inactive HTML tab can still do a parent fetch plus an iframe load,
and the visible active tab also double-loads the same HTML in normal preview
mode.

## Trace Follow-Up: 2026-05-20 DevTools Trace

User-provided trace:
`Trace-20260520T112048.json.gz`, recorded against `staging.camelai.dev` while
clicking around a chat group with multiple HTML-renderer chats.

The trace window is about 25.5s. It includes these HTML preview URLs:

- `hot-pink-screensaver.html`
- `screensaver.html`
- `blue-screensaver.html`

### Trace Findings

The trace points to `hot-pink-screensaver.html` as the worst HTML file in this
recording.

Evidence:

- The sampled JS profile attributes most HTML-file self time to
  `hot-pink-screensaver.html`.
- The hot-pink file's top JS function is `drawFrame` around line 320, with
  additional samples in `drawConnections` and `drawParticle`.
- Hot-pink animation callbacks are heavier than the other HTML previews. Its
  `FunctionCall` time is roughly 137ms across 229 calls in this trace, versus
  roughly 61ms across 226 calls for `blue-screensaver.html` and roughly 46ms
  across 129 calls for `screensaver.html`.
- A long hot-pink animation callback is visible at the trace boundary:
  `FunctionCall` around 17ms for `hot-pink-screensaver.html`.

The largest single UI stalls are iframe teardown tasks, not initial parse or
React render:

- at about 5.86s: `RenderFrameImpl::Delete` / `FrameDetached` /
  `WebFrameWidgetImpl::Close`, about 196ms, non-main frame
- at about 17.28s: the same teardown path, about 180ms, non-main frame

Those long iframe teardown tasks align with switching away from the hot-pink
preview. Other iframe deletes in the same trace are small, roughly 0.1-2.2ms.

The trace does not show all three HTML files doing heavy animation work at the
same time. HTML work is segmented by chat selection:

- hot-pink near 0-5.8s, 12-17.3s, and 22.2s through the end
- `screensaver.html` near 8.4-11.2s
- blue near 17.7-21.8s

That supports the earlier code-reading nuance: chat-group tabs are not mounted
as multiple `Chat` components at once. For this specific repro, the dominant
issue is the currently selected HTML iframe plus costly iframe destruction and
recreation while switching chat tabs. The hidden-preview-tab issue still applies
inside a single chat with multiple preview tabs, but it is not the main signal
in this trace.

There is also preview reload churn. `screensaver.html` begins a second iframe
navigation around 11.21s shortly before the route switches to the hot-pink chat
around 11.45s. That is consistent with preview state reset/revalidation causing
extra iframe work during chat-tab switching.

The main app renderer also has several long `entry.client` tasks around
30-50ms during the same trace. This keeps the main P0 route/transcript plan
relevant; the HTML preview path is an amplifier, not the whole bug.

### Trace-Adjusted Planning Notes

Use `hot-pink-screensaver.html` as the concrete HTML stress case. The
implementation agent should verify that switching away from that chat no longer
creates a visible 180-200ms stall.

The implementation plan should prioritize these checks in addition to the
generic preview fixes:

1. Confirm whether `Chat` remount from `<Chat key={displayThreadId}>` is
   forcing iframe teardown on every chat-group tab switch.
2. Preserve preview state across no-op loader revalidation before tackling more
   elaborate iframe caching, because trace evidence shows iframe reload churn.
3. Consider a bounded, explicit iframe lifecycle strategy for chat-tab switches:
   either defer teardown until idle, keep only the just-previous preview warm for
   a very short grace period, or unload inactive previews to `about:blank` after
   the UI transition. Do not keep many chat previews mounted indefinitely; that
   recreates the hidden-iframe power problem.
4. Add a manual regression check that records a short trace while switching
   away from hot-pink. Passing means no `RenderFrameImpl::Delete` /
   `WebFrameWidgetImpl::Close` task near 180-200ms during the user-visible tab
   switch.

## Renderer Paths Audited

### App Preview Iframe

App preview render state builds a URL such as `https://<app>.<iframe-host>`:

- `src/components/chat-preview/use-chat-preview-render-state.ts:75-96`

`PreviewPanelShell` renders app targets as raw iframes:

- `src/components/chat-preview/chat-preview-shell.tsx:257-274`

There is no iframe `sandbox` on app previews, which is probably intentional for
generated apps. The performance implication is that any active timers,
animation loops, workers, charts, or heavy app code inside hidden app preview
tabs can continue consuming CPU while mounted.

### Direct HTML File Preview

`FilePreviewContent` classifies HTML as a text-like preview type and fetches it
through the parent React component:

- `src/components/chat-file-preview/file-preview-content.tsx:179-182`
- `src/components/chat-file-preview/file-preview-content.tsx:223-252`

In preview mode, once the fetch succeeds, it renders `HtmlPreview`, which creates
an iframe pointed at the same URL:

- `src/components/chat-file-preview/file-preview-content.tsx:352-379`

`HtmlPreview` allows scripts, forms, modals, popups, and downloads, but not
same-origin access:

- `src/components/chat-file-preview/file-preview-content.tsx:130-149`
- existing test coverage:
  `tests/code-preview.test.tsx:160-186`

The sandbox looks security-conscious because it omits `allow-same-origin`, but
from a power/performance standpoint the iframe can still run script.

### Notebook HTML Output

Notebook output parsing tries native chart/table paths first, then falls back to
HTML if the output remains a `text/html` document:

- `src/components/chat-file-preview/notebook-preview/utils.ts:1020-1039`

The HTML fallback mounts a sandboxed `srcDoc` iframe:

- `src/components/chat-file-preview/notebook-preview/html-output.tsx:11-30`
- `src/components/chat-file-preview/notebook-preview/output-renderers.tsx:119-160`

Both notebook modes render all relevant cells/outputs eagerly:

- report mode maps all visible cells and outputs at
  `src/components/chat-file-preview/notebook-preview/report-mode.tsx:58-93`
- notebook mode maps all cells at
  `src/components/chat-file-preview/notebook-preview/notebook-mode.tsx:11-23`

This means a notebook with many raw HTML outputs can mount many iframe documents
at once. The parser intentionally leaves several complex HTML shapes in the
iframe path, including mixed tables/media, pandas styler output, and multi-index
tables:

- `src/components/chat-file-preview/notebook-preview/utils.ts:785-836`

### Published Single-File Renderer

`publish` copies a standalone React renderer bundle and injects the filename:

- `sandbox/create-worker/publish.mjs:91-130`

That renderer delegates back to `FilePreviewContent`:

- `sandbox/create-worker/renderer/main.tsx:139-146`

For an HTML file published as a standalone app and then shown in chat as an app
preview, the effective path can become nested:

1. chat preview app iframe loads the standalone renderer app
2. renderer app fetches `/files/<filename>`
3. `FilePreviewContent` creates an inner iframe for the HTML file

This is worth reproducing explicitly because it combines app-preview iframe cost
with direct HTML file preview cost.

### Dispatcher Error Pages

Transient app preview errors post a message to the parent so the chat can retry:

- `workers/dispatcher/src/error-pages.ts:258-263`

The same error page also runs a canvas animation loop and a spawn interval:

- `workers/dispatcher/src/error-pages.ts:286-329`

`Chat.tsx` retries transient iframe errors up to three times with a 2s delay,
and preview state refreshes can bump app iframe keys after a 1.5s loading
window:

- `src/components/Chat.tsx:999-1047`
- `src/components/Chat.tsx:1676-1718`

If several app iframes are mounted on transient deploy/error pages, they can
each run their own animation loop and retry cadence.

## Important Nuance: Many Active Chats

The active chat route renders one `Chat` component keyed by `displayThreadId`:

- `src/routes/_app.chat.$id.tsx:903-933`

So multiple open chat-group tabs are not simultaneously mounted as multiple
`Chat` components in this route. However:

- switching among chat tabs remounts/reinitializes the preview path for each
  selected chat
- `chatCache=1` can reuse message snapshots, but the loader still reads preview
  state for the selected thread
- within a single active chat, multiple preview tabs are definitely mounted at
  the same time

The user-facing "many active chats" symptom can still be caused by repeatedly
switching among chats whose selected preview state creates expensive iframes,
and by any one chat accumulating multiple preview tabs.

## Coupling To The Main Chat P0

The preview path interacts with the broader route revalidation issue in three
ways.

First, `buildChatData` always loads preview state, even when message loading is
skipped through `chatCache=1`:

- `src/routes/_app.chat.$id.tsx:160-240`
- cached tab-switch usage at `src/routes/_app.chat.$id.tsx:707-717` and
  `src/routes/_app.chat.$id.tsx:778-797`

For app preview tabs, the loader also calls `getWorkerScript` to apply public
visibility:

- `src/routes/_app.chat.$id.tsx:181-203`

Second, `Chat.tsx` normalizes initial preview tabs from loader data:

- `src/components/Chat.tsx:416-424`

Then an effect resets local preview state whenever the initial tab array or
active tab id identity changes:

- `src/components/Chat.tsx:973-997`

That reset clears iframe keys, file preview keys, view modes, notebook state,
loading state, timers, and mobile view. If a no-op route revalidation returns a
fresh but semantically identical preview tab array, this can create unnecessary
preview churn.

Third, even after the transcript revalidation fixes land, the preview panel can
still cause scroll jank if hidden iframes remain mounted and active.

## Recommended Fix Plan

### Phase A: Mount Only The Active Preview Tab

Change `PreviewPanelShell` so it renders tab chrome for all tabs but mounts
content only for the active tab.

Implementation shape:

- derive `activeTabState` once
- render only that tab state's app iframe or `FilePreviewContent`
- unmount inactive tab content completely
- keep `iframeRef` attached only to the active app iframe

If preserving app state across preview-tab switches is a product requirement,
use an explicit small warm-cache policy instead of mounting every tab forever:
for example active tab plus the previously active tab, with inactive iframe
`src` switched to `about:blank` after a short idle timeout.

Tests to add:

- inactive file preview tab does not render `FilePreviewContent`
- inactive app preview tab does not render an iframe
- switching active tab mounts exactly one iframe/content body
- closing the active tab clears any pending retry/refresh timer for that tab

This is the highest ROI preview-panel fix.

### Phase B: Make HTML File Preview Single-Load And Lazy

In HTML preview mode, render the iframe directly from `previewUrl` without first
fetching the HTML text into React state. Fetch the HTML text only when source
mode is active.

Current behavior double-loads preview HTML:

- parent fetch: `src/components/chat-file-preview/file-preview-content.tsx:223-252`
- iframe load: `src/components/chat-file-preview/file-preview-content.tsx:365-368`

Implementation shape:

- change `shouldFetchText` so HTML only fetches when `fileViewMode === 'source'`
- render `HtmlPreview` immediately in HTML preview mode
- move loading state for preview mode to iframe `onLoad` if a spinner is still
  desired
- keep fetch/error handling for source mode
- cache source text by `previewUrl` if users frequently toggle preview/source

Tests to add:

- HTML preview mode renders an iframe without calling `fetch`
- HTML source mode still calls `fetch` and renders `SourcePreview`
- toggling preview -> source fetches once for that URL/version
- existing sandbox assertion still passes and still excludes `allow-same-origin`

### Phase C: Preserve Preview State Across No-Op Revalidation

The main audit recommends adding `shouldRevalidate` to the active chat route.
That should happen first. In addition, make preview state reset semantic rather
than identity-based.

Implementation shape:

- compare incoming loader preview tabs by stable semantic fields:
  tab id, target kind, script/path/workspace/source/content type, and active id
- if semantically equal, do not reset iframe keys, file keys, view modes,
  notebook state, loading state, timers, or mobile view
- only update `isPublic` metadata in place when that is the sole difference
- keep explicit side-channel `preview_state` events as the source of intentional
  preview refreshes

Tests to add:

- no-op loader revalidation with a fresh tab array preserves `tabIframeKeys`
- no-op loader revalidation preserves file/source and notebook/report modes
- true target change still resets stale per-tab state

### Phase D: Lazy-Mount Notebook HTML Outputs

Notebook previews can mount many `srcDoc` iframes at once. Make iframe-heavy
outputs lazy.

Implementation shape:

- wrap `NotebookHtmlOutput` in an `IntersectionObserver` gate
- before visibility, render a fixed-height placeholder so scroll height remains
  stable
- mount the `srcDoc` iframe only when near the viewport
- unmount or freeze far-off iframe outputs if memory/CPU remains high
- consider the same lazy gate for Plotly/Vega outputs if profiling shows chart
  cost

Larger follow-up:

- virtualize notebook/report cells for large notebooks
- convert more table-like HTML to native `TableViewer` where fidelity allows
- keep complex styled tables, custom media, and script-heavy outputs behind the
  iframe path

Tests to add:

- raw HTML notebook output does not mount an iframe before intersection
- intersecting the placeholder mounts the iframe exactly once
- fixed placeholder dimensions avoid large layout shifts
- existing notebook parser tests continue to pass

### Phase E: App Iframe And Error-Page Hygiene

Once inactive app iframes are unmounted, this becomes less urgent, but it is
still worth tightening retry and error behavior.

Implementation shape:

- cancel pending iframe retry/refresh timers when a tab becomes inactive or is
  closed
- avoid bumping iframe keys for inactive tabs
- consider a static, low-power dispatcher error page when embedded in preview
  mode
- avoid canvas `requestAnimationFrame` loops on hidden/transient error pages
- add `loading="lazy"` to non-active or warm-cache iframes only if a warm-cache
  strategy survives Phase A; it is not a substitute for unmounting

Tests to add:

- transient error from inactive app tab does not schedule a visible refresh
- closing an app tab clears retry and refresh timers
- active app preview retry behavior remains unchanged

## Reproduction And Measurement Checklist

Before implementation, reproduce on the current code:

1. Open a chat with multiple preview tabs, including at least two app or HTML
   tabs.
2. In DevTools console, run `document.querySelectorAll('iframe').length` and
   verify inactive preview tabs still contribute iframes.
3. In the Network tab, open an HTML file preview and verify the same
   `previewUrl` is fetched by React and then loaded by the iframe.
4. Use Chrome Performance Monitor to compare CPU with:
   - no preview panel
   - one active HTML preview
   - multiple preview tabs with inactive HTML/app previews
   - a notebook with many raw HTML outputs
5. Test a transient deploy/error app preview and watch for multiple animation
   loops if several error-page iframes are mounted.
6. Switch among chat-group tabs with HTML/app previews and verify whether iframe
   count, JS heap, and CPU return to baseline after each switch.

Expected post-fix behavior:

- active chat preview has one mounted tab body by default
- HTML preview mode has one network load for the iframe, not a parent text fetch
  plus iframe load
- source mode still fetches and syntax-highlights HTML
- notebook HTML outputs mount only near the viewport
- no-op route revalidation does not reset preview iframe/file keys or view modes

## Suggested Test Commands

Run targeted tests after the implementation patch:

```bash
bun run test:run tests/code-preview.test.tsx tests/notebook-preview-utils.test.ts tests/preview-toolbar-notebook-download.test.tsx
```

Also run the new tests added for `PreviewPanelShell`, preview state
revalidation, and notebook HTML lazy mounting. Finish with:

```bash
bun run typecheck
```

## Priority Order

1. Mount only the active preview tab.
2. Stop double-loading HTML in direct file preview mode.
3. Preserve preview local state across semantically identical loader data.
4. Lazy-mount notebook HTML iframes and then consider notebook virtualization.
5. Tighten app preview retry/error-page power behavior.

Phases 1 and 2 are the most likely to reduce the specific HTML-renderer jank
quickly. Phase 3 prevents route revalidation from re-triggering preview work.
Phase 4 handles large notebooks. Phase 5 reduces edge-case CPU during preview
deploy failures.
