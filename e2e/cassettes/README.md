# LLM cassettes (deterministic E2E)

Recorded model responses so the agent loop runs **offline and deterministically**
in E2E — no real model calls, no cost, no flakiness. Full fidelity: cassettes are
the *real* recorded responses, not fabricated ones.

## How it works

- `scripts/llm-replay-stub.mjs` is a tiny HTTP server that records/replays.
- The worker routes every provider's model calls to it when its env carries
  `TEST_LLM_REPLAY_URL` (see `resolvePiModel` in `workers/main/src/chat-thread-do.ts`).
- Cassettes are keyed **by ordinal**, read straight from each request body:

  ```
  key = sha256(first user message).slice(0,16) + "-" + (number of assistant turns so far)
  ```

  Long digit runs in the first user message are collapsed before hashing, so
  prompts that embed a timestamp (e.g. `Test message ${Date.now()}` in the E2E
  suite) still match a once-recorded cassette. Otherwise no canonicalization is
  needed, it's stateless (no per-session counter, so concurrent tests can't
  collide), and it replays the real recorded SSE verbatim — paced one event at a
  time (`REPLAY_DELAY_MS`, default 25ms) so streaming-timing assertions hold. The
  one assumption: a spec makes the **same number of LLM calls in the same order**
  each run (true for short, fixed E2E flows).

Files here are `<key>.sse` — the raw recorded response bytes (SSE for streamed
turns, JSON otherwise).

## Interception (verified)

The worker routes model calls to the stub via **two** seams, both keyed on
`TEST_LLM_REPLAY_URL`:

- `resolvePiModel` (`chat-thread-do.ts`) overrides the per-model `baseUrl` —
  covers direct/BYOK provider calls.
- `resolveCloudflareGatewayOrigin` (`src/lib/cloudflare-ai-gateway.ts`) overrides
  the AI Gateway origin — covers the **hosted** path (the AI virtual binding),
  which is what a default turn actually uses. Without this the stub is never hit.

Confirmed working: a local bypass turn's request lands on the stub
(`replay POST /v1/messages -> key ... (miss)`).

## Recording — use the AI Gateway Logs API, not the proxy

Record mode (`REPLAY_MODE=record`, `REPLAY_UPSTREAM=...`) proxies and tees, but
for the **hosted/gateway** path it does **not** work cleanly: the gateway injects
the provider key and encodes the provider in its URL path, and the origin-swap
flattens both — so a proxied record gets `x-api-key required` (wrong upstream) or
`model not found` (wrong provider route). Proxy-record only suits a single
static-base direct provider.

For the hosted path, record by running the suite once **normally** (real gateway,
correct routing/auth, real response) and harvesting the request/response payloads
from the **AI Gateway Logs API**
(`GET /accounts/{id}/ai-gateway/gateways/{gw}/logs/{id}/{request,response}`), then
writing them as `e2e/cassettes/<key>.sse`. Replay (the default) then needs no
network.

## Wiring the worker (local boot)

`playwright.config.ts` (with `E2E_LOCAL=1`) starts the stub and the app, and sets
`TEST_LLM_REPLAY_URL` on the app process. `vite.config.ts`'s `withLocalDevVars`
forwards it into the worker config (alongside `LOCAL_AUTH_BYPASS` etc.), so both
interception seams see it — no manual `.dev.vars` entry needed for the
`react-router dev` path. Verified: the app boots under bypass, auto-auths as
`local-dev-user`, and turns complete locally (~1.5s).

(Validating the full local boot — including the project-runtime-service the
`dev:local-auth` script also starts — and harvesting the real cassettes remain
the steps before the `E2E_LOCAL` path is green in CI.)
