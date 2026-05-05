# @ Mention Menu — Iteration 5 Feedback

**Date:** 2026-04-30
**Reviewing diff:** current branch vs `origin/main`, after measured composer decoration implementation

---

## Summary

The measured-decoration implementation is directionally correct. The composer now keeps native textarea text/caret behavior and draws the mention chip background separately, which is the right architecture for avoiding caret drift while keeping the chip visually padded.

Focused mention/display tests pass:

```bash
bun run test:run tests/connection-mentions.test.ts tests/message-bubble-content-to-string.test.ts tests/task-notification-parser.test.ts tests/teammate-message.test.ts tests/thread-preview.test.ts
```

`bun run typecheck` still fails, but the reported failures are in pre-existing/unrelated areas (`_admin`, external file APIs, workspace file upload, MCP/env typings, screenshot queue, workspace cron). I did not see typecheck failures in the mention files.

Remaining feedback is small but important.

---

## Issue 1 — New-chat connected-tool buttons still insert the old prose prompt

**Severity:** Bug / product mismatch

The new `@connection` flow is live in the composer, but the `/chat` welcome screen's connected-tool buttons still write the old sentence:

`src/components/welcome-screen/index.tsx:388-390`

```tsx
const handleConnectionSelect = useCallback((connection: Integration) => {
  onPromptChange(`Use my ${connection.name || connection.integration_type} connection to `);
  focusInput();
}, [onPromptChange, focusInput]);
```

This should now populate the composer with the selected connection mention instead:

```text
@selected_connection_slug
```

Use the same collision-aware slug map used by the mention menu. Do **not** manually slug `connection.name` directly, because duplicate connection names need the same `-2`, `-3`, etc. suffix behavior as menu insertion.

Suggested fix:

```tsx
import {
  buildSlugMap,
  slugForIntegration,
} from '@/lib/connection-mentions';

// inside WelcomeScreen
const connectionSlugMap = useMemo(
  () => buildSlugMap(connections) as Map<string, Integration>,
  [connections],
);

const handleConnectionSelect = useCallback((connection: Integration) => {
  const computedSlug = slugForIntegration(connection, connectionSlugMap);
  if (!computedSlug) return;

  onPromptChange(`@${computedSlug} `);
  focusInput();
}, [connectionSlugMap, onPromptChange, focusInput]);
```

Behavior notes:

- Keep replacing the current welcome input, matching the previous connected-tool card behavior.
- Keep the trailing space so the user can immediately continue typing.
- If `slugForIntegration` returns `null` because the connection name slugs to an empty string, no-op is acceptable. Those connections already cannot be inserted from the mention menu.

Verification:

1. Go to `/chat` with at least one configured connection.
2. Click a connected-tool button under "Your connected tools".
3. Confirm the composer contains `@<slug> `, not `Use my <name> connection to `.
4. Confirm duplicate names use the same collision suffixes as the `@` menu.
5. Send the message and confirm the agent still receives the resolved connection annotation/context.

---

## Issue 2 — Deleted/renamed connection mentions currently lose chip styling

**Severity:** Latent polish / consistency bug

`MentionChip` supports a deleted/stale state:

`src/components/connection-mention-menu/mention-chip.tsx:16-20`

```tsx
const isDeleted = integration === null;

return (
  <span className={cn(CHIP_BASE, isDeleted ? CHIP_DELETED : CHIP_LIVE)}>
```

But the markdown rendering path filters unknown mentions out before rendering chips:

`src/components/markdown-renderer.tsx:155-158`

```tsx
const matches = parseMentions(text, slugMap).filter((m) => m.integration !== null);
if (matches.length === 0) return [text];
```

That means if a historical message contains `@old_connection ⟦ref: ...⟧` and the connection is later deleted or no longer present in the current `slugMap`, the displayed message will render plain `@old_connection` text after annotation stripping, not the muted/deleted chip style. This conflicts with the existence of the deleted chip variant and with the earlier stale-reference behavior.

Recommended approach:

- Preserve enough information from the `⟦ref: ...⟧` annotation before stripping it to know that an unmatched `@slug` was once a real connection mention.
- Render those annotated-but-unresolved mentions as `<MentionChip slug={slug} integration={null} />`.
- Continue leaving random unmatched `@words` as plain text.

This likely means the display pipeline should parse annotations before `stripSystemMessageTags` removes them, or expose a helper that returns both:

```ts
{
  displayText: string;
  staleMentionSlugs: Set<string>;
}
```

Then `replaceMentionsInText` can render chips for:

- `m.integration !== null` → live chip
- `staleMentionSlugs.has(m.slug)` → deleted/stale chip
- everything else → plain text

If stale/deleted chips are intentionally out of scope now, remove the deleted styling path from `MentionChip` to avoid dead/unclear behavior.

Verification:

1. Send a message with `@camel`.
2. Simulate loading that message with the stored annotation present but without `camel` in the current slug map.
3. Confirm the UI shows a muted/deleted chip, not raw/plain `@camel`, if stale chips remain a requirement.

---
