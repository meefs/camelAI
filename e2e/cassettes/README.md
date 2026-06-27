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

## Recording

Run once against the real model to populate cassettes, then commit them:

```bash
REPLAY_MODE=record \
REPLAY_UPSTREAM=https://openrouter.ai/api/v1 \   # the real model base for your default model
REPLAY_DIR=e2e/cassettes \
node scripts/llm-replay-stub.mjs
# ...point the app's TEST_LLM_REPLAY_URL at the stub and run the E2E specs once...
```

The stub proxies to `REPLAY_UPSTREAM`, returns the real response, and tees it to
`<key>.sse`. After that, replay mode (the default) needs no network.

## Wiring the worker (local boot)

`playwright.config.ts` (with `E2E_LOCAL=1`) starts the stub and the app, and sets
`TEST_LLM_REPLAY_URL` on the app process. `vite.config.ts`'s `withLocalDevVars`
forwards it into the worker config (alongside `LOCAL_AUTH_BYPASS` etc.), so
`resolvePiModel` sees it — no manual `.dev.vars` entry needed for the
`react-router dev` path.

(Validating the full local boot — including the project-runtime-service the
`dev:local-auth` script also starts — is the remaining step before the
`E2E_LOCAL` path is green in CI.)
