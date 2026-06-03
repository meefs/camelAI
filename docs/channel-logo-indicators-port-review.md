# Channel Logo Indicators Port Review

Review date: 2026-06-02

## Findings

No blocking findings.

The implementation follows the port-forward plan: it keeps the feature out of `workers/main/src/auth.ts`, moves the OrgDO persistence work into `workers/main/src/identity/org-do.ts`, updates both split-auth `OrgThread` interfaces, uses V31 for the additive `channel_kinds` migration, and preserves the newer `chat-thread-do.ts` email sender and Telegram Markdown paths.

## Verification Run

```bash
bun run test:run tests/channel-indicators.test.tsx tests/message-bubble-parsers.test.ts
bun run typecheck
bun run test:workers -- workers/main/tests/auth-do.test.ts
bun run test:workers -- workers/main/tests/chat-thread-codex-external-turn.test.ts
```

Results:

- `tests/channel-indicators.test.tsx` and `tests/message-bubble-parsers.test.ts`: passed, 15 tests.
- `bun run typecheck`: passed.
- `workers/main/tests/auth-do.test.ts`: passed, 49 tests.
- `workers/main/tests/chat-thread-codex-external-turn.test.ts`: passed, 124 tests.

## Notes For The Implementing Agent

- The migration coverage includes the important sticky `schemaVersion = 30` case.
- The duplicate `OrgThread` type issue called out during plan review is addressed in both `identity/org-do.ts` and `identity/user-do.ts`.
- I did not run a browser/manual visual pass. Before merge, spot-check chat history and in-chat user message hover states in light and dark themes to confirm logo spacing, tooltip behavior, and no layout shift.
