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

**Data shape (verified from JSONL):**

The `tool_use` block has structured questions in `input.questions`:

```json
{
  "type": "tool_use",
  "name": "AskUserQuestion",
  "input": {
    "questions": [
      {
        "question": "If you could only eat one food for the rest of your life, what would it be?",
        "header": "Life choice",
        "options": [
          { "label": "Pizza", "description": "The classic answer..." },
          { "label": "Tacos", "description": "Endless variety..." }
        ],
        "multiSelect": false
      }
    ]
  }
}
```

The `tool_result` content is **plain text**, not JSON:

```
User has answered your questions: "If you could only eat one food for the rest of your life, what would it be?"="Tacos". You can now continue with the user's answers in mind.
```

The format is: `"question text"="answer"` pairs. For multiple questions these are comma-separated.

The structured `answers` object (`{ "question": "answer" }`) lives on the JSONL event's `toolUseResult` field, but this does **not** make it into the `ToolResultBlock` the client receives — so we must parse from the plain text.

**Data extraction logic:**

```typescript
function extractQuestionsAndAnswers(tool?: ToolUseBlock, result?: ToolResultBlock) {
  const input = tool?.input as Record<string, unknown> | undefined;
  const questions = Array.isArray(input?.questions)
    ? (input.questions as Array<{ question: string; header?: string }>)
    : [];

  const answers: Record<string, string> = {};

  if (result) {
    const resultText = getResultText(result);

    // Parse answers from the plain-text result.
    // Format: "question text"="answer value"
    // Use each known question string as the key to find its answer.
    for (const q of questions) {
      // Look for: "question text"="answer"
      // The answer is everything between ="  and the next "  (or end-of-match)
      const escaped = q.question.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`"${escaped}"\\s*=\\s*"([^"]*)"`, 's');
      const match = resultText.match(pattern);
      if (match?.[1]) {
        answers[q.question] = match[1];
      }
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

## Data Shape Reference

The JSONL data shape has been verified. Here is a condensed reference of the full lifecycle for one AskUserQuestion call:

**1. Assistant message** — contains the `tool_use` block with `input.questions` (structured):
```
tool_use.name = "AskUserQuestion"
tool_use.input.questions = [{ question, header, options, multiSelect }]
```

**2. User message** — contains the `tool_result` block with plain-text content:
```
tool_result.content = 'User has answered your questions: "question"="answer". You can now continue...'
tool_result.tool_use_id = <matching tool_use.id>
```

The JSONL event also carries `toolUseResult.answers` (a structured `Record<string, string>`), but this field is on the event wrapper and does **not** propagate into the `ToolResultBlock` that the rendering code receives. The extraction logic above parses answers from the plain-text result using the known question strings as lookup keys.

If the result text format ever changes, the component falls back gracefully to `GenericDetails`.

**Test JSONL:** A real AskUserQuestion conversation is available at `be677531-2d3b-45c1-ad3e-887c2dabdb8c.jsonl` in the project root for reference/testing.

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
