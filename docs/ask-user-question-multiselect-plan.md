# AskUserQuestion Multi-Select Rendering Fix Plan

## Problem

`AskUserQuestion` can already render checkboxes and submit multiple selected labels when a question reaches the browser with `multiSelect: true`. The reported payload instead uses this shape:

```json
{
  "id": "multiselect-test",
  "type": "multi_select",
  "question": "Multi-select rendering test: please select all fruits you like.",
  "options": [
    { "label": "Apple", "value": "apple" },
    { "label": "Banana", "value": "banana" },
    { "label": "Mango", "value": "mango" },
    { "label": "Strawberry", "value": "strawberry" }
  ],
  "required": false
}
```

The current normalizers only treat `multiSelect === true` or `multi_select === true` as multi-select. They ignore string question types such as `type: "multi_select"`, so this payload is normalized as single-select, rendered through the `RadioGroup` branch, and only one answer can be selected.

The visible symptom is a UI bug, but the durable fix belongs at the input-normalization boundary. The agent/tool schema is intentionally loose, so the app must accept the common variants agents actually send.

## Current Code Path

1. `workers/main/src/code-mode-tools.ts`
   - Defines `AskUserQuestion` with a loose `questions: Array<object>` schema.
   - `CodeModeToolsBinding.askUserQuestion()` passes `args.questions` through to `ChatThreadDO`.

2. `workers/main/src/chat-thread-do.ts`
   - `askUserQuestion()` delegates to `BrowserPromptCoordinator.askUserQuestion()`.

3. `workers/main/src/chat-thread-browser-prompts.ts`
   - `normalizeAskQuestion()` converts raw tool input into `PendingQuestionInfo`.
   - Today it sets:
     ```ts
     multiSelect: record.multiSelect === true || record.multi_select === true
     ```
   - This is the first place the reported payload loses its multi-select intent.

4. `src/components/Chat.tsx`
   - Receives `state.pendingQuestion` and renders `AskUserQuestion`.
   - `handleQuestionResponse()` sends `Record<string, string>` answers back through `answerQuestion`.

5. `src/components/ask-user-question.tsx`
   - Defensively re-normalizes display payloads in `normalizeQuestionForDisplay()`.
   - It has the same narrow `multiSelect` / `multi_select` check.
   - The component already has a working checkbox branch when `currentQuestion.multiSelect` is true.

## Root Cause

There are two duplicated normalizers and both encode an overly narrow contract:

- `workers/main/src/chat-thread-browser-prompts.ts`
- `src/components/ask-user-question.tsx`

They understand boolean multi-select flags, but not the question-type schema emitted in the bug report. Fixing only the React component may make live raw payloads work in some cases, but `pendingQuestion` state broadcast by the Worker will still be wrong and reconnect/state hydration can continue to carry `multiSelect: false`. Fix the Worker normalizer first, then keep the UI normalizer as a defensive fallback.

## Target Behavior

For a question with `type: "multi_select"`:

- The browser prompt renders checkboxes, not radio buttons.
- Clicking or keyboard-selecting multiple options accumulates selections.
- Submitting sends the existing stable answer shape:
  ```json
  {
    "Multi-select rendering test: please select all fruits you like.": "Apple, Mango, Strawberry"
  }
  ```
- Existing payloads with `multiSelect: true` or `multi_select: true` continue to work.
- Existing single-select payloads continue to render as radio options.

Do not change the returned answer format to arrays or option `value`s as part of this fix. Today the tool returns a `Record<questionText, string>` using display labels, and changing that contract would ripple into the runner, transcript/tool-result rendering, and any agent assumptions. The reported output also uses the display label (`"Mango"`), so preserving labels is the least risky behavior.

## Implementation Plan

### 1. Centralize AskUserQuestion normalization

Create a small pure module, for example:

`src/lib/ask-user-question-normalization.ts`

Export the normalized types and helper functions used by both Worker and React code:

```ts
export interface NormalizedAskUserQuestionOption {
  label: string;
  description: string;
}

export interface NormalizedAskUserQuestion {
  question: string;
  header: string;
  options: NormalizedAskUserQuestionOption[];
  multiSelect: boolean;
  allowOther: boolean;
}

export function normalizeAskUserQuestionOption(value: unknown): NormalizedAskUserQuestionOption | null;
export function normalizeAskUserQuestion(value: unknown): NormalizedAskUserQuestion | null;
export function normalizeAskUserQuestions(value: unknown[] | unknown): NormalizedAskUserQuestion[];
```

Keep this module dependency-free: no React imports, no DOM APIs, no Worker-only APIs, no path aliases inside the file. `workers/main/src/chat-thread-browser-prompts.ts` already imports pure shared app code via a relative path, so importing this helper from `../../../src/lib/ask-user-question-normalization` is consistent with the repo.

### 2. Normalize selection mode from both booleans and type strings

Inside the shared module, add a helper with a narrow, explicit compatibility surface:

```ts
function normalizeQuestionType(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

function isMultiSelectQuestion(record: Record<string, unknown>): boolean {
  if (record.multiSelect === true || record.multi_select === true) return true;

  const type = normalizeQuestionType(record.type);
  return type === "multi_select" || type === "multiselect";
}
```

Optional but acceptable if the agent wants a slightly more robust helper: also check `record.kind`, `record.inputType`, and `record.input_type` with the same normalization. Keep the accepted values explicit. Do not treat arbitrary truthy strings as multi-select.

Then set:

```ts
multiSelect: isMultiSelectQuestion(record)
```

The reported `options` shape already works because the existing option normalizer uses `label ?? value ?? text ?? name`; keep that behavior.

### 3. Replace duplicated normalizers

Update `workers/main/src/chat-thread-browser-prompts.ts`:

- Remove the local `NormalizedAskQuestionOption`, `NormalizedAskQuestion`, `normalizeAskQuestionOption`, `normalizeAskQuestion`, and `normalizeAskQuestions` definitions.
- Import the shared normalized type and function.
- Keep the public `PendingQuestionInfo.questions` type as the shared normalized question type.
- Preserve current `askUserQuestion()` behavior: reject empty normalized question lists, broadcast the normalized prompt, track waiters, and resolve with the submitted answers.

Update `src/components/ask-user-question.tsx`:

- Import the shared normalized question and option types.
- Remove the duplicated local display normalizer functions.
- Keep component-local UI state and submission logic unchanged.
- Keep the existing shadcn primitives: `Checkbox` for multi-select and `RadioGroup` / `RadioGroupItem` for single-select.

This makes the Worker the canonical normalization layer while preserving the component's defensive normalization for tests or future direct callers.

### 4. Add Worker regression coverage

Extend `workers/main/tests/chat-thread-pi-turn.test.ts` near the existing test:

`normalizes AskUserQuestion string options before broadcasting to the browser`

Add a focused test for the reported shape:

- Call `ChatThreadDO.prototype.askUserQuestion.call(fake, { toolUseId, questions: [reportedQuestion] })`.
- Assert `fake.broadcastChat` receives:
  ```ts
  questions: [{
    question: "Multi-select rendering test: please select all fruits you like.",
    header: "",
    multiSelect: true,
    allowOther: true,
    options: [
      { label: "Apple", description: "" },
      { label: "Banana", description: "" },
      { label: "Mango", description: "" },
      { label: "Strawberry", description: "" },
    ],
  }]
  ```
- Resolve the prompt through `fake.browserPrompts.answerQuestion()` so the promise is not left pending.

This test proves the canonical broadcast state is correct before React renders anything.

### 5. Add React regression coverage

Extend `tests/ask-user-question-keyboard-shortcuts.test.tsx` with a case that renders the exact raw-style question without `multiSelect: true`:

```ts
{
  id: "multiselect-test",
  type: "multi_select",
  question: "Multi-select rendering test: please select all fruits you like.",
  options: [
    { label: "Apple", value: "apple" },
    { label: "Banana", value: "banana" },
    { label: "Mango", value: "mango" },
    { label: "Strawberry", value: "strawberry" },
  ],
  required: false,
  allowOther: false
} as any
```

Use `allowOther: false` in the test unless specifically validating the "Other" row; this keeps the assertion focused on the four supplied options.

Assertions:

- The widget renders checkboxes:
  ```ts
  expect(screen.getAllByRole("checkbox")).toHaveLength(4);
  expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  ```
- Selecting multiple options and submitting calls:
  ```ts
  expect(onSubmit).toHaveBeenCalledWith({
    "Multi-select rendering test: please select all fruits you like.": "Apple, Mango"
  });
  ```

This test proves the UI fallback normalizer understands the same schema and that the existing checkbox branch still accumulates multiple selections.

### 6. Keep `required` out of this fix unless product explicitly expands scope

The reported payload includes `required: false`, but current `AskUserQuestion` requires the current question to have a selection or non-empty "Other" text before enabling Submit. That is a separate schema-compatibility issue.

Do not mix optional-question behavior into the multi-select rendering fix unless the acceptance criteria are expanded. If optional questions are handled later, add `required` to the normalized question type and update `isCurrentValid` so `required: false` permits an empty answer.

## Files To Touch

| File | Change |
| --- | --- |
| `src/lib/ask-user-question-normalization.ts` | New shared pure normalizer for prompt questions and options |
| `workers/main/src/chat-thread-browser-prompts.ts` | Import and use shared normalizer; remove duplicated local normalization |
| `src/components/ask-user-question.tsx` | Import and use shared normalized types/functions; keep UI behavior |
| `workers/main/tests/chat-thread-pi-turn.test.ts` | Add Worker broadcast regression test for `type: "multi_select"` |
| `tests/ask-user-question-keyboard-shortcuts.test.tsx` | Add React rendering/submission regression test for `type: "multi_select"` |

## Validation

Run the targeted tests first:

```bash
bun run test:run -- tests/ask-user-question-keyboard-shortcuts.test.tsx
bun run test:workers -- workers/main/tests/chat-thread-pi-turn.test.ts -t "AskUserQuestion"
```

Then run typecheck:

```bash
bun run typecheck
```

Manual QA:

1. Trigger `AskUserQuestion` with the reported payload.
2. Confirm the fruit choices render as checkboxes.
3. Select at least two fruits.
4. Submit and confirm the agent receives a comma-separated label string containing every selected fruit.

## Non-Goals

- Do not redesign the widget.
- Do not replace shadcn `Checkbox` / `RadioGroup` primitives.
- Do not change answer values from labels to option `value`s.
- Do not change multi-select answers from comma-separated strings to arrays.
- Do not implement optional-question semantics for `required: false` in this bug fix.
