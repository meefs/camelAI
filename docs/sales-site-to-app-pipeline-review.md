# Sales Site to App Pipeline — Code Review

Review of commit `9fdf2ff8` (web app) and uncommitted changes in `camelai-salessite`.

## Verdict

Solid implementation overall. Two critical bugs found and fixed in post-deploy testing:

1. **Parallel loader race condition** — `_app.chat._index.tsx` consumed the KV entry in parallel with `_app.tsx` redirecting new users to onboarding, deleting the prompt before the onboarding flow could use it. Fixed by gating KV consumption on `onboarding.completed_at`.
2. **Email verification new-tab issue** — `sessionStorage` is per-tab, so when the verification link opened in a new tab, the prompt key was inaccessible. Fixed by switching to `localStorage`.

---

## Issues (fixed)

### 1. Parallel loader race condition (critical — FIXED)

React Router runs nested route loaders in parallel. When a new user hits `/chat?prompt_key=abc`:
- `_app.tsx` loader starts → will redirect to `/onboarding?prompt_key=abc`
- `_app.chat._index.tsx` loader starts IN PARALLEL → consumes (deletes) the KV entry
- By the time onboarding calls `POST /api/onboarding/complete`, the KV entry is gone

**Fix:** `_app.chat._index.tsx` now only consumes the KV entry when `authContext.onboarding?.completed_at` is truthy. New users going through onboarding will have the KV entry consumed by `onboarding.complete.ts` instead.

### 2. Email verification opens in a new tab (critical — FIXED)

`/api/auth/verify-email` always redirects to `/onboarding?emailVerified=1` — no `prompt_key` in the URL. The new tab has no access to `sessionStorage` from the original tab, so `completeOnboarding()` finds no prompt key.

**Fix:** Changed `salesPromptKey` storage from `sessionStorage` to `localStorage`, which is shared across tabs of the same origin. Cleanup still happens after successful consumption.

## Issues (remaining)

### 1. OAuth redirect chain (needs manual verification)

The chain looks correct in code: `/signup?redirect=%2Fchat%3Fprompt_key%3Dabc` → `OAuthButtons` → `/api/auth/google?redirect=...` → cookie → callback → `/chat?prompt_key=abc`. `searchParams.set()` handles encoding correctly, and `sanitizeRedirectPath` allows the value through.

**Action:** Manually test the full OAuth signup flow with a `prompt_key` redirect after the parallel-loader fix is deployed. The race condition fix may have been the only issue.

### 2. `consumeSalesPrompt` deletes before parsing (low)

In `sales-prompt.server.ts:20`, the KV entry is deleted *before* the JSON parse at line 23. If parsing fails (corrupted data), the key is consumed but no prompt is returned. This is probably fine (corrupted data is unrecoverable anyway, and TTL would clean it up), but it's worth noting. The alternative — delete after successful parse — would let a retry succeed if the issue is transient (it won't be for JSON parse errors, but could be for a hypothetical future validation step).

**Action:** No change required. Just be aware.

### 3. No key format validation on `prompt_key` param (low)

`getPromptKeyFromUrl` returns any trimmed string from `?prompt_key=`. There's no validation that it looks like a UUID or nanoid before hitting KV. Malicious/garbage keys will just return `null` from KV (safe), but it means every page load with `?prompt_key=garbage` triggers a KV `get` + `delete` call. Not exploitable for DoS at Cloudflare KV scale, but a length check or character allowlist would be cheap defense-in-depth.

**Action:** Optional. Consider adding `if (key.length > 64) return null;` or similar guard in `getPromptKeyFromUrl`.

### 4. Sales site uses custom nanoid, web app plan doc mentions `crypto.randomUUID()` (cosmetic)

The sales site `home.tsx` uses `createSalesPromptKey()` which generates a 21-char base64url key. The plan doc's example code uses `crypto.randomUUID()`. Both work fine — the web app doesn't validate the key format, it just uses it as a KV lookup key. But the inconsistency between plan and implementation may confuse future readers.

**Action:** Update the plan doc to reflect the actual implementation, or leave a note that the key format is opaque.

### 5. `_app.tsx` reads `prompt_key` on every `_app` load (low)

Line 33 of `_app.tsx` calls `getPromptKeyFromUrl(url)` on every `_app` loader invocation, not just when the user hasn't completed onboarding. The only place the value is used is in the onboarding redirect (lines 34-39). This is harmless (it's a cheap URL parse), but the `getPromptKeyFromUrl` import and call could be scoped inside the `if (!authContext.onboarding?.completed_at)` block for clarity.

**Action:** Optional cleanup.

### 6. Welcome input sync effect doesn't handle the `null → non-null` case on first render (edge case)

In `Chat.tsx:862-879`, the effect checks `if (!initialWelcomeInput) return`, so if `initialWelcomeInput` is `null` on first render but becomes non-null later (not currently possible since the loader resolves it before render), the state wouldn't update. The `useState(() => initialWelcomeInput ?? '')` on line 1072 handles the first render correctly. The effect is only for subsequent prop changes — this is fine for the current usage.

**Action:** No change required.

### 7. Tests mock `getAuthEnv` from wrong module in `onboarding-complete-sales-prompt.test.ts`

The test mocks `getAuthEnv` from `@/lib/auth.server` (line 20), but the actual `onboarding.complete.ts` imports `getAuthEnv` from `@/lib/auth.server` on line 2 as well. This works, but it's fragile — if the import source changes, the mock breaks silently. The test passes today, so no immediate issue.

**Action:** No change required, but keep in mind if refactoring imports.

### 8. Missing test: expired/missing KV key returns null gracefully

The existing `sales-prompt.test.ts` tests consume-then-second-read-is-null, but there's no explicit test for the case where the key simply doesn't exist in KV from the start (simulating an expired TTL). The code handles it (`if (!raw) return null`), and it's trivially correct, but an explicit test would document the expected behavior for the expiry scenario.

**Action:** Optional. One-line test: `expect(await consumeSalesPrompt(kv, 'nonexistent')).toBeNull()`.

### 9. `_onboarding.tsx` retry loop could consume the KV key on first attempt then retry without it

`completeOnboarding` (line 117) reads the prompt key and sends it to the API. The API consumes (deletes) the KV entry. If the API returns 200 but the client-side navigation fails, or if the response is a transient network error *after* the server already processed the request, the retry in `runAutoComplete` will send the same `promptKey` again but KV will return null. The API handles this gracefully (just proceeds without a sales prompt), but the user might end up with the default onboarding flow instead of the sales-site flow on retry.

**Action:** This is an inherent trade-off of delete-after-read. The `expectsSalesPrompt` + `existingThread.first_user_message` recovery logic in `onboarding.complete.ts:103-104` partially addresses this for the already-completed case. For the first-attempt case, the retry would still lose the prompt. Acceptable for v1 — document this known limitation.

### 10. Auth form "switch" links already carry `redirect` (confirmed good)

`login-form.tsx:38-41` and `signup-form.tsx:41-44` both forward `redirectTo` when linking to the other form. This means switching between login and signup preserves `?redirect=%2Fchat%3Fprompt_key%3D...`. No changes needed.

---

## What's good

- **KV helper** (`sales-prompt.server.ts`) is clean, well-separated, and reusable
- **Sanitization** strips `<camelai system message>` tags on both write (sales site) and read (web app) — defense in depth
- **URL cleanup** in `Chat.tsx` removes stale `prompt_key` from the address bar after consumption
- **Thread title generation** is triggered in background when a sales prompt exists — prevents permanent placeholder titles
- **Recovery path** in `onboarding.complete.ts` handles the already-completed-onboarding edge case, including falling back to `first_user_message` when KV is already consumed
- **Tests** cover the KV helper, `_app` redirect preservation, `/chat` loader consumption, and onboarding completion with sales prompt — including the email verification blocking case
- **Sales site changes** are minimal and clean: `<Form>` submission, server action with 302 redirect, no client-side fetch roundtrip
- **`isSubmitting` state** in `HeroInput` prevents double-submission during the server action
