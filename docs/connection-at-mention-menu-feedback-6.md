# @ Mention Menu — Iteration 6 Feedback

**Date:** 2026-04-30
**Reviewing diff:** follow-up implementation of `connection-at-mention-menu-feedback-5.md`

---

## Summary

The `/chat` connected-tool button behavior is fixed: `WelcomeScreen` now builds the same collision-aware slug map as the mention menu and inserts `@<slug> ` instead of the old `Use my ... connection to ` prose.

Focused mention/display tests pass:

```bash
bun run test:run tests/connection-mentions.test.ts tests/markdown-renderer.test.ts tests/message-bubble-content-to-string.test.ts tests/task-notification-parser.test.ts tests/teammate-message.test.ts tests/thread-preview.test.ts
```

`bun run typecheck` still fails in the same unrelated repo areas as before (`_admin`, external file APIs, workspace file upload, MCP/env typings, screenshot queue, workspace cron). I did not see mention-specific typecheck failures.

One stale-mention correctness issue remains.

---

## Issue 1 — Annotated stale mentions can be rendered as the wrong live connection when a slug is reused

**Severity:** Bug / correctness

The stale mention implementation tracks only the annotated slug:

`src/lib/connection-mentions.ts:171-188`

```ts
export interface MentionAnnotationDisplay {
  displayText: string;
  annotatedSlugs: Set<string>;
}

export function stripMentionAnnotationsWithMetadata(
  body: string,
): MentionAnnotationDisplay {
  const annotatedSlugs = new Set<string>();
  const displayText = body.replace(MENTION_ANNOTATION_REGEX, (_annotation, offset) => {
    const slug = mentionSlugBefore(body, offset);
    if (slug) {
      annotatedSlugs.add(slug);
    }
    return '';
  });

  return { displayText, annotatedSlugs };
}
```

Then `MarkdownRenderer` reparses the stripped display text against the **current** slug map:

`src/components/markdown-renderer.tsx:157-175`

```tsx
const matches = parseMentions(text, slugMap).filter((m) =>
  m.integration !== null || staleMentionSlugs?.has(m.slug),
);
...
<MentionChip
  key={`${keyPrefix}-m${i}`}
  slug={m.slug}
  integration={m.integration as Integration | null}
/>
```

This works when the stale slug is absent from the current slug map. But if a user deletes/renames the original connection and later creates a different connection that produces the same slug, the historical message will render the old mention as a **live chip for the new connection**.

Example:

1. User sends `@camel`, stored as `@camel ⟦ref: other "Camel" id=old_conn⟧`.
2. `old_conn` is deleted.
3. A new connection named `Camel` is created with `id=new_conn`.
4. On reload, `stripMentionAnnotationsWithMetadata` records only `camel`.
5. `parseMentions('... @camel ...', currentSlugMap)` resolves `camel -> new_conn`.
6. The UI renders a live `@camel` chip for `new_conn`, even though the stored annotation proves the message referred to `old_conn`.

The annotation id should be authoritative for historical messages.

### Recommended fix

Preserve the annotated connection id along with the slug when stripping annotations.

Suggested shape:

```ts
export interface AnnotatedMentionRef {
  slug: string;
  id: string | null;
}

export interface MentionAnnotationDisplay {
  displayText: string;
  annotatedMentions: AnnotatedMentionRef[];
}
```

Implementation notes:

- Keep deriving `slug` from the text immediately before the annotation, as the current code does.
- Also parse `id=<id>` from the annotation string. The existing server format is:

```text
⟦ref: <type> "<name>" id=<id>⟧
```

- Avoid relying on replace callback argument positions if the regex gains capture groups. Either parse `id` from the full annotation string inside the callback, or use `matchAll` and build the result explicitly.

One possible extraction:

```ts
const idMatch = annotation.match(/\sid=([^⟧\s]+)/);
const id = idMatch?.[1] ?? null;
```

Then in the markdown rendering path, decide the chip integration using both the current slug map and the annotation metadata:

```ts
function resolveMentionChipIntegration(
  match: MentionMatch,
  currentIntegration: Integration | null,
  annotatedIdsForSlug: ReadonlySet<string> | undefined,
): Integration | null {
  // Unannotated text: current slug map is fine.
  if (!annotatedIdsForSlug) return currentIntegration;

  // Annotated historical text: only treat as live if the current integration
  // is the same id the annotation named. Otherwise render as stale/deleted.
  if (currentIntegration && annotatedIdsForSlug.has(currentIntegration.id)) {
    return currentIntegration;
  }

  return null;
}
```

Render a chip when either:

- `currentIntegration !== null` and there is no conflicting annotation, or
- there is annotation metadata for that slug, even if the resolved integration is `null`.

That preserves the current desired behavior:

- live current mentions render as live chips
- annotated old mentions whose connection is gone render as deleted/stale chips
- random unmatched `@words` remain plain text
- annotated old mentions do **not** silently retarget to a new connection with the same slug

### Tests to add

Add a regression test that covers slug reuse:

```tsx
render(
  createElement(ContentBlockRenderer, {
    content: 'Check @camel ⟦ref: other "Camel" id=old_conn⟧ please',
    mentionSlugMap: new Map([
      ['camel', {
        id: 'new_conn',
        integration_type: 'other',
        name: 'Camel',
        category: 'saas',
        auth_method: 'api_key',
        config: {},
        created_by: 'user',
        created_at: 1,
        updated_at: 1,
        has_credentials: true,
      }],
    ]),
  }),
);

expect(screen.getByText('@camel')).toHaveClass('bg-muted/60');
```

Also add a positive test proving the live style is kept when the annotation id matches the current connection id:

```tsx
content: 'Check @camel ⟦ref: other "Camel" id=same_conn⟧ please'
mentionSlugMap: new Map([['camel', integrationWithId('same_conn')]])

expect(screen.getByText('@camel')).toHaveClass('bg-muted');
expect(screen.getByText('@camel')).not.toHaveClass('bg-muted/60');
```

