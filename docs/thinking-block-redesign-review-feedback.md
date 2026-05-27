# Thinking Block Redesign Review Feedback

## Findings

1. **P1 — Thinking rows still render outside the compact trace group.**

   `src/components/message-bubble.tsx:435` pushes visible thinking blocks as `kind: 'other'`. The renderer only collects `kind: 'tool'` items into the compact `space-y-1` trace group at `src/components/message-bubble.tsx:557-580`, while non-tool sections fall back to the outer `space-y-4` layout at `src/components/message-bubble.tsx:586`.

   When a thinking block is followed by a tool call, the thinking row is flushed into its own message section before the tool trace group starts. That leaves the larger message-section gap between `thinking -> tool_use`, even though the redesigned row now visually matches `ToolCall`.

   Suggested fix: classify visible thinking rows with the trace/tool group, or broaden the grouping concept from `kind: 'tool'` to something like `kind: 'trace'` and include thinking/tool/task/teammate rows together. Add a regression test where a visible thinking block followed by a tool call renders inside the same compact trace group.

2. **P1 — Completed live Pi reasoning can stay labeled `Thinking` until reload.**

   `src/components/tool-call/thinking-block.tsx:26-29` preserves any provided `label`. Live Pi/runtime reasoning blocks commonly arrive with `label: 'Thinking'`, so when `isStreaming` flips to false the complete row still renders `Thinking`. After reload, persisted blocks can lack that runtime label, so the component falls back to `Thought`; this explains the reload-only correction.

   Suggested fix: treat `undefined` and `'Thinking'` as the ordinary reasoning label pair: `Thinking…` while streaming and `Thought` when complete. Preserve only distinct custom labels such as runtime `label: 'Plan'`.

3. **P2 — Kimi thinking prose can be rendered as accidental code blocks.**

   Kimi/OpenRouter thinking text can include large leading indentation on normal prose lines. In `/Users/illiana/Downloads/633b5e1c-5b06-4a05-a090-da1a9a4da79f.jsonl`, several thinking lines begin with 4 to 37 spaces, and the thinking text does not contain explicit fenced code blocks. Because `src/components/tool-call/thinking-block.tsx:91` passes raw `thinking` directly to `MarkdownRenderer`, Markdown interprets those provider-indented prose lines as indented code blocks.

   Suggested fix: normalize raw thinking markdown before rendering. Strip accidental leading indentation on non-fenced lines, while preserving explicit fenced code blocks. Add a regression test using a Kimi-style string like `"    Let me deploy now"` and verify it renders as prose rather than a `<pre><code>` block.

4. **P2 — Complete-state dot is grey, but the intended end state is success green.**

   `src/components/tool-call/thinking-block.tsx:52-54` uses `bg-muted-foreground` for non-streaming thinking rows. The product expectation is a green dot for the final `Thought` state.

   Suggested fix: switch the complete-state dot class to `bg-green-500` while keeping the existing pulsing blue streaming state.

## Non-Blocking Notes

- The new tests cover the per-block streaming state well. They do not cover row grouping/spacing, which is where the finding above sits.

## Verification

- `bun run test:run -- tests/thinking-block.test.tsx tests/message-bubble-thinking.test.tsx` passed.
- `bun run typecheck` passed. It emitted the existing Vite/React Router warnings about ignored Wrangler `rules` and deprecated `esbuild` option.
