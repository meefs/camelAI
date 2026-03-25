# Usage Limit Error — Implementation Feedback

## Overall

Clean implementation. The component is well-structured, the regex is solid, spacer suppression and scroll-to-error are wired correctly. Two issues to fix, one minor polish item.

## Issues

### 1. Scroll fires before React commits the error DOM (Medium)

**File:** `src/components/Chat.tsx` ~line 2622-2630

The `requestAnimationFrame` scroll fires immediately after `setError()`, but React batches state updates — the error banner DOM node won't exist yet in that animation frame. The `scrollHeight` will reflect the *pre-error* layout, so it scrolls to the wrong position (or not far enough).

**Fix:** Use a double-rAF or, more idiomatically, `setTimeout(() => { ... }, 0)` after `setError` so the scroll happens after React's commit flush. Alternatively, use a `useEffect` that triggers scroll when `error` transitions from `null` to non-null — this guarantees the DOM is committed:

```typescript
// Near other effects in the component
const prevErrorRef = useRef<string | null>(null);
useEffect(() => {
  if (error && !prevErrorRef.current) {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }
  prevErrorRef.current = error;
}, [error]);
```

This is cleaner than the inline rAF approach and removes the scroll logic from the WebSocket handler where it doesn't belong.

### 2. `'use client'` directive is unnecessary (Low)

**File:** `src/components/usage-limit-error.tsx` line 1

This codebase uses React Router / Cloudflare Workers SSR, not Next.js App Router. The `'use client'` directive has no effect here — it's a Next.js-specific boundary marker. No other component in `src/components/` uses it. Remove it to stay consistent with the rest of the codebase.

## Polish

### 3. CTA description uses hyphen instead of arrow (Nit)

**File:** `src/components/usage-limit-error.tsx` line 85

The plan spec says `"Organization Settings → AI Provider"` but the implementation has `"Organization Settings - AI Provider"` (ASCII hyphen). Minor, but the arrow better conveys navigation hierarchy. Use `→` (U+2192) or `›` to match the intended design.
