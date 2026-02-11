# AskUserQuestion Inline Summary

## Problem

When the agent calls the `AskUserQuestion` tool, the interaction happens entirely out-of-band: a floating widget appears in the composer area, the user answers, and the widget disappears. The tool call itself renders in the message stream as a generic tool row (status dot + "AskUserQuestion" text + raw JSON in the expandable details). There are two issues:

1. **The tool summary is meaningless.** It falls through to the default case in `tool-summary.ts` and displays the raw tool name "AskUserQuestion" with no context about what was asked.
2. **After the user answers, there's no visible record of the Q&A exchange.** The questions and answers are buried in raw JSON inside the expandable details panel. Users can't glance at the conversation and see what they were asked or what they answered.

The goal is to give the AskUserQuestion tool call proper styling — a meaningful summary row and a clean Q&A details panel — so it fits naturally alongside other styled tool calls.

---

## Design

The AskUserQuestion tool call renders as a **normal tool call**: status dot + summary text + chevron, **collapsed by default**. Clicking to expand reveals a custom details panel showing a clean Q&A list instead of raw JSON.

### Collapsed State (default)

```
● Asked 3 questions                                                         ▸
```

- Standard tool call row: green dot + summary text + chevron (collapsed)
- Summary text dynamically reflects question count:
  - 1 question: the question's `header` value (e.g., "Auth method")
  - 2+ questions: "Asked N questions"
- Collapsed by default, like every other tool call

### Expanded State (click to open)

```
● Asked 3 questions                                                         ▾
  │
  │  Which channels or DMs should I focus on?                  ← question text
  │  Check everything                                          ← answer, muted
  │
  │  How far back should I look?                               ← question text
  │  Last few days                                             ← answer, muted
  │
  │  What are you most concerned about missing?                ← question text
  │  Everything important                                      ← answer, muted
```

### Detail: Q&A Pair

Each pair is a simple stack — medium-weight question, muted answer below:

```
  Which channels or DMs should I focus on?     ← text-xs font-medium text-foreground/80
  Check everything                             ← text-xs text-muted-foreground
```

- Pairs are separated by `space-y-3` (comfortable breathing room)
- No icons, no dividers, no badges — absolute minimum chrome
- The entire details panel uses the existing `border-l border-border/50 ml-1 pl-4` wrapper from `ToolCallDetails`

### Streaming / In-Progress State

While the question is being answered (tool has no result yet):

```
◉ Waiting for your input                                                    ▸
   ↑ blue pulsing dot (running status)
```

- Summary: "Waiting for your input" (running state)
- Collapsed by default — if expanded, questions show with `—` placeholder for unanswered items
- When the result arrives, the dot turns green and summary updates

### Single Question Variant

For a single question, the summary row uses the question's `header` field for a more specific label:

```
● Auth method                                                               ▸
```

---

## Implementation

### 1. Add `AskUserQuestion` case to `tool-summary.ts`

**File: `src/components/tool-call/tool-summary.ts`**

Add a new case in the `switch (name)` block:

```typescript
case 'AskUserQuestion': {
  const questions = Array.isArray(inputRecord.questions) ? inputRecord.questions : [];
  if (isStreaming && !result) {
    return { action: 'Waiting for your input' };
  }
  if (questions.length === 1 && typeof questions[0]?.header === 'string' && questions[0].header) {
    return { action: questions[0].header };
  }
  if (questions.length > 1) {
    return { action: `Asked ${questions.length} questions` };
  }
  return { action: 'Asked a question' };
}
```

### 2. Create `AskUserQuestionDetails` component

**New file: `src/components/tool-call/details/ask-user-question-details.tsx`**

This component extracts questions from the tool input and answers from the tool result, then renders the minimal Q&A list.

**Props:**
```typescript
interface AskUserQuestionDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
}
```

**Data extraction logic:**

The tool input contains `questions` (array of `{ question, header, options, multiSelect }`) and after the user answers, the tool result contains `answers` (a `Record<string, string>` keyed by question text). The answers may also appear in the tool input as `updatedInput.answers` depending on how the SDK processes the `handleCanUseTool` return value. The implementation should check both locations:

```typescript
function extractQuestionsAndAnswers(tool?: ToolUseBlock, result?: ToolResultBlock) {
  const input = tool?.input as Record<string, unknown> | undefined;
  const questions = Array.isArray(input?.questions) ? input.questions : [];

  // Answers can come from either the tool input (updatedInput merged) or the result text
  let answers: Record<string, string> = {};

  // Check tool input first (handleCanUseTool merges answers into updatedInput)
  if (input?.answers && typeof input.answers === 'object') {
    answers = input.answers as Record<string, string>;
  }

  // Fallback: try parsing the result text as JSON
  if (Object.keys(answers).length === 0 && result) {
    const resultText = getResultText(result);
    try {
      const parsed = JSON.parse(resultText);
      if (parsed && typeof parsed === 'object') {
        // Result might be { questions, answers } or just answers directly
        answers = parsed.answers ?? parsed;
      }
    } catch {
      // Result is not JSON — may be plain text; ignore
    }
  }

  return { questions, answers };
}
```

**Component rendering:**

```tsx
export function AskUserQuestionDetails({ tool, result }: AskUserQuestionDetailsProps) {
  const { questions, answers } = extractQuestionsAndAnswers(tool, result);
  const hasAnswers = Object.keys(answers).length > 0;

  if (questions.length === 0) {
    return <GenericDetails tool={tool} result={result} />;
  }

  return (
    <div className="space-y-3">
      {questions.map((q: { question: string }, i: number) => (
        <div key={i}>
          <p className="text-xs font-medium text-foreground/80">
            {q.question}
          </p>
          <p className="text-xs text-muted-foreground">
            {hasAnswers
              ? (answers[q.question] || '—')
              : '—'
            }
          </p>
        </div>
      ))}
    </div>
  );
}
```

**Imports:**
- `getResultText` from `../tool-utils`
- `GenericDetails` from `./generic-details` (fallback)
- Standard React and type imports

### 3. Register in `tool-details.tsx`

**File: `src/components/tool-call/tool-details.tsx`**

Add the import and switch case:

```typescript
import { AskUserQuestionDetails } from './details/ask-user-question-details';

// In the switch statement, before the default:
case 'AskUserQuestion':
  content = <AskUserQuestionDetails tool={tool} result={result} />;
  break;
```

No changes to `message-bubble.tsx` — AskUserQuestion tool calls stay collapsed by default like every other tool call. The standard `ToolCall` component handles expand/collapse via user click.

---

## Data Flow Verification

Before implementing, the coding agent should verify the actual shape of the `tool_use.input` and `tool_result` for an AskUserQuestion call. The easiest way:

1. Open an existing thread where AskUserQuestion was used
2. Check the raw JSONL on the sprite: `sprite exec -s chiridion-ws-{workspaceId} -- cat /home/sprite/.claude/projects/-home-sprite/{threadId}.jsonl`
3. Look for `tool_use` blocks with `name: "AskUserQuestion"` and the corresponding `tool_result`
4. Confirm where `questions` and `answers` live in the data

If the data shape differs from what's described above, adjust `extractQuestionsAndAnswers()` accordingly. The component should be resilient — always falling back to `GenericDetails` if parsing fails.

---

## Files to Modify (Summary)

| File | Change |
|------|--------|
| `src/components/tool-call/tool-summary.ts` | Add `AskUserQuestion` case with contextual summary text |
| `src/components/tool-call/details/ask-user-question-details.tsx` | **New** — minimal Q&A list details component |
| `src/components/tool-call/tool-details.tsx` | Register `AskUserQuestionDetails` in the switch statement |

## Components Used

- `getResultText` from `tool-utils` — extract text from tool result blocks
- `GenericDetails` from `details/generic-details` — fallback for unparseable data
- `getToolSummaryParts` pattern from `tool-summary.ts` — consistent summary generation
- No new shadcn/ui components needed — the Q&A list uses plain semantic HTML with Tailwind
- No new icons needed

## Not in Scope

- **The floating composer widget** (`ask-user-question.tsx`) — that stays unchanged; it handles the interactive question-answering flow
- **WebSocket event handling** — the `ask_user_question` and `question_response` event flow is unchanged
- **Persistence** — no new storage; we're just rendering existing data from the tool_use/tool_result blocks that are already in the message stream
- **Multi-select display** — answers are stored as comma-separated strings (e.g., "Option A, Option B"); displayed as-is
