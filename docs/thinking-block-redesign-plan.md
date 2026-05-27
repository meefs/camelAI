# Thinking Block Redesign — Implementation Plan

**May 26, 2026**

---

## Overview

The thinking block currently renders as an italicized, low-contrast row that visually breaks pattern with the rest of the assistant trace (tool calls). Inside, it shows raw thinking text in `whitespace-pre-wrap`, which means any markdown the model emits (`**bold**`, `# headings`, `- bullets`, fenced code) reads as raw symbols.

Three changes:

1. **Collapsed row matches tool calls.** Same dot + label + chevron layout as `ToolCall`, same typography, no italics. The block becomes a peer of the tool rows above and below it in the trace.
2. **Status dot.** Pulsing blue while the agent is actively streaming thinking, green success dot once it's done. Keep the row shape and motion behavior aligned with `ToolCall`.
3. **Expanded state renders markdown.** Pipe the thinking text through `MarkdownRenderer` so `**bold**`, headings, bullets, and fenced code render properly. Drop the italic styling. Preserve the existing runtime reasoning-summary section (`ThinkingBlock.summaries`) for runtimes that emit summaries separately from raw thinking.

**Runtime context.** camelAI's current chat runtime is Pi. The browser still receives two event families:

- `runtime_event` is the Pi-backed path. `Chat.tsx` currently passes these events to `applyRuntimeEventToMessages(..., "codex", ...)`, but the `"codex"` runtime bucket is not OpenAI-only. Pi can route the selected thread model to Anthropic, OpenAI, OpenRouter, or Bedrock depending on the model and BYOK/hosted configuration.
- `sdk_event` is the legacy/SDK-style streaming path. It still supports Anthropic-style `thinking_delta` / `signature_delta` events and produces the same `ContentBlock` shape for rendering.

The redesign should target the shared front-end `ContentBlock` contract, not provider-specific OpenAI response details. Current model IDs are `opus-4.7`, `opus`, `sonnet`, `haiku`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and OpenRouter-backed Gemini/DeepSeek/Kimi/Grok models. Do not describe this feature as `o1` / `o3` behavior.

**File scope.** This is a small rendering change set:

- `src/components/tool-call/thinking-block.tsx` — rewrite
- `src/components/message-bubble.tsx` — pass a per-thinking-block `isStreaming` prop through while preserving existing tool-call `agentContinued` logic
- No new components, no new dependencies

**Out of scope.**

- The collapsed turn summary (`TurnSummaryBar`) — already exists, untouched. The redesigned thinking block continues to render inside the trace region of a `TurnSummaryBar` when the turn is complete.
- Redacted thinking blocks — already filtered out in `message-bubble.tsx` (`isRedactedThinkingBlock`), no behavioral change.
- Streaming reducer, JSONL parser, or any backend code — unchanged.
- The `summaries` array (runtime reasoning summaries) — keep the existing rendering, only restyle slightly for consistency.

---

## Visual Anatomy

### Collapsed — streaming

```
┌──────────────────────────────────────────────────┐
│  ●  Thinking…                                ›   │
└──────────────────────────────────────────────────┘
   ↑                                          ↑
   blue, pulsing dot                          chevron
   (w-1.5 h-1.5 bg-blue-500                   (hidden until
    animate-pulse)                             hover, like
                                               tool calls)
```

### Collapsed — complete

```
┌──────────────────────────────────────────────────┐
│  ●  Thought                                  ›   │
└──────────────────────────────────────────────────┘
   ↑
   green success dot, no animation
```

### Expanded — complete (markdown rendered)

```
┌──────────────────────────────────────────────────┐
│  ●  Thought                                  ⌄   │
│  │                                                │
│  │   The user wants me to add a new endpoint.     │
│  │                                                │
│  │   **Plan**                                     │ ← rendered <strong>
│  │     • Wire up the route handler                │ ← rendered <ul><li>
│  │     • Validate the payload                     │
│  │     • Write a test                             │
│  │                                                │
│  │   ```ts                                        │ ← rendered code block
│  │   const handler = (req) => …                   │
│  │   ```                                          │
│  │                                                │
└──────────────────────────────────────────────────┘
   ↑
   indent + left border (existing pattern)
```

### Expanded — with runtime reasoning summaries

```
┌──────────────────────────────────────────────────┐
│  ●  Thought                                  ⌄   │
│  │                                                │
│  │   ┌────────────────────────────────────────┐  │
│  │   │  Summary 1                             │  │
│  │   │  Decided to use a state machine.       │  │
│  │   └────────────────────────────────────────┘  │
│  │                                                │
│  │   ┌────────────────────────────────────────┐  │
│  │   │  Summary 2                             │  │
│  │   │  Validation lives at the boundary.     │  │
│  │   └────────────────────────────────────────┘  │
│  │                                                │
│  │   (raw thinking text — rendered as markdown)   │
│  │                                                │
└──────────────────────────────────────────────────┘
```

When there are no summaries, the summary section is omitted entirely (current behavior).

---

## State model

Match the `ToolCall` visual pattern. The block is in one of two visual states:

| State        | When                                                                   | Dot                                       | Label       |
| ------------ | ---------------------------------------------------------------------- | ----------------------------------------- | ----------- |
| `streaming`  | `isStreaming === true` **and** `thinkingContinued === false`           | `bg-blue-500 animate-pulse`               | `Thinking…` |
| `complete`   | Anything else (agent moved past it, or message no longer streaming)   | `bg-green-500`                            | `Thought`   |

The thinking continuation signal should be computed separately from the tool-call continuation signal. `ToolCall` intentionally treats only downstream `text` / `tool_result` blocks as proof that a tool has completed. Thinking is different: if the model has emitted any later visible block, including a downstream `tool_use`, it has moved past that thought. This is more precise than relying on message-level `isStreaming` alone, which stays true for the entire assistant turn.

Concretely:

- Keep the existing tool continuation semantics unchanged.
- Add a thinking-specific continuation map. A thinking block is active only when the containing message is streaming and no later visible non-redacted block exists.
- Later `text`, `tool_use`, `tool_result`, visible `thinking`, `teammate_message`, `task_notification`, and `error` blocks should stop the pulse for an earlier thinking block.

Edge cases:

- **Empty thinking block during streaming**: still renders the streaming row. The legacy `sdk_event` path filters empty thinking blocks in `finalizeStreamingMessage`. The Pi `runtime_event` path can also create summary-only thinking blocks, so do not assume every persisted thinking block has raw `thinking` text.
- **Redacted thinking**: short-circuited upstream by `isRedactedThinkingBlock` in `message-bubble.tsx`, never reaches this component.
- **Summaries only, no `thinking` text**: still considered "thinking" visually; the expanded state shows summaries; the dot follows the same `streaming` / `complete` rule.
- **Ordinary Pi reasoning labels**: live Pi/runtime reasoning blocks commonly carry `label: 'Thinking'`. Treat `undefined` and `'Thinking'` as the ordinary reasoning label pair: `Thinking…` while active, `Thought` when complete. This avoids the live UI staying stuck on `Thinking` until a reload drops the runtime label.
- **Plan blocks**: runtime `plan` items are also represented as `thinking` content blocks with `label: 'Plan'`. Preserve distinct custom labels like `'Plan'` rather than forcing every complete row to read `Thought`.
- **Kimi/OpenRouter leading indentation**: Kimi can emit thinking text with large accidental leading indentation on normal prose lines. Markdown interprets lines beginning with four spaces as indented code blocks, so normalize leading indentation before passing raw thinking into `MarkdownRenderer`. Preserve explicit fenced code blocks; the goal is only to prevent accidental indented-code rendering from provider formatting.

---

## File-by-file changes

### 1. `src/components/tool-call/thinking-block.tsx` — rewrite

Replace the entire component. The new component mirrors `ToolCall`'s shell (`Collapsible` + dot + label + chevron) while keeping the existing `summaries` block and switching to markdown rendering for the raw `thinking` text.

```tsx
"use client";

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { MarkdownRenderer } from '@/components/markdown-renderer';
import { cn } from '@/lib/utils';

interface ThinkingBlockProps {
  thinking: string;
  /** True only while the agent is actively streaming this thinking block. */
  isStreaming?: boolean;
  defaultExpanded?: boolean;
  label?: string;
  summaries?: string[];
}

export function ThinkingBlock({
  thinking,
  isStreaming = false,
  defaultExpanded = false,
  label,
  summaries = [],
}: ThinkingBlockProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const isOrdinaryThinkingLabel = !label || label === 'Thinking';
  const displayLabel = isOrdinaryThinkingLabel
    ? isStreaming ? 'Thinking…' : 'Thought'
    : isStreaming ? `${label}…` : label;
  const normalizedThinking = normalizeThinkingMarkdown(thinking);

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
      <CollapsibleTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          className={cn(
            "thinking-block group/thinking flex w-full items-center gap-2 py-1 text-sm text-muted-foreground",
            "hover:bg-muted/30 rounded px-2 -mx-2 cursor-pointer text-left",
            "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
          )}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setIsExpanded(prev => !prev);
            }
          }}
        >
          <span
            className={cn(
              "thinking-block__dot w-1.5 h-1.5 rounded-full shrink-0",
              isStreaming
                ? "bg-blue-500 animate-pulse motion-reduce:animate-none"
                : "bg-green-500",
            )}
          />
          <span className="min-w-0 flex-1 truncate">{displayLabel}</span>
          <ChevronRight
            className={cn(
              "thinking-block__chevron h-4 w-4 text-muted-foreground/50 opacity-0 transition-all duration-150",
              "group-hover/thinking:opacity-100",
              isExpanded && "opacity-100 rotate-90",
            )}
          />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up",
          "motion-reduce:animate-none",
        )}
      >
        <div className="pl-4 mt-1 space-y-3 text-xs text-muted-foreground/80 border-l border-border/40 ml-1">
          {summaries.length > 0 ? (
            <div className="space-y-2">
              {summaries.map((summary, index) => (
                <div
                  key={`thinking-summary-${index}`}
                  className="rounded-md bg-muted/30 px-3 py-2 text-muted-foreground/90"
                >
                  <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
                    Summary {summaries.length > 1 ? index + 1 : ''}
                  </div>
                  <div className="whitespace-pre-wrap">{summary}</div>
                </div>
              ))}
            </div>
          ) : null}
          {normalizedThinking.trim().length > 0 ? (
            <div className="thinking-block__markdown">
              <MarkdownRenderer content={normalizedThinking} isStreaming={isStreaming} />
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function normalizeThinkingMarkdown(value: string): string {
  const lines = value.replace(/\r\n/g, '\n').split('\n');
  let inFence = false;

  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line.trimStart();
      }

      if (inFence) return line;

      // Some providers, notably Kimi through OpenRouter, prefix ordinary
      // thinking prose with 4+ spaces. Markdown treats that as a code block.
      return line.replace(/^[ \t]{4,}(?=\S)/, '');
    })
    .join('\n')
    .trim();
}
```

**Key diffs from the existing component:**

| Aspect             | Before                                              | After                                                            |
| ------------------ | --------------------------------------------------- | ---------------------------------------------------------------- |
| Wrapper element    | `<button>`                                          | `<div role="button" tabIndex={0}>` + keyboard handler (matches `ToolCall`) |
| Vertical padding   | none                                                | `py-1` (matches `ToolCall`)                                      |
| Text color         | `text-muted-foreground/60 italic`                   | `text-muted-foreground` (no italic, matches `ToolCall`)          |
| Hover bg           | `hover:bg-muted/20`                                 | `hover:bg-muted/30` (matches `ToolCall`)                         |
| Status dot         | none                                                | `w-1.5 h-1.5 rounded-full` — blue+pulse while streaming, green otherwise |
| Label text         | always `"{label}..."`                               | Ordinary reasoning: `"Thinking…"` while streaming, `"Thought"` when complete; distinct custom labels like `"Plan"` are preserved |
| Raw thinking text  | `<div className="whitespace-pre-wrap">…</div>`      | Normalize accidental provider indentation, then `<MarkdownRenderer content={normalizedThinking} isStreaming={isStreaming} />` |
| Summary label      | `Thinking Summary {n}`                              | `Summary {n}` (shorter, less redundant)                          |
| Summary text color | `text-muted-foreground/80` + `not-italic` overrides | `text-muted-foreground/90` (no italic overrides needed)          |

**Why use `MarkdownRenderer`:** It's the same component used for assistant text replies (`message-bubble.tsx:348, 398`). It runs through `react-markdown` with `remark-gfm` and the project's existing sanitizer. Reusing it gives consistent typography for code fences, lists, and inline formatting between the agent's reply and its thinking, with no new dependencies.

**Why not change the keyboard activation pattern:** `ToolCall` uses `<div role="button">` with an explicit `onKeyDown` handler for Enter/Space — copying that exactly keeps the two trace rows behaviorally identical and avoids the `<button>` default-submit pitfall when nested inside a form.

**Note on label fallback:** the new default static label is `Thought` (past tense, since the block represents finished reasoning by the time the user sees the static state). When `isStreaming` is true, ordinary reasoning shows `Thinking…`. Treat both `label === undefined` and `label === 'Thinking'` as ordinary reasoning. Preserve only distinct custom labels, for example runtime `plan` items using `'Plan'`.

**Note on markdown normalization:** do not render raw provider indentation directly. In the sample Kimi JSONL transcript (`/Users/illiana/Downloads/633b5e1c-5b06-4a05-a090-da1a9a4da79f.jsonl`), several normal thinking prose lines begin with 4 to 37 spaces and there are no explicit fenced code blocks in the thinking text. Without normalization, `MarkdownRenderer` correctly but undesirably treats those lines as indented code. Strip accidental leading indentation on non-fenced lines before rendering.

### 2. `src/components/message-bubble.tsx` — pass per-block `isStreaming` to `ThinkingBlock`

Two adjustments inside the `ContentBlockRenderer` function. The first is in the block-classification pass: keep the existing tool-call continuation map, and add a separate thinking continuation map. The second is the render call itself.

**a) Extend the precomputation (lines ~375–385) with a separate thinking continuation map.**

Current code (lines 375–385):

```ts
const agentContinuedAfterIndex = new Map<number, boolean>();
let hasAgentContinuationAfterCurrentBlock = false;
for (let index = content.length - 1; index >= 0; index -= 1) {
  const block = content[index];
  if (block.type === 'tool_use') {
    agentContinuedAfterIndex.set(index, hasAgentContinuationAfterCurrentBlock);
  }
  if (block.type === 'text' || block.type === 'tool_result') {
    hasAgentContinuationAfterCurrentBlock = true;
  }
}
```

Update to preserve the existing tool continuation semantics and add thinking-specific semantics:

```ts
const agentContinuedAfterIndex = new Map<number, boolean>();
const thinkingContinuedAfterIndex = new Map<number, boolean>();

let hasToolContinuationAfterCurrentBlock = false;
let hasThinkingContinuationAfterCurrentBlock = false;

for (let index = content.length - 1; index >= 0; index -= 1) {
  const block = content[index];

  if (block.type === 'tool_use') {
    agentContinuedAfterIndex.set(index, hasToolContinuationAfterCurrentBlock);
  }

  if (block.type === 'thinking') {
    thinkingContinuedAfterIndex.set(index, hasThinkingContinuationAfterCurrentBlock);
  }

  if (block.type === 'text' || block.type === 'tool_result') {
    hasToolContinuationAfterCurrentBlock = true;
  }

  if (
    block.type === 'text' ||
    block.type === 'tool_use' ||
    block.type === 'tool_result' ||
    block.type === 'teammate_message' ||
    block.type === 'task_notification' ||
    block.type === 'error' ||
    (block.type === 'thinking' && !isRedactedThinkingBlock(block))
  ) {
    hasThinkingContinuationAfterCurrentBlock = true;
  }
}
```

Be careful with the ordering: a block must record its own continuation value *before* it flips the relevant downstream flag. The conditional ordering above preserves that. A `tool_use` should not make itself complete, but it should stop the pulse for a preceding thinking block.

**b) Update the render call to pass both props (line ~419).**

Current:

```tsx
if (block.type === 'thinking') {
  items.push({
    kind: 'other',
    key: `thinking-${index}`,
    node: <ThinkingBlock thinking={block.thinking} label={block.label} summaries={block.summaries} />,
  });
  return;
}
```

New:

```tsx
if (block.type === 'thinking') {
  const thinkingContinued = thinkingContinuedAfterIndex.get(index) ?? false;
  const blockIsStreaming = isStreaming && !thinkingContinued;
  items.push({
    kind: 'other',
    key: `thinking-${index}`,
    node: (
      <ThinkingBlock
        thinking={block.thinking}
        label={block.label}
        summaries={block.summaries}
        isStreaming={blockIsStreaming}
      />
    ),
  });
  return;
}
```

This gives the precise per-block streaming signal: the dot pulses only while the model is actively producing thinking deltas, and stops the moment the agent moves on to a tool call or text reply.

### 3. No other files touched

- `src/types.ts` — `ThinkingBlock` interface is unchanged; we only add a UI prop, not a data field.
- `src/lib/streaming.ts` — unchanged.
- `src/lib/runtime-message-state.ts` — unchanged.
- `services/sandbox-host/...` — unchanged.

---

## Components & dependencies used

All existing — **no new packages, no new shadcn components, no new icons.**

- `Collapsible` / `CollapsibleTrigger` / `CollapsibleContent` from `@/components/ui/collapsible` (already used by both `ToolCall` and the existing thinking block)
- `ChevronRight` from `lucide-react`
- `MarkdownRenderer` from `@/components/markdown-renderer` (already used for assistant text replies)
- `cn` from `@/lib/utils`
- Tailwind utility classes only — no new keyframes or globals.css additions
- `animate-pulse` and `animate-collapsible-down` / `-up` keyframes — already defined in `globals.css`

The pulsing-dot pattern is the exact same markup as `ToolCall` (`tool-call.tsx:152`).

---

## Behavioral notes

- **Reduced motion**: `motion-reduce:animate-none` is applied to both the dot's pulse and the collapsible's open/close animation, matching `ToolCall`.
- **Keyboard**: Enter and Space toggle expanded state when the row has focus (parity with `ToolCall`).
- **Focus ring**: `focus-visible:ring-1 focus-visible:ring-ring/50` matches `ToolCall`.
- **Hover affordance**: the chevron only appears on hover (or when expanded), matching `ToolCall`. The dot is always visible.
- **Markdown safety**: `MarkdownRenderer` already sanitizes via `rehype-sanitize`, so model-emitted HTML in thinking is handled identically to model-emitted HTML in replies. No additional safety work needed.
- **Streaming markdown**: passing `isStreaming` to `MarkdownRenderer` tells it to render incomplete code fences / lists more gracefully (existing behavior, used by every other streaming surface).
- **Trace context**: the redesigned block lives inside a `<TurnSummaryBar>` for completed turns (already wired up in `chat-messages-view.tsx`). It also continues to render inline during active streaming (before the summary bar collapses around it). Both contexts use the same row dimensions, so the visual feels continuous.

---

## Testing

### Manual verification

1. **Streaming state, Claude/Pi.** Send a prompt that triggers a long thinking phase on a current Claude model such as Sonnet 4.6, Opus 4.6, or Opus 4.7. Verify:
   - A `● Thinking…` row appears in the trace with a pulsing blue dot.
   - Expanding it during streaming shows live-streaming markdown — `**bold**` renders as `<strong>`, headings as `<h1>` etc.
   - The dot stops pulsing and the label flips to `Thought` the moment the agent starts producing text or fires its next tool call.
2. **Streaming state, GPT/OpenRouter/Pi.** Send a prompt to a current GPT model (`gpt-5.4`, `gpt-5.5`) or an OpenRouter-backed reasoning model. Verify:
   - Same pulsing-dot indicator.
   - If the runtime emits reasoning summaries, expanded state shows summary boxes (`Summary 1`, `Summary 2`, …) above the raw thinking, both rendered with the new tighter styling.
3. **Complete state.** After streaming finishes, the row should read `● Thought` with a green (non-pulsing) dot.
4. **Hover & keyboard.** Hover the row — chevron appears, hover bg lights up. Tab to focus the row — focus ring appears. Press Enter / Space — toggles expanded.
5. **Reduce motion.** With macOS "Reduce motion" enabled, the dot is static blue (no pulse) during streaming, and expansion is instant.
6. **Refresh.** Reload a thread mid-turn or after completion. Thinking blocks render in their `complete` state with full markdown rendering. No empty/phantom rows.
7. **Inside `TurnSummaryBar`.** On any completed turn, expand the turn summary; verify the redesigned thinking row lines up visually with the tool-call rows above and below it (same height, same horizontal indent, same dot position).
8. **Markdown content.** Test thinking blocks with: fenced code, lists, headings, bold/italic, inline code, blockquotes — all should render through the same pipeline as assistant text replies.
9. **Kimi/OpenRouter indentation.** Replay or inspect a Kimi reasoning turn with accidentally indented thinking prose. Normal prose lines that begin with 4+ provider-inserted spaces should render as prose, not as code blocks. Explicit fenced code blocks should still render as code.

### Unit tests

`tests/thinking-block.test.tsx` (new, Vitest + Testing Library):

- Renders `Thinking…` label and pulsing dot when `isStreaming={true}`.
- Renders `Thought` label and green non-pulsing dot when `isStreaming={false}`.
- Treats `label="Thinking"` the same as no label: `Thinking…` while streaming and `Thought` when complete.
- Renders distinct custom labels (for example `label="Plan"`) verbatim in complete state; appends `…` in streaming state.
- Click toggles expanded; chevron rotates; expanded state shows `MarkdownRenderer` output for the `thinking` prop.
- Normalizes accidental Kimi-style leading indentation so ordinary prose with 4+ leading spaces is not rendered as an indented code block.
- Preserves explicit fenced code blocks after normalization.
- Renders `summaries` boxes when `summaries.length > 0`; hides the section when `summaries` is empty.
- Renders the markdown section only when `thinking.trim().length > 0`.
- Reduced motion: `motion-reduce:animate-none` class is applied to the dot and the collapsible.

`tests/message-bubble-thinking.test.tsx` (new or extend existing message-bubble tests):

- A thinking block followed by a `text` block in the same message renders with `isStreaming={false}` on the thinking row (agent continued).
- A thinking block as the last block of a streaming message renders with `isStreaming={true}`.
- A thinking block followed by a `tool_use` block renders with `isStreaming={false}` on the thinking row.
- A thinking block in a non-streaming message always renders with `isStreaming={false}`.

### Test commands

```bash
bun run typecheck
bun run test:run -- tests/thinking-block.test.tsx tests/message-bubble-thinking.test.tsx
```

No worker or Go tests are required — this is a pure client UI change.

---

## Implementation order

1. **Rewrite `src/components/tool-call/thinking-block.tsx`** — keep the props compatible with the existing call site so the build stays green at each step. Verify in isolation that the new component renders both states.
2. **Update `src/components/message-bubble.tsx`** — keep `agentContinuedAfterIndex` for tools, add `thinkingContinuedAfterIndex` for thinking blocks, then pass `isStreaming` to `<ThinkingBlock>` at the render site.
3. **Run `bun run typecheck`** — confirm no type regressions.
4. **Add unit tests** — start with the component-level tests, then the message-bubble integration tests.
5. **Manual QA** — Claude/Pi streaming, GPT/OpenRouter/Pi streaming, refresh, reduce-motion, keyboard.

---

## Risks & mitigations

- **`MarkdownRenderer` inside a collapsible may add visual weight.** The renderer brings prose typography (margins between paragraphs, list spacing, code-block backgrounds). Inside the `pl-4 mt-1 … border-l` indent, this should still feel scoped. If the spacing reads as too loud, add a `.thinking-block__markdown` wrapper class with a tighter set of prose overrides — but ship the default first and let real content drive the call.
- **Code-block copy buttons inside thinking.** `MarkdownRenderer` adds copy buttons on fenced code. They'll appear inside expanded thinking blocks as well. This is acceptable — and arguably useful when the agent has been drafting code in its thinking.
- **Dot-color contrast in light mode.** `bg-green-500` for the complete-state dot should read as success without competing with the row label. Verify it is visible against the chat background in both themes.
- **Provider indentation interpreted as code.** Kimi/OpenRouter thinking text can contain normal prose lines prefixed by 4+ spaces. Normalize those lines before markdown rendering so only explicit fenced code renders as code.
- **Streaming dot lifetime.** Because we use a thinking-specific continuation signal rather than relying purely on `isStreaming`, the dot stops pulsing the moment the model emits any visible block after the thinking block — even before the message-level `isStreaming` flips to false. This is intentionally more precise than the message-level signal.

---

## Summary

| # | Part                                       | Files                                                  | What it does                                                                 |
| - | ------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 1 | Rewrite `ThinkingBlock` component          | `src/components/tool-call/thinking-block.tsx`          | Tool-call-style row, status dot, markdown-rendered expanded body             |
| 2 | Pass `isStreaming` from message-bubble     | `src/components/message-bubble.tsx`                    | Drive the dot from per-block streaming state using a thinking-specific continuation map |
| 3 | Tests                                      | `tests/thinking-block.test.tsx`, `tests/message-bubble-thinking.test.tsx` | Regression coverage for both states and the continuation logic             |
