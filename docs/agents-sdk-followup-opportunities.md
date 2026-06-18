# Agents SDK Follow-Up Opportunities

Context: chat transport has moved to Cloudflare Agents SDK routing/lifecycle (`routeAgentRequest`, `/agents/chat-thread/:threadId`, `useAgent`, and `ChatThreadDO extends Agent`). The current follow-up PR also moves live state/control paths further onto Agents SDK primitives:

- streaming, preview tabs/active tab/version, todos, and context usage are represented as Agent state
- stop generation and preview-tab sync use Agents SDK RPC/callable methods
- custom `streaming_state`, `preview_state`, `todo_state`, and `context_usage_state` websocket messages are removed from the current client/server path

The remaining custom code is mostly the camelAI app-layer realtime protocol, chronological event streaming, and Pi turn orchestration.

## Principle

Use Agents SDK for state snapshots and request/response commands. Keep bespoke websocket events only for true chronological streams.

- **Agent state**: latest value / reconnect snapshot / UI status.
- **Agent RPC/callables**: client intent that expects acknowledgement or failure.
- **Custom event stream**: ordered assistant deltas, runtime events, SDK events, and transcript-like historical events.

## Highest-value deletion targets

1. **Move pending prompts to Agent state + RPC**
   - Move current `ask_user_question` prompt state into Agent state.
   - Replace `question_response` JSON messages with a callable like `answerQuestion(questionId, answers)`.
   - Consider moving connection setup prompt/error state into Agent state too.
   - Replace `connection_setup_response` / cancel JSON messages with callables such as `submitConnectionSetupResponse(...)` and `cancelConnectionSetup(...)`.
   - Expected deletion: more `sendDirect(...)` prompt replay, client `data.type === ...` branches, and custom reconnect restoration.
   - Risk: medium; prompts are stateful but not token-stream-critical.

2. **Move more client commands to callable Agent methods**
   - Already moved: `stop` → `requestStop()`, `set_preview_tabs_state` → `setPreviewTabsState(...)`.
   - Good next candidates:
     - `set_model` → `setThreadModel(model)` or `refreshModel()`
     - `message` → `sendMessage(content, clientMessageId)` eventually
     - `question_response` → `answerQuestion(questionId, answers)`
     - connection setup response/cancel → callables
   - This should shrink `ChatThreadDO.onMessage` toward only streaming/event compatibility handling.
   - Risk: medium; user-message delivery has idempotency/ack semantics, so migrate it after smaller commands.

3. **Move remaining latest-value UI state to Agent state**
   - Already moved: streaming, preview, todos, context usage.
   - Good candidates:
     - pending ask-user-question prompt
     - connection setup prompt/error
     - selected thread model / model update state
     - current title/thread metadata where the UI treats it as latest state
     - active automation/run status if it is latest-state UI
   - Avoid Agent state for transcript-like deltas or logs.
   - Risk: low/medium depending on each state owner.

4. **Shrink custom init/ready/replay plumbing after state migration**
   - Current leftovers include client `lastEventId`, server `handleChatInit`, `chatEventBuffer`, `pushChatEvent`, and `replayChatEvents`.
   - As more latest-value data moves to Agent state, replay should only cover chronological chat/runtime events.
   - Then reassess whether `ready` and parts of `init` can collapse.
   - Risk: medium/high because replay protects active streams and reconnects.

5. **Evaluate `AIChatAgent` / `useAgentChat` later**
   - This is the largest possible cut: replace much of the bespoke chat stream protocol with the SDK chat abstraction.
   - Do not start here first. camelAI/Pi still emits custom SDK/runtime/tool/preview/todo/billing/connection-setup events that may not fit cleanly.
   - Reassess after state snapshots and client commands are mostly SDK-native.
   - Risk: high.

6. **Clean up leftover websocket helper boundaries**
   - `workers/main/src/routes/websocket.ts` now contains non-chat websocket/status and runner-message helper code.
   - Move helpers into more precise files and delete/rename the generic chat websocket route module when practical.

## Suggested next PR

A good next aggressive-but-contained PR:

**Move pending ask-user-question and connection setup state to Agent state, and migrate their client responses to callable methods.**

Target changes:

- Add pending prompt/connection setup fields to `ChatThreadAgentState`.
- Replace direct `ask_user_question` and connection setup prompt websocket messages with Agent state updates.
- Replace client `question_response` send with `agent.call("answerQuestion", [questionId, answers])`.
- Replace connection setup response/cancel sends with callables.
- Delete corresponding client `data.type` branches and server `onMessage` switch cases.
- Keep chronological event replay untouched in that PR.

Validation:

```bash
bun run typecheck
bun run test:workers -- workers/main/tests/websocket-access.test.ts workers/main/tests/chat-websocket-mentions.test.ts
```

Add or update focused tests if the prompt/connection setup flows have existing worker or component coverage.
