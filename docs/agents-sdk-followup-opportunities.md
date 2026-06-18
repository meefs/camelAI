# Agents SDK Follow-Up Opportunities

Context: chat transport has moved to Cloudflare Agents SDK routing/lifecycle (`routeAgentRequest`, `/agents/chat-thread/:threadId`, `useAgent`, and `ChatThreadDO extends Agent`). The remaining custom code is mostly the camelAI app-layer realtime protocol.

## Highest-value deletion targets

1. **Replace custom init/ready/replay plumbing**
   - Current leftovers include client `lastEventId`, server `handleChatInit`, `chatEventBuffer`, `pushChatEvent`, and `replayChatEvents`.
   - Prefer Agents state or SDK-managed chat recovery where possible.
   - Risk: medium/high because this currently protects active streams and reconnects.

2. **Move durable live UI state to Agent state**
   - Good candidates: `todo_state`, `preview_state`, `streaming_state`, current model/thread metadata.
   - Use `setState`/Agent state sync so reconnects receive current state without custom replay messages.
   - Risk: medium; start here before changing token stream events.

3. **Replace JSON client commands with callable Agent methods**
   - Good candidates: send user message, answer ask-user-question, stop turn, set model, refresh preview.
   - This can shrink the `onMessage` switch and scattered `socket.send(JSON.stringify(...))` calls.
   - Risk: medium; commands are easier to migrate than stream output.

4. **Evaluate `AIChatAgent` / `useAgentChat`**
   - This is the largest possible cut: replace much of the bespoke chat stream protocol with the SDK chat abstraction.
   - Risk: high because camelAI/Pi emits custom SDK/runtime/tool/preview/todo/billing events that may not fit cleanly.
   - Reassess after state and commands are moved closer to SDK primitives.

5. **Clean up leftover websocket helper boundaries**
   - `workers/main/src/routes/websocket.ts` now contains non-chat websocket/status and runner-message helper code.
   - Move helpers into more precise files and delete/rename the generic chat websocket route module when practical.

## Suggested next PR shape

A good next aggressive-but-contained PR is: move non-streaming live state to Agent state and convert a small set of client commands to callable methods. After that, revisit whether `init`/`ready`/`lastEventId`/`chatEventBuffer` can collapse entirely.
