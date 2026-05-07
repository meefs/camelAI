# Model Picker And Settings Feedback

Overall, this is looking really good. The implementation follows the plan shape: there is a shared model catalog, org/workspace config persistence, server-side model enforcement, chat/welcome picker integration, and a no-models guard.

## Findings

### 1. Rebase on `origin/main` before this ships

`HEAD` is `0037c02b`, which is also the merge-base with `origin/main`; `origin/main` is `39c1b1d6`. A PR diff against `main` currently appears to remove three mainline commits:

- `31c451a2` - `Use OpenAI Responses for thread titles`
- `317d77b7` - `Add OpenRouter attribution headers`
- `39c1b1d6` - `Block canceled trial billing access`

The visible symptoms in the diff are `package.json` dropping `openai`, `src/lib/thread-title-generation.server.ts` and its test being deleted, OpenRouter attribution headers being removed from `services/sandbox-host/internal/app/server.go`, and canceled-trial billing handling/tests being removed from `src/lib/billing.server.ts` / `workers/main/tests/billing-org.test.ts`.

This is a release blocker unless those reversions are intentional. Please rebase or merge `origin/main` and preserve those changes before final review.

### 2. Metadata hover cards can stack on fast hover

`src/components/model-picker.tsx:101-122` creates a separate uncontrolled `HoverCard` for every dropdown item. Because each row owns its own portal and close animation, rapidly moving across rows can leave multiple metadata cards visible at once. This matches the current bug: several model metadata tooltips can remain on screen simultaneously.

There should only ever be one metadata card mounted/open. I would make the picker track one `hoveredModelId` / `openModelId`, add a small open delay, cancel that delay on row leave/dropdown close/select, and close the previous card immediately when another row becomes active. A controlled Radix `HoverCard` with `open={openModelId === entry.id}` and `closeDelay={0}` would be fine, but a single rendered metadata panel keyed by the active model would be even harder to stack. Please include keyboard focus in the same state path.

### 3. The new-thread fast path loses picker policy state

`src/routes/_app.chat.$id.tsx:98-141` short-circuits `?newThread=1` from `sessionStorage` and returns:

- `allowedThreadModels: null`
- `effectivePickerDefaultModel: null`
- `isOrgAdmin: false`
- `recentModelScope: null`

Then `src/components/Chat.tsx:1775-1786` treats `allowedThreadModels === null` as "use the legacy visible model options" rather than the admin-configured picker list. The pending payload written at `src/components/Chat.tsx:4653-4666` does not include the picker state, so immediately after creating a thread from the welcome screen the UI can show models that the org/workspace picker hid, omit the admin "Manage models" affordance, and skip scoped recent-model behavior until a full loader refresh.

I would either remove this client-loader optimization for `newThread=1`, or include the picker state in the create-thread response/pending payload and hydrate it here. Add a focused test for the `?newThread=1` path with an org picker that hides a model, plus an OpenAI-only BYOK case where Claude models must stay hidden.

### 4. Recent-model storage should be hardened

`src/lib/recent-model.ts:15-33` accesses `window.localStorage`, `getItem`, and `setItem` without a `try/catch`. Some browser modes or privacy settings can throw on storage access. Since these helpers run from chat effects and picker selection, a storage exception could break model selection/rendering.

Wrap storage lookup and reads/writes defensively and return `null` / no-op on failure. A small test can stub `localStorage.getItem` and `setItem` to throw.

## Suggested Verification

- `bun run typecheck`
- `bun run test:run -- tests/model-picker-config.test.ts tests/model-catalog.test.ts tests/recent-model.test.ts`
- Add/adjust coverage for the model-picker hover state and `?newThread=1` client-loader path.
