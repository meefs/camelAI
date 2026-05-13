# Notebook Setup Output Suppression Plan

## Goal

Make generated notebooks feel polished in Report mode without hiding execution details from Notebook mode.

Some setup/configuration calls return Python objects whose `repr` is not useful report content. In Jupyter, if one of these calls is the final expression in a cell, the notebook records a plain text output. Example:

```python
alt.data_transformers.disable_max_rows()
```

This can produce:

```text
DataTransformerRegistry.enable('default')
```

That output is technically accurate, but it reads as broken UI in the rendered report. The desired behavior is:

- **Notebook mode:** show the output, because Notebook mode is the faithful view of what actually ran.
- **Report mode:** hide the output, because Report mode is the polished article view.
- **PDF export:** match Report mode.
- **Validator:** warn the agent so future notebooks avoid producing the noise.
- **Skill guidance:** proactively teach agents to silence setup/config return values.

## Existing Contract

The current notebook renderer already has a two-mode contract:

- **Notebook mode** shows raw cells, code, execution counts, and outputs.
- **Report mode** hides code and setup cells, showing only narrative markdown and meaningful outputs.

Suppressing accidental object repr noise only in Report mode is a natural extension of this contract. It should not affect Notebook mode.

## Design Principle

Do not solve this as one exact string like:

```ts
text === "DataTransformerRegistry.enable('default')"
```

That would fix only the Altair example. The broader issue is that Python libraries can leak non-content object reprs when a setup/configuration expression is left as the final expression in a cell.

Instead, add a tiny shared helper that recognizes a narrow class of accidental final-expression repr outputs. This is still simple, but it covers the class of bug rather than one exact incident.

At the same time, keep the helper conservative. It must not become a generic "hide text I dislike" path.

## Proposed Changes

### 1. Add Validator Warnings

Extend `sandbox/validate-notebook.py` with a warning for ignorable setup/object repr outputs.

Example warning:

```text
Cell 3 WARNING: setup output "DataTransformerRegistry.enable('default')" should be suppressed with ; or assignment to _
```

This is high leverage because agents already run:

```bash
validate-notebook analysis.ipynb
```

after notebook execution and revise notebooks based on its output.

The validator should detect the same conservative text patterns as the renderer helper. These warnings should not fail validation at first unless the existing validator structure requires non-OK output to exit non-zero. The key behavior is that the warning appears clearly enough for the agent to fix the notebook.

The warning should tell the agent exactly what to do:

- Add a trailing `;`
- Or assign the result to `_`

Examples:

```python
alt.data_transformers.disable_max_rows();
```

```python
_ = alt.data_transformers.disable_max_rows()
```

```python
plt.plot(x, y);
```

### 2. Update Data Analysis Skill Guidance

Add one concise rule to `sandbox/skills/data-analysis/SKILL.md` near notebook workflow or visualization guidance:

```markdown
Setup calls whose return value is not meaningful report content, such as `alt.data_transformers.disable_max_rows()` or `plt.plot(...)`, should be silenced with a trailing `;` or assigned to `_` so object reprs do not leak into notebook outputs.
```

This gives the agent a proactive rule before the validator has to correct it.

### 3. Add A Conservative Ignorable Text Helper

Add a helper in `src/components/chat-file-preview/notebook-preview/utils.ts`.

Suggested name:

```ts
export function isIgnorableTextOutput(output: NotebookOutput): boolean
```

The helper answers this question:

> Is this output only a plain-text Python object/configuration repr that likely leaked because a cell ended on an expression instead of a statement?

It should return `true` only when all guardrails pass.

#### Required Guardrails

The helper should only consider an output ignorable when:

1. `output.output_type` is `execute_result` or `display_data`.
2. The output has `data["text/plain"]`.
3. The output has no richer meaningful MIME payload.
4. The normalized `text/plain` value matches a small set of obvious accidental repr patterns.

It must return `false` for:

- `stream` outputs
- `error` outputs
- outputs with `text/html`
- outputs with `text/markdown`
- outputs with image MIME types
- outputs with Vega/Vega-Lite MIME types
- outputs with Plotly MIME types
- outputs with `application/json`
- normal scalar/text outputs like `42`, `ready`, `3 rows`, or model metrics

#### Rich MIME Check

Treat these MIME types as meaningful and never suppress the output if any are present with non-empty data:

- `text/html`
- `text/markdown`
- `image/png`
- `image/jpeg`
- `image/svg+xml`
- `application/json`
- `application/vnd.vega.v*+json`
- `application/vnd.vegalite.v*+json`
- `application/vnd.plotly.v*+json`

The exact implementation can either check this list directly or use existing renderer helper logic if that stays simple. Do not call `getOutputRender()` from inside the helper if it creates circular reasoning or extra parsing cost.

#### Initial Pattern Set

Start with a small set of patterns that are very unlikely to be intentional report prose:

```ts
const IGNORABLE_TEXT_OUTPUT_PATTERNS = [
  /^DataTransformerRegistry\.enable\(['"][^'"]+['"]\)$/,
  /^<IPython\.core\.display\.[A-Za-z_][\w.]* object>$/,
  /^<matplotlib\.[\w.]+(?: object)? at 0x[0-9a-fA-F]+>$/,
  /^\[\s*<matplotlib\.[\w.]+(?: object)? at 0x[0-9a-fA-F]+>(?:,\s*<matplotlib\.[\w.]+(?: object)? at 0x[0-9a-fA-F]+>)*\s*\]$/,
  /^<Figure size \d+(?:\.\d+)?x\d+(?:\.\d+)? with \d+ Axes>$/,
];
```

Notes:

- The Altair pattern is specific to transformer registry reprs, not all Altair text.
- The IPython display pattern catches empty fallback reprs like `<IPython.core.display.Markdown object>` only when no real `text/markdown` exists.
- The matplotlib patterns catch common return values from accidental final expressions like `plt.plot(...)` or `plt.figure()` when they have no image payload.
- Do not add a generic `<.* object at 0x...>` pattern in the first implementation. It is broader than needed and more likely to hide intentional debugging output.

If new common shapes appear later, add them deliberately with tests.

### 4. Filter In Report Mode Only

Use `isIgnorableTextOutput()` in `src/components/chat-file-preview/notebook-preview/report-mode.tsx`.

Important: filter before the `length === 0` check, so cells whose only outputs are ignorable produce no empty wrapper.

Suggested shape:

```tsx
const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
const reportOutputs = outputs.filter((output) => !isIgnorableTextOutput(output));
if (reportOutputs.length === 0) return null;

return (
  <div key={`cell-${index}`} className="min-w-0 space-y-8">
    {reportOutputs.map((output, outputIndex) => (
      <OutputRenderer
        key={`output-${index}-${outputIndex}`}
        output={output}
        mode="report"
        layout={layout}
        title={`Output ${outputIndex + 1}`}
      />
    ))}
  </div>
);
```

Do not use this helper in `notebook-code-cell.tsx`. Notebook mode should keep showing all raw outputs.

### 5. Filter In Report Export / PDF

Use the same helper in `src/components/chat-file-preview/notebook-preview/report-export-model.ts`.

Filter before adding export blocks:

```ts
const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
outputs
  .filter((output) => !isIgnorableTextOutput(output))
  .forEach((output, outputIndex) => {
    // existing block creation logic
  });
```

This keeps PDF export aligned with Report mode.

### 6. Do Not Change Output Rendering Types

Do not change `getOutputRender()` and do not add a render kind like:

```ts
{ kind: "ignorable" }
```

That would force Notebook mode and other output consumers to know about report-only suppression. The suppression is a Report/PDF presentation concern, not a core output-rendering concern.

## Renderer Behavior

Given this executed cell:

```python
import altair as alt
alt.data_transformers.disable_max_rows()
```

And this recorded output:

```json
{
  "output_type": "execute_result",
  "data": {
    "text/plain": "DataTransformerRegistry.enable('default')"
  }
}
```

Expected behavior:

- **Report mode:** no output block is rendered.
- **Notebook mode:** the raw text output is still rendered below the code cell.
- **PDF export:** no text block is included.
- **Validator:** emits a warning that the final expression should be suppressed.

Given this executed cell:

```python
plt.plot(x, y)
```

and an output like:

```text
[<matplotlib.lines.Line2D at 0x12abc1230>]
```

Expected behavior:

- **Report mode:** the repr output is hidden if there is no image/rich payload.
- **Notebook mode:** the repr output remains visible.
- **Validator:** warns the agent to write `plt.plot(x, y);`.

Given this intentional text output:

```python
print("ready")
```

Expected behavior:

- **Report mode:** `ready` still renders.
- **Notebook mode:** `ready` still renders.
- **PDF export:** `ready` still exports.
- **Validator:** no warning.

## Classification Notes

Do not change `cell-classifier.ts` in the first pass.

Filtering in `report-mode.tsx` before the output loop is enough to avoid visible empty report output for code cells whose only outputs are ignorable. Filtering in `report-export-model.ts` is enough to keep PDF/export aligned.

Only revisit classification if we later see concrete artifacts, such as:

- empty spacing caused by visible-but-empty code cells
- sidebar/table-of-contents issues
- report export block ordering issues

The goal is the smallest implementation that fixes the user-visible problem while preserving the two-mode contract.

## Non-Goals

- Do not hide these outputs in Notebook mode.
- Do not globally suppress all `text/plain` object reprs.
- Do not add a generic `<.* object at 0x...>` regex in the first implementation.
- Do not add an `ignorable` output kind to `getOutputRender()`.
- Do not preconfigure Altair globally as the primary fix.
- Do not rewrite existing notebooks at preview time.
- Do not make the classifier substantially smarter in this pass.

## Tests

Add focused tests covering the behavior and guardrails.

### Validator Tests

Add or extend tests for `sandbox/validate-notebook.py` so it emits warnings for:

- `DataTransformerRegistry.enable('default')`
- `[<matplotlib.lines.Line2D at 0x...>]`

And does not warn for:

- `ready`
- `42`
- regular printed summaries
- rich outputs with HTML/image/Vega/Plotly/markdown payloads

If there is no existing Python test harness for `validate-notebook.py`, add the smallest practical test path. A subprocess-style test from Vitest is acceptable if it follows existing repo patterns.

### Utility Tests

Add tests for `isIgnorableTextOutput()` in `tests/notebook-preview-utils.test.ts`.

Cover:

- returns `true` for Altair transformer registry plain-text output
- returns `true` for matplotlib line-list plain-text output
- returns `true` for IPython display object fallback with only `text/plain`
- returns `false` when the same IPython display object also has real `text/markdown`
- returns `false` for `stream`
- returns `false` for `error`
- returns `false` for `application/json`
- returns `false` for normal plain text
- returns `false` for scalar outputs

### Report Export Tests

Add tests in `tests/notebook-report-export-model.test.ts` confirming:

- report export excludes ignorable plain-text repr outputs
- report export still includes normal plain text outputs
- report export still includes rich markdown/table/chart outputs when present

### Report Mode Rendering Tests

If existing component test setup makes this cheap, add a React test confirming Report mode renders no output block for a cell whose only output is ignorable.

If that is heavy, utility and export-model coverage is enough for the first pass because `report-mode.tsx` should use the same filtered-output pattern directly.

### Notebook Mode

No code change should touch `notebook-code-cell.tsx`. A regression test is optional, but if added it should assert that Notebook mode still renders the raw repr output.

## Implementation Order

Recommended implementation order:

1. Add `isIgnorableTextOutput()` and utility tests.
2. Filter outputs in `report-mode.tsx`.
3. Filter outputs in `report-export-model.ts` and add export tests.
4. Add validator warning logic and tests.
5. Update `sandbox/skills/data-analysis/SKILL.md`.

This order lets the renderer behavior land with focused TypeScript tests first, then closes the agent feedback loop with validator and skill guidance.

## Success Criteria

The implementation is done when:

- Existing noisy outputs like `DataTransformerRegistry.enable('default')` disappear from Report mode.
- The same outputs remain visible in Notebook mode.
- PDF export matches Report mode.
- `validate-notebook.py` warns agents to suppress these outputs.
- The data-analysis skill tells agents to use `;` or `_ =` for non-content setup return values.
- Normal text outputs are not hidden.
- The helper remains small, explicit, and covered by tests.
