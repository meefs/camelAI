# Agents SDK Follow-Up Opportunities

Context: chat transport has moved to Cloudflare Agents SDK routing/lifecycle (`routeAgentRequest`, `/agents/chat-thread/:threadId`, `useAgent`, and `ChatThreadDO extends Agent`). Recent migration work also moved several live state/control paths onto Agents SDK primitives.

Already moved to Agents SDK primitives:

- `streaming`, preview tabs/active tab/version, todos, context usage, pending question prompt, connection setup prompt, title, and selected model are represented as Agent state.
- Stop generation, preview-tab sync, question answers, connection setup response, model refresh, and user message submission use Agents SDK callable/RPC methods.
- Current-client handling no longer depends on custom `streaming_state`, `preview_state`, `todo_state`, `context_usage_state`, `ask_user_question`, `question_answered`, `connection_setup_prompt`, `connection_setup_answered`, `connection_setup_error`, `set_model`, `title_updated`, `thread_model_updated`, or `message_accepted` websocket messages.
- The browser connection ref/type uses Agent terminology instead of raw socket terminology.

The remaining custom code is mostly the camelAI app-layer message/replay protocol, chronological event streaming, and Pi turn orchestration.

## Principle

Use Agents SDK for state snapshots and request/response commands. Keep bespoke websocket events only for true chronological streams.

- **Agent state**: latest value / reconnect snapshot / UI status.
- **Agent RPC/callables**: client intent that expects acknowledgement or failure.
- **Custom event stream**: ordered assistant deltas, runtime events, SDK events, result/error events, and transcript-like historical events.

## Completed deletion target: user message submission

User message send/ack now uses the Agents SDK callable path:

```ts
await chatAgent.call("sendMessage", [content, clientMessageId]);
```

Server:

```ts
async sendMessage(content: string, clientMessageId: string): Promise<InitialUserMessageResult> {
  return this.handleClientUserMessage({ content, clientMessageId });
}
```

Deleted from the current app/client path:

- client raw `send(JSON.stringify({ type: "message" }))`
- server `onMessage` branch for `data.type === "message"`
- `ChatClientMessage` websocket input type
- `message_accepted` client branch and server event emission
- client acceptance timeout maps/helpers
- stale `streaming_state` broadcast
- legacy `ping`/`pong` runner command handling

The remaining send semantics are intentionally preserved through the RPC result: duplicate `clientMessageId` handling, in-flight duplicate coalescing, pending delivery draft acceptance/restoration, and reconnect re-flush of unaccepted queued user messages.

## Small immediate deletion targets

The tiny deletion pass has been completed for the current client/server. Continue to avoid reintroducing manual reconnect timers or latest-value websocket messages; prefer `useAgent` reconnect behavior, Agent state, and callables.

## Next major target: shrink `init` / `ready` / replay

The client still sends:

```ts
{ type: "init", threadId, lastEventId }
```

The server still responds:

```ts
{ type: "ready" }
```

This is now mostly used for replay negotiation and queued message flush.

Possible stronger Agents SDK shape:

```ts
await chatAgent.call("resume", [lastEventId]);
```

or eventually handle replay from `onConnect` using the Agents connection context/query plus Agent state.

Expected deletion if successful:

- client `ready` message branch
- parts of `ready` local state
- `handleChatInit` validation/response boilerplate
- some custom reconnect/flush coordination

Risk: high. Replay protects active streams and reconnects. Do this after user message RPC, or split into a small `resume(lastEventId)` callable first while preserving behavior.

## What should stay custom for now

Keep custom chronological event streaming for now:

- assistant deltas / `sdk_event`
- runtime events
- transcript result/error events
- app/code artifacts where ordering matters
- replayable chat history events

Do not force these into Agent state. Agent state is best for latest snapshots, not ordered historical streams.

## Suggested next implementation order

1. **Collapse `init` / `ready` into callable or connection lifecycle**
   - Start with `resume(lastEventId)` callable if that is safer.
   - Keep event replay chronological-only.
   - Remove `ready` only once queued send/replay behavior is proven.
   - After user-message RPC, queued send flush can be triggered from `resume()` success instead of a custom `ready` event.

2. **Prune stale worker tests and compatibility assumptions**
   - Tests that assert `message_accepted`, raw browser `type: "message"`, or ping/pong should be rewritten around `sendMessage()` RPC results.
   - Keep duplicate `clientMessageId`, in-flight duplicate, busy/error result, and pending draft restoration coverage.

3. **Only after that, reassess `AIChatAgent` / `useAgentChat`**
   - This could delete much more, but it is high-risk because camelAI/Pi emits many custom runtime/tool/billing/artifact events.
   - Revisit once commands and latest-state snapshots are mostly SDK-native.

## Verification baseline

For each cleanup PR/direct push, run at least:

```bash
bun run typecheck
bun run test:workers -- workers/main/tests/websocket-access.test.ts workers/main/tests/chat-websocket-mentions.test.ts
```

For user-message RPC work, add or run tests covering duplicate `clientMessageId`, reconnect resend, busy/error result, and message acceptance/draft restoration semantics if available.
