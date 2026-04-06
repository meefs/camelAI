# camelAI Desktop AgentOS Prototype

This is a sibling desktop prototype that keeps the existing Electron shell and renderer, but replaces the Docker or Apple-containerized runtime with a local [AgentOS](https://rivet.dev/docs/agent-os/overview/) VM.

Current scope:

- no Docker
- no Swift runtime helper
- local AgentOS VM booted directly from the Electron-hosted desktop service
- Pi agent sessions via `@rivet-dev/agent-os-pi`
- the same persisted local threads and renderer used by `desktop/`
- per-thread Pi session state persisted under the AgentOS runtime home so old chats can resume after a desktop restart

Current limits:

- dev-only prototype; no staging or packaged runtime flow yet
- single `agentos` provider only
- workspace is mounted directly from the host checkout into the VM at `/workspace`
- auth prefers Pi credentials from `~/.pi/agent/auth.json` and falls back to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY`
- the session model is chosen from `DESKTOP_AGENTOS_MODEL` and written into a Pi settings file before boot
- the default model prefers Claude when Claude auth exists, then `gpt-5.4` for direct OpenAI auth, then OpenRouter's `openai/gpt-5.1-codex` when only OpenRouter auth exists

## Commands

```bash
bun install
bun run desktop-agentos:install
bun run desktop-agentos:dev
bun run desktop-agentos:check
bun run desktop-agentos:backend
bun run desktop-agentos:probe-resume
bun run desktop-agentos:probe-turn
bun run desktop-agentos:test-gpt54
bun run test:desktop-agentos-openrouter
bun run desktop-agentos:start
```

Notes:

- `desktop-agentos:install` performs the separate install for the AgentOS-only dependencies under `desktop-agentos/`. The root web and worker deploys intentionally do not install that dependency set.
- `desktop-agentos:dev` is the main command. It starts the renderer plus Electron and picks a free localhost port automatically.
- `desktop-agentos:backend` is a smoke check for the AgentOS runtime bootstrap, not a long-lived backend server.
- `desktop-agentos:probe-resume` runs two real turns across a full desktop-service restart and fails unless the second turn remembers the first.
- `desktop-agentos:test-gpt54` runs a real AgentOS ACP probe against `gpt-5.4` and fails if streamed assistant text chunks do not appear.
- `test:desktop-agentos-openrouter` validates OpenRouter model exposure, auth detection, and session env staging without needing a live Electron window.
- `desktop-agentos:probe-turn` runs an end-to-end stdio turn against the AgentOS backend using a fresh temporary desktop data directory.
- `desktop-agentos:start` is the lower-level Electron entrypoint and expects the renderer URL to already be available.

## Environment

Optional:

```bash
export DESKTOP_AGENTOS_WORKSPACE_DIR=/absolute/path/to/workspace
export DESKTOP_AGENTOS_USER_DATA_DIR=/custom/path
export DESKTOP_AGENTOS_MODEL=gpt-5.4
export DESKTOP_AGENTOS_THOUGHT_LEVEL=medium
```

Pi OAuth or API-key auth:

```bash
pi
# then run /login for Claude or ChatGPT Codex
```

Optional API key fallback:

```bash
export OPENAI_API_KEY=...
export ANTHROPIC_API_KEY=...
export OPENROUTER_API_KEY=...
```

OpenRouter uses an app-specific API key flow rather than Pi OAuth. Create a key in OpenRouter settings, export `OPENROUTER_API_KEY`, and the AgentOS model picker will expose Pi's built-in OpenRouter model catalog.

## Architecture

- `desktop-agentos/backend/runtime.ts` owns the AgentOS VM lifecycle and per-thread session management.
- The backend mounts the current workspace into the VM at `/workspace`.
- The backend writes Pi settings into a dedicated runtime home, stages host Pi auth from `~/.pi/agent/auth.json`, mounts that into the VM at `/home/user/.pi`, and assigns each thread a dedicated persisted Pi session directory under `/home/user/.pi/thread-sessions/<provider>/<threadId>`.
- `desktop-agentos/electron/main.mjs` loads the AgentOS desktop service directly into the Electron main process via `tsx`.
- `desktop-agentos/scripts/dev.mjs` reuses the existing desktop renderer and shared Electron shell, but writes state into a separate user-data directory so it does not collide with the Docker-backed prototype.
