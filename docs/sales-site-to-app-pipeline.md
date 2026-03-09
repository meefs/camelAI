# Sales Site → App Pipeline

**Date:** 2026-03-09
**Scope:** `camelai-salessite` (camelai.com) + `chiridion-app` (camelai.dev)

---

## Objective

When a user types a prompt on camelai.com and presses send, carry that prompt through signup/login and into their first chat on camelai.dev. Today the hero input does a hard `window.location.href = "https://camelai.dev"` and the user's text is lost.

## User Scenarios

| # | User state | Flow |
|---|-----------|------|
| 1 | **Brand-new user** | camelai.com → signup → (email verify if password signup) → onboarding completes → new thread auto-sends their prompt as first message |
| 2 | **Existing user, logged out** | camelai.com → login → `/chat` welcome screen with prompt pre-populated in composer (editable) |
| 3 | **Existing user, logged in** | camelai.com → `/chat` welcome screen with prompt pre-populated in composer (editable) |
| 4 | **Authenticated user with incomplete onboarding** | camelai.com → `/chat?prompt=...` → `_app` redirects to `/onboarding?returnTo=...` → onboarding resumes → new thread auto-sends their prompt as first message |

### Design decisions

- **Scenario 1 (new user):** The prompt is auto-sent. The agent receives a customized `<camelai system message>` (shortened onboarding that mentions they came from the sales site with a starter prompt) followed by the user's message. From the user's perspective the chat opens with their message already sent and the agent responding. This mirrors the sales site experience of "I pressed send and got a response."
- **Scenarios 2 & 3 (returning users):** The prompt is pre-populated but **not auto-sent**. The user lands on the `/chat` welcome screen with the composer already filled, so they can edit or just press send. Returning users already know the product; auto-sending would feel presumptuous.
- **Scenario 4 (authenticated but incomplete onboarding):** Treat this as a variant of scenario 1. The current `_app.tsx` loader already gates incomplete users to `/onboarding`, so the implementation must preserve the sales-site prompt across that redirect.

## Transport Mechanism

**Shared KV namespace** between the sales site worker and the web app worker.

Both `camelai-salessite` and `chiridion-app` are Cloudflare Workers on the same account (`85bbd288051330fb51ee1c86031a299b`). The web app already has an `APP_KV` binding. We add the same binding (pointing to the same KV namespace ID) to the sales site worker. The sales site writes the prompt to KV; the web app reads it.

### Flow

1. User types prompt on camelai.com and presses send
2. Sales site client POSTs the prompt to a same-origin server action (e.g. `POST /api/store-prompt`)
3. Server action generates an opaque URL-safe key (current implementation: 21 characters from a 64-character alphabet), writes `{ prompt, createdAt }` to `APP_KV` with key `sales_prompt:<key>` and a **30-minute TTL** (`expirationTtl: 1800`)
4. Server action returns the key to the client
5. Client redirects to: `https://camelai.dev/signup?redirect=%2Fchat%3Fprompt_key%3D<key>`
6. On camelai.dev, routes read `?prompt_key=`, look up KV, **delete after reading** (one-time use), and proceed

### Why KV instead of inline URL encoding

- **No URL length limit** — prompts can be arbitrarily long (code snippets, multi-paragraph descriptions)
- **Cleaner URLs** — `?prompt_key=abc123` instead of a massive encoded blob
- **No cookie needed** for onboarding persistence — the KV key is just a short string that fits trivially in URL params, cookies, or sessionStorage. The prompt itself lives server-side in KV.
- **One-time use** — prompt is deleted after first read, so shared URLs don't replay someone's prompt
- **Same Cloudflare account** — no CORS, no cross-origin fetch, no new API endpoint on camelai.dev. Both workers bind to the same KV namespace directly.

### KV key format

```
sales_prompt:<opaque-key>
```

Example: `sales_prompt:set-me`

### KV value format

```json
{
  "prompt": "Build me a dashboard that tracks...",
  "createdAt": 1741500000000
}
```

### Prompt length limit

The hero textarea does **not** impose a character limit. Enforce an explicit cap (recommended `10000` characters) in the sales site server action before writing to KV. This is generous enough for code snippets while preventing abuse. The web app should also enforce the same cap when reading from KV as a defense-in-depth measure.

If the prompt exceeds the limit: truncate silently. Do not reject — the user already pressed send and is being redirected.

### TTL and cleanup

- **TTL: 30 minutes** (`expirationTtl: 1800`) — KV auto-expires the entry
- **Delete after read** — web app deletes the key after successfully reading the prompt. This makes the key single-use.
- **Race condition:** if two tabs read the same key, only one gets the prompt. This is fine — it's the same user and the key is meant to be consumed once.

### Fallback

If the KV lookup fails (key expired, KV outage, etc.), the web app proceeds with the normal flow as if no prompt was provided. The user lands on the standard welcome screen or onboarding. This is a graceful degradation, not an error.

---

## Implementation

### Part 1: Sales Site Changes (camelai-salessite)

#### 1A. Add KV binding to the sales site worker

**File:** `wrangler.jsonc`

Add the `APP_KV` binding pointing to the **same KV namespace ID** used by the web app. The sales site is on the same Cloudflare account, so this is a config-only change.

For production, use the prod KV namespace ID (`0ee80299e67c4c7fa0c1ad618b7e7a9c`). For dev/staging, use the dev namespace ID (`e894eb2caf1641ad8870da994b992fce`). Match the pattern in `chiridion-app/wrangler.jsonc`.

```jsonc
{
  // ...existing config
  "kv_namespaces": [
    { "binding": "APP_KV", "id": "<namespace-id-for-env>" }
  ]
}
```

If the sales site uses environment overrides (like `chiridion-app` does), add the KV binding in each environment block.

#### 1B. Add a server action that writes to KV and redirects in one step

**File:** `app/routes/home.tsx`

The homepage form submits to its own action. The action writes the prompt to KV and returns a `302 redirect` — no client-side fetch round-trip needed.

The current `handleSubmit` does a client-side redirect:
```typescript
function handleSubmit() {
  window.location.href = "https://camelai.dev";
}
```

**Replace with a standard React Router `<Form>` submission:**

```tsx
// In the component:
<Form method="post">
  <input type="hidden" name="prompt" value={value} />
  {/* The existing HeroInput textarea + submit button trigger form submission */}
</Form>
```

The `HeroInput` component's submit button becomes a form submit trigger. On Enter key or button click, the form POSTs to the home route's action.

**Add an `action` export to `app/routes/home.tsx`:**

```typescript
import { redirect } from 'react-router';

const MAX_SALES_PROMPT_CHARS = 10_000;

export async function action({ request, context }: ActionArgs) {
  const formData = await request.formData();
  let prompt = (formData.get('prompt') as string)?.trim() ?? '';

  if (!prompt) {
    // No prompt — just redirect to signup
    return redirect('https://camelai.dev/signup');
  }

  // Sanitize
  prompt = prompt
    .replace(/<\/?camelai system message>/gi, '')
    .slice(0, MAX_SALES_PROMPT_CHARS);

  // Write to shared KV
  const key = createSalesPromptKey(); // opaque URL-safe key, 21 chars today
  const kvKey = `sales_prompt:${key}`;
  await context.cloudflare.env.APP_KV.put(
    kvKey,
    JSON.stringify({ prompt, createdAt: Date.now() }),
    { expirationTtl: 1800 }
  );

  // Build redirect URL with key inside the `redirect` param
  const redirectTarget = `/chat?prompt_key=${key}`;
  const destination = new URL('https://camelai.dev/signup');
  destination.searchParams.set('redirect', redirectTarget);

  return redirect(destination.toString());
}
```

This eliminates the client-side fetch round-trip entirely. The server writes to KV and issues a `302` in one shot. The browser follows the redirect automatically.

**UX note:** The form should show a loading/pending state during submission. React Router's `useNavigation()` or `useFetcher()` can provide this — `navigation.state === 'submitting'` while the action is in flight.

We send everyone to `/signup` because:
- New users need to sign up — this is the right page
- Existing users who land on `/signup` while already logged in get redirected automatically (the `_auth.tsx` layout loader already handles this — it redirects authenticated users to the `redirectTo` param, defaulting to `/`)
- Existing users who are logged out can click "Log in" from the signup page (the link is already there)

**Important:** the `prompt_key` must be encoded inside the `redirect` param. Sending users to `/signup?prompt_key=...` is not sufficient because the existing auth flow only preserves `redirect`.

#### 1C. Navbar login/signup links — no changes needed

**File:** `app/components/navbar.tsx`

Currently the navbar has:
- "Log In" → `https://camelai.dev`
- "Create Account" → `https://camelai.dev/signup`

No changes needed here — these are standalone navigation links unrelated to the hero prompt flow.

---

### Part 2: Web App Changes (chiridion-app)

#### 2A. Thread the `prompt_key` param through the auth flow

The auth flow already has a `?redirect=` parameter that survives login/signup. The sales site encodes the KV key inside that redirect target as `?prompt_key=<key>`.

**Files:** no web-app change required here. Current behavior in `src/routes/_auth.tsx`, `src/routes/_auth.login.tsx`, and `src/routes/_auth.signup.tsx` already supports this pattern.

**URL shape from the sales site:**

```
https://camelai.dev/signup?redirect=%2Fchat%3Fprompt_key%3Dset-me
```

This way:
1. User hits `/signup?redirect=%2Fchat%3Fprompt_key%3D...`
2. If already logged in → `_auth.tsx` redirects to `/chat?prompt_key=...` (existing behavior)
3. If they sign up → `login-form.tsx` / `signup-form.tsx` navigate to `redirectTo` which is `/chat?prompt_key=...`
4. If they switch to login → the `redirect` param carries through (see 2B)

**Validation:** `getSafeRedirect` in `_auth.tsx` validates that the redirect starts with `/` and doesn't contain `:` or `//`. The value `/chat?prompt_key=set-me` passes all these checks.

#### 2B. Carry `redirect` param when switching between login and signup

**Files:**
- `src/components/auth/login-form.tsx`
- `src/components/auth/signup-form.tsx`

Both forms have a "Don't have an account? Sign up" / "Already have an account? Log in" link. These links must carry the `redirect` param so the prompt isn't lost when users switch between login and signup.

This is already implemented today:
- `login-form.tsx` builds `signupHref` from `redirectTo`
- `signup-form.tsx` builds `loginHref` from `redirectTo`

This step is validation-only. No code change is expected unless that existing behavior regresses.

If those links ever stop carrying `redirectTo`, the correct shape is:

```tsx
// In login-form.tsx
<Link to={redirectTo ? `/signup?redirect=${encodeURIComponent(redirectTo)}` : '/signup'}>
  Sign up
</Link>

// In signup-form.tsx
<Link to={redirectTo ? `/login?redirect=${encodeURIComponent(redirectTo)}` : '/login'}>
  Log in
</Link>
```

#### 2C. Create shared sales-prompt KV helper

**File:** `src/lib/sales-prompt.server.ts` (new file)

Centralize all KV-based prompt operations:

```typescript
const SALES_PROMPT_KV_PREFIX = 'sales_prompt:';
const MAX_SALES_PROMPT_CHARS = 10_000;

interface SalesPromptRecord {
  prompt: string;
  createdAt: number;
}

/**
 * Read and delete a sales prompt from KV by key. Returns null if not found/expired.
 * Deletes the key after reading (one-time use).
 */
export async function consumeSalesPrompt(
  kv: KVNamespace,
  key: string
): Promise<string | null> {
  const kvKey = `${SALES_PROMPT_KV_PREFIX}${key}`;
  const raw = await kv.get(kvKey);
  if (!raw) return null;

  // Delete immediately (fire-and-forget is fine — TTL is the safety net)
  await kv.delete(kvKey);

  try {
    const record = JSON.parse(raw) as SalesPromptRecord;
    return sanitizeSalesPrompt(record.prompt);
  } catch {
    return null;
  }
}

/**
 * Sanitize a sales prompt: trim, strip system message tags, enforce max length.
 */
export function sanitizeSalesPrompt(raw: string): string | null {
  let prompt = raw.trim();
  prompt = prompt.replace(/<\/?camelai system message>/gi, '').trim();
  if (!prompt) return null;
  return prompt.slice(0, MAX_SALES_PROMPT_CHARS);
}

/**
 * Extract prompt_key from a URL's search params.
 */
export function getPromptKeyFromUrl(url: URL): string | null {
  return url.searchParams.get('prompt_key')?.trim() || null;
}
```

#### 2D. Handle the `prompt_key` param on the `/chat` welcome screen (Scenarios 2 & 3)

**File:** `src/routes/_app.chat._index.tsx`

The loader should read `?prompt_key` from the URL, look up the prompt in KV, and pass it to the component:

```typescript
// In the loader:
const url = new URL(request.url);
const promptKey = getPromptKeyFromUrl(url);
let salesPrompt: string | null = null;
if (promptKey) {
  salesPrompt = await consumeSalesPrompt(env.APP_KV, promptKey);
}

// Add to return:
return {
  // ...existing fields
  salesPrompt,
};
```

**File:** `src/routes/_app.chat._index.tsx` (component)

Pass `salesPrompt` to `Chat` as a new prop `initialWelcomeInput`:

```typescript
<Chat
  workspaceId={workspaceId}
  hostname={hostname}
  initialWelcomeInput={salesPrompt}
  welcomeData={{...}}
/>
```

**File:** `src/components/Chat.tsx`

Add `initialWelcomeInput?: string | null` to `ChatProps`.

Technical note: `useState(initialWelcomeInput ?? '')` by itself is not sufficient here because `_app.chat._index.tsx` does not key `Chat` by search params. If the user navigates to `/chat?prompt_key=...` while the welcome screen is already mounted, the prop can change without a remount. The implementation should seed/sync `welcomeInput` from `initialWelcomeInput` without clobbering an existing manual draft.

At minimum, the logic should behave like:

```typescript
const [welcomeInput, setWelcomeInput] = useState(initialWelcomeInput ?? '');

useEffect(() => {
  if (!initialWelcomeInput) return;
  setWelcomeInput((current) => (current.trim().length === 0 ? initialWelcomeInput : current));
}, [initialWelcomeInput]);
```

Currently `welcomeInput` is initialized as `''`. This change pre-fills the composer when a prompt arrives via URL. The user can edit it before pressing send (satisfies scenarios 2 & 3).

**Clean up the URL:** The `?prompt_key=` should be removed from the browser URL after the loader has consumed the KV value. Since the prompt is now in the component's state (via `initialWelcomeInput` from the loader), the URL param is no longer needed.

```typescript
useEffect(() => {
  const url = new URL(window.location.href);
  if (url.searchParams.has('prompt_key')) {
    url.searchParams.delete('prompt_key');
    window.history.replaceState({}, '', url.pathname + url.search);
  }
}, []);
```

Unlike the inline-prompt approach, cleaning up the URL here is safe — the KV value has already been consumed and deleted server-side. Keeping the key in the URL would just show a stale reference.

#### 2E. Handle the `prompt_key` param for new users going through onboarding (Scenario 1)

New users who sign up land on `/onboarding` before reaching `/chat`. The onboarding flow auto-completes and redirects to `/chat/{threadId}?newThread=1`. We need to:

1. Carry the prompt key through onboarding
2. Customize the system message
3. Send the user's prompt as the first visible message

**Step 1: Carry `prompt_key` through the redirect chain into onboarding**

After a new user signs up, the auth form navigates to `redirectTo`. For sales-site users, `redirectTo` is `/chat?prompt_key=abc123`. The `_app` layout sees the user hasn't completed onboarding and redirects to `/onboarding`.

Since the prompt key is just a short string (21 chars), it survives trivially in URL params. No cookie needed.

**File:** `src/routes/_app.tsx` (or wherever the onboarding redirect lives)

Look for the redirect to `/onboarding` and preserve the original URL:

```typescript
const url = new URL(request.url);
const promptKey = getPromptKeyFromUrl(url);
const onboardingUrl = promptKey
  ? `/onboarding?prompt_key=${promptKey}`
  : '/onboarding';

throw redirect(onboardingUrl);
```

**Important:** Do NOT consume (read+delete) the KV value at this point. The key just needs to pass through. The value is consumed only once, in `onboarding.complete.ts` or `_app.chat._index.tsx`, depending on the scenario.

**Step 2: Pass the prompt key to the onboarding completion API**

**File:** `src/routes/_onboarding.tsx`

The onboarding component should read `prompt_key` from its URL and pass it to the completion endpoint. Also persist the key in `sessionStorage` so it survives a page refresh during email verification:

```typescript
// On mount, persist prompt_key to sessionStorage as backup
useEffect(() => {
  const key = new URLSearchParams(window.location.search).get('prompt_key');
  if (key) {
    sessionStorage.setItem('salesPromptKey', key);
  }
}, []);

// In completeOnboarding:
const promptKey =
  new URLSearchParams(window.location.search).get('prompt_key') ||
  sessionStorage.getItem('salesPromptKey');

const response = await fetch('/api/onboarding/complete', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(promptKey ? { promptKey } : {}),
});
```

Using `sessionStorage` here is appropriate as a backup — it covers the case where the user refreshes the onboarding page (losing the URL param) but stays in the same tab. The primary source is the URL param. For cross-tab scenarios (email verification opening in a new tab), the `sessionStorage` in the original tab still has the key when the user returns to click "Get Started."

**Step 3: Customize the onboarding system message when a sales prompt exists**

**File:** `src/routes/api/onboarding.complete.ts`

Add a new system message variant for sales-site users:

```typescript
const SALES_SITE_ONBOARDING_SYSTEM_MESSAGE = `This user just signed up from the camelAI sales site where they typed a
starter prompt. This is their very first interaction with camelAI.

Welcome them briefly (1 sentence max — they already told you what they want),
then start working on their request immediately. They came here to build
something specific, so skip the preference questions and dive right in.

If you need clarification about their request, ask focused follow-up questions
inline (not via AskUserQuestion) as you work.`;
```

In the action handler, resolve `salesPrompt` from KV using the key sent by the client:

```typescript
const body = await request.json().catch(() => ({}));
const promptKey = typeof body.promptKey === 'string' ? body.promptKey.trim() : null;

let salesPrompt: string | null = null;
if (promptKey) {
  salesPrompt = await consumeSalesPrompt(env.APP_KV, promptKey);
}
```

Use `SALES_SITE_ONBOARDING_SYSTEM_MESSAGE` instead of `ONBOARDING_SYSTEM_MESSAGE` when `salesPrompt` is present:

```typescript
const systemMessage = salesPrompt
  ? SALES_SITE_ONBOARDING_SYSTEM_MESSAGE
  : ONBOARDING_SYSTEM_MESSAGE;

return Response.json({
  success: true,
  threadId: thread.id,
  onboardingSystemMessage: systemMessage,
  salesPrompt, // normalized server-side value; client uses this to build the pending message
  redirectTo: `/chat/${thread.id}?newThread=1`,
});
```

Note: `consumeSalesPrompt` already deletes the KV key after reading. No cookie cleanup needed.

Technical follow-up: when `salesPrompt` exists, trigger `chatDO.generateThreadTitle(...)` in the background using that prompt. Otherwise the thread will keep the placeholder onboarding title (`"${firstName}'s first chat"`), because this code path does not create the thread with a `firstMessage`.

**Step 4: Construct the pending message with both system message and user prompt**

**File:** `src/routes/_onboarding.tsx`

After `completeOnboarding` succeeds, if a sales prompt exists, store **two** pending messages or a combined payload:

```typescript
if (threadId && onboardingSystemMessage) {
  // Build the full message: system context + user's actual prompt
  let fullMessage = `<camelai system message>${onboardingSystemMessage}</camelai system message>`;
  if (salesPrompt) {
    fullMessage += `\n\n${salesPrompt}`;
  }

  sessionStorage.setItem(
    PENDING_NEW_THREAD_MESSAGE_KEY,
    JSON.stringify({
      message: fullMessage,
      threadId,
    })
  );
}
```

This way, the agent receives the system message (hidden from user) and the user's prompt (visible) as a single turn. The `<camelai system message>` tag wrapping ensures the system portion is hidden in the UI while the user's prompt appears as their first message.

**Verified against the current codebase:** message rendering already strips `<camelai system message>` tags in `src/components/message-bubble.tsx`, and thread-preview helpers already strip the same tags. No new parser behavior is required for the combined-string approach.

`workspaceId` / `orgSlug` in the pending payload are optional. They are only needed if we also want the `src/routes/_app.chat.$id.tsx` client-loader fast path for onboarding-created threads; correctness does not depend on them.

---

### Part 3: Edge Cases & Robustness

#### 3A. OAuth signups (Google/GitHub)

OAuth signup flow:
1. User clicks "Sign up with Google" on `/signup?redirect=/chat?prompt=...`
2. Redirected to Google → back to `/api/auth/google/callback`
3. Callback redirects to... where?

Current implementation note: `workers/main/src/routes/oauth.ts` already stores `redirect_url` in the signed OAuth-state cookie and redirects to it on callback. No new feature work is required here for this pipeline.

The only recommended change while touching this path is hardening: sanitize the incoming `redirect` before storing it in OAuth state so it matches the same safety rules as `_auth.tsx`.

#### 3B. Email verification interruption (Scenario 1, password signup)

Password signups require email verification before onboarding completes. The user might:
1. Sign up → land on onboarding welcome screen (email not yet verified)
2. Go verify email in another tab
3. Come back and click "Get Started"

The prompt must survive this. With the KV approach, the prompt lives server-side for 30 minutes. The only thing that needs to survive client-side is the short key string. The onboarding component persists this to `sessionStorage` on mount (see Step 2 in 2E), so it survives page refreshes within the same tab.

Implementation consequence:
- The KV entry's 30-minute TTL is generous enough for email verification flows
- `sessionStorage` in the original tab has the key as backup
- If the user opens verification in a new tab then returns, the original tab still has the key in `sessionStorage`
- If the user takes >30 minutes to verify, the KV entry expires and they get the normal onboarding flow. This is acceptable graceful degradation.
- Cross-device verification (started on phone, verified on desktop) will not preserve the prompt. This is acceptable for v1.

#### 3C. Prompt sanitization

Sanitization happens in two places:
1. **On write** (sales site `POST /api/store-prompt`): trim, strip `<camelai system message>` tags, enforce max length before writing to KV
2. **On read** (web app `consumeSalesPrompt` helper): re-sanitize as defense-in-depth after parsing the KV value

Both use the same logic. The sales site can inline it; the web app uses the shared `sanitizeSalesPrompt` helper in `src/lib/sales-prompt.server.ts`.

#### 3D. Thread title generation for sales-site onboarding threads

This is not handled by the draft, but it matters in the current codebase.

`src/routes/api/onboarding.complete.ts` creates onboarding threads with a fixed title and **without** a `firstMessage`. That means the usual `generateThreadTitle(...)` path never runs automatically. If we auto-send a sales-site prompt into onboarding, the thread title will otherwise remain a placeholder forever.

When `salesPrompt` exists, call `chatDO.generateThreadTitle(context, thread.id, workspaceId, salesPrompt)` in the background after thread creation (or recovery).

---

## Files to Modify

### Sales Site (`camelai-salessite`)

| File | Changes |
|------|---------|
| `wrangler.jsonc` | Add `APP_KV` binding (same namespace ID as web app, per environment) |
| `app/routes/home.tsx` | Add `action` export (KV write + 302 redirect), convert hero input to `<Form>` submission |
| `app/components/hero-input.tsx` | Adapt to work as part of a `<Form>` (submit triggers form POST instead of `window.location.href`) |

### Web App (`chiridion-app`)

| File | Changes |
|------|---------|
| `src/routes/_auth.tsx` | No changes needed (already handles `?redirect`) |
| `src/components/auth/login-form.tsx` | Validation-only: confirm "switch to signup" link still carries `?redirect` |
| `src/components/auth/signup-form.tsx` | Validation-only: confirm "switch to login" link still carries `?redirect` |
| `src/lib/sales-prompt.server.ts` | **New helper.** `consumeSalesPrompt(kv, key)`, `sanitizeSalesPrompt(raw)`, `getPromptKeyFromUrl(url)` |
| `src/routes/_app.tsx` (or equivalent) | Preserve `prompt_key` in onboarding redirect URL |
| `src/routes/_onboarding.tsx` | Persist `prompt_key` to sessionStorage on mount, pass it to `completeOnboarding`, build combined system+user pending message from API response |
| `src/routes/api/onboarding.complete.ts` | Accept `promptKey` in body, consume from KV, use alternate system message, return `salesPrompt`, trigger background title generation |
| `src/routes/_app.chat._index.tsx` | Read `?prompt_key` from URL, consume prompt from KV in loader, pass as `initialWelcomeInput` to Chat |
| `src/components/Chat.tsx` | Accept `initialWelcomeInput` prop and sync-seed `welcomeInput` without clobbering an existing manual draft |
| `workers/main/src/routes/oauth.ts` | No new flow work required; optional hardening to sanitize `redirect` before storing OAuth state |

---

## Acceptance Criteria

1. **New user from sales site:** Types "Build me a dashboard" on camelai.com → signs up → lands in a chat where "Build me a dashboard" has already been sent and the agent is responding. The agent's system context indicates this is a sales-site user and skips the standard onboarding preference questions.

2. **Returning user (logged out) from sales site:** Types a prompt → redirected to signup → clicks "Log in" → logs in → lands on `/chat` welcome screen with "Build me a dashboard" pre-filled in the composer. Can edit before sending.

3. **Returning user (logged in) from sales site:** Types a prompt → redirected to camelai.dev → immediately lands on `/chat` welcome screen with the prompt pre-filled in the composer. Can edit before sending.

4. **OAuth signup from sales site:** Types a prompt → signs up with Google → completes OAuth → onboarding auto-completes → lands in chat with prompt auto-sent (same as scenario 1).

5. **Password signup with email verification:** Prompt survives the email verification step in the same browser session, including when the verification link opens in a new tab. After verifying and clicking "Get Started," the prompt is still sent as the first message.

6. **Empty prompt:** If user somehow arrives at camelai.dev with an empty or expired `?prompt_key=`, it is ignored and the normal flow proceeds.

7. **No prompt (direct visit):** Existing flows (direct signup, direct login, normal `/chat`) are completely unaffected.

8. **Prompt sanitization:** A prompt containing `<camelai system message>` tags has those tags stripped before use.

9. **Authenticated but incomplete onboarding:** A user who already has a valid session but is still gated to `/onboarding` does not lose the sales-site prompt during the `_app` redirect.

10. **Onboarding thread title:** When the prompt is auto-sent through the onboarding path, the resulting thread title is generated from the sales prompt instead of remaining a permanent placeholder.
