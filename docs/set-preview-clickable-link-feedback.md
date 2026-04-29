# Set Preview Clickable Link — Implementation Feedback

Reviewed the diff across the four touched files (`mcp-utils.ts`, `tool-summary.ts`, `tool-call.tsx`, `app-link.tsx`) and the test additions in `tool-summary.test.ts`. The implementation is a clean, faithful execution of the plan. Manual confirmation from the user that it works in practice.
---

## Minor nits (optional follow-ups)

### 1. Copy: `Previewed app <name>` reads slightly awkwardly

The action verb hardcodes the noun "app" into the phrase, producing `Previewed app my-todo-app`. By analogy with `Read README.md` (verb + name, no `Read file`), `Previewed my-todo-app` would read more naturally — and we already render the app pill in the preview panel, so users have context.

This was specified in the plan, so the agent followed it correctly. If you prefer the leaner phrasing, change `tool-summary.ts:121` (`'Opening preview app'`) and `tool-summary.ts:130` / `:135` (`'Previewed app'`, `'Failed to preview app'`) to drop the trailing `'app'`.

Either way is defensible — flagging only because we have a chance to pick now before users see it.

### 2. Test coverage gaps

The added tests cover the `complete` status only. Not covered:

- `isRunning=true` + path missing → `'Opening preview...'`
- `isRunning=true` + path present → `'Opening preview'` with filename
- `isError=true` for both file and app cases

Add three or four more cases to `describe('getToolSummaryParts set-preview MCP tools', ...)` if you want symmetric coverage with the existing Read/Edit tense tests.

### 3. `AppLink`: no role/aria for the button label

Functionally a `<button>` with text content is already accessible — the script name becomes the accessible name. No change needed unless you later want to disambiguate from a sibling `FileLink` for screen-reader users (e.g., adding `aria-label={`Preview app ${scriptName}`}`). Defer until a real complaint.

### 4. `parseAppPreviewIsPublic` lives in `tool-summary.ts`

Small organizational nit: the helper is colocated with its only caller, which is fine. If a second consumer ever needs to read fields out of MCP tool result bodies, consider hoisting parse helpers into `tool-utils.ts`. Don't pre-emptively move it.