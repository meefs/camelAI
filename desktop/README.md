# camelAI Desktop Prototype

This is a separate local-first desktop project that lives alongside the Cloudflare web app.

Current scope:

- Electron shell
- local desktop service for persistence and orchestration, with a Bun child only as the current dev fallback
- persisted local threads/messages
- persisted local model preference (`sonnet` or `opus`)
- persisted structured transcripts for assistant tool calls and thinking blocks
- `desktop/runtime-helper` as the Swift helper that uses Apple containerization and a persistent daemon socket
- macOS packaging via Electron Builder with a drag-to-Applications DMG

`desktop/runtime-helper` requires Apple silicon, macOS 26, and Xcode 26.

Not in scope yet:

- login, orgs, billing, onboarding
- Cloudflare deployment and published apps
- Durable Objects / KV / R2
- packaging, signing, and updater flows

## Commands

```bash
bun run desktop:dev
bun run desktop:check
bun run desktop:probe-startup
bun run desktop:probe-turn
bun run desktop:probe
bun run desktop:probe:staged
bun run desktop:stage
bun run desktop:icons
bun run desktop:start:staged
bun run desktop:dist:mac:unsigned
bun run desktop:dist:mac
bun run desktop:runtime-helper:build
desktop/runtime-helper/.build/debug/camelai-runtime-helper prepare --json
desktop/runtime-helper/.build/debug/camelai-runtime-helper status --json
```

## Environment

Required for model responses:

```bash
claude auth login
```

Optional:

```bash
export DESKTOP_ANTHROPIC_MODEL=sonnet
export DESKTOP_BACKEND_PORT=4315
export DESKTOP_RENDERER_PORT=4316
export DESKTOP_DATA_DIR=/custom/path
export DESKTOP_RUNTIME_DIR=/custom/path/runtime
export DESKTOP_RUNTIME_HELPER_PATH=/custom/path/to/camelai-runtime-helper
export DESKTOP_RUNTIME_IMAGE=docker.io/vercantes/camelai-openwork:20260404-v5
export DESKTOP_DISABLE_LOCAL_CONTROL_PLANE_OVERRIDE=1 # opt out of desktop:dev local control-plane override
export DESKTOP_VERBOSE_LOGS=1
export DESKTOP_LOG_LEVEL=debug
export DESKTOP_STDERR_LOG_LEVEL=info
export ANTHROPIC_API_KEY=... # optional fallback

# preferred notarization path
export APPLE_API_KEY=/absolute/path/to/AuthKey_ABC123XYZ.p8
export APPLE_API_KEY_ID=ABC123XYZ
export APPLE_API_ISSUER=00000000-0000-0000-0000-000000000000

# alternate notarization path
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
export APPLE_TEAM_ID=ABCDE12345
```

## Architecture

- `desktop/backend` owns local persistence and starts the local runtime as part of app boot.
- `desktop/runtime-helper` is the Swift executable boundary for local runtime lifecycle. It uses Apple containerization, exposes a persistent daemon socket for `status` / `prepare` / `start` / `stop`, validates the staged kernel/runtime directories, pulls the published control-plane image from the registry when needed, and starts the container through the image entrypoint so the control plane runs as the unprivileged `node` user.
- `desktop/electron` owns the app window and preload bridge.
- `desktop/renderer` owns the chat UI.
- `desktop/app-resources` is the staged immutable app payload for packaging: bundled desktop-service module, compiled backend binary fallback, built renderer, staged Linux kernel, and runtime helper binary.
- The desktop backend now owns provider-aware state for the desktop shell: active provider, provider-scoped model selection, provider auth state, and provider metadata exposed to the renderer all flow through the shared desktop protocol rather than Claude-only fields.
- The current runtime implementation still stages Claude auth files and runtime env into the shared runtime directory before startup, then makes that staged home tree writable by the unprivileged container user. The provider abstraction is in place so additional runtimes can slot into the same desktop contract later without rewriting the renderer/backend boundary.
- Host Claude login still follows the same rule in both dev and packaged runs: the desktop backend stages `~/.claude.json` plus usable Claude Code OAuth credentials into the runtime auth home, including macOS Keychain-backed auth.
- The desktop renderer talks to Electron main over preload IPC in the normal app path.
- In staged/packageable builds, Electron main loads the bundled desktop service directly from app resources.
- In local development, Electron main still falls back to the backend child process and bridges backend stdio events to the renderer.
- `bun run desktop:dev` now stages the local [desktop/control-plane/control-plane.mjs](/Users/miguelsalinas/.codex/worktrees/581d/chiridion-2/desktop/control-plane/control-plane.mjs) plus companion `package.json`, `package-lock.json`, and `node_modules/` into the shared runtime directory, and the guest entrypoint prefers that dev override automatically. That means provider runtime changes, including in-container `codex app-server` support, are picked up on the next dev start without rebuilding or publishing the image.
- `bun run desktop:dev` also prepares `desktop/control-plane/node_modules/` before launch and ensures the Linux arm64 Codex package is present, so the guest can run `codex app-server` even when development starts from a macOS checkout.
- `bun run desktop:dev` defaults the runtime image to `docker.io/vercantes/camelai-openwork:20260404-v5`, which supports the staged dev control-plane override. The desktop backend also stages the host CA bundle into the shared runtime mount and exports `SSL_CERT_FILE`-style env vars so guest-side tools can complete TLS even when the base image is minimal.
- The active desktop provider always runs inside the guest runtime. Claude uses the Claude Agent SDK in the control plane; Codex uses `codex app-server` from the same control-plane container.
- `bun run desktop:probe` runs a hidden Electron startup probe against the real dev startup path and prints JSON diagnostics for renderer/backend/preload handshake issues.
- `bun run desktop:probe-startup` is the fastest startup-only repro loop and includes backend runtime stderr trace output.
- `bun run desktop:probe-turn` waits for the local runtime to boot and then verifies a real desktop chat turn over the stdio backend transport.
- `bun run desktop:probe:staged` does the same against the staged/packageable app layout.
- The desktop runtime only mounts the narrow shared directory at `/mnt/camelai-shared`.
- Normal desktop boots do not rely on a source checkout inside the runtime. The helper starts a published control-plane image directly and reuses a cached root filesystem between launches.

## Logging

The desktop stack writes structured JSON logs for the host send path, runtime lifecycle, control-plane bridge, and provider runtime stderr.

- Dev backend logs: `desktop/.local/logs/desktop-backend.log`
- Electron app logs: `~/Library/Application Support/Electron/data/logs/desktop-backend.log`
- Runtime helper logs: `<DESKTOP_RUNTIME_DIR>/shared/logs/control-plane-service.log`
- Control-plane logs: `<DESKTOP_RUNTIME_DIR>/shared/logs/control-plane.log`
- Claude SDK debug log: `<DESKTOP_RUNTIME_DIR>/shared/logs/claude-sdk-debug.log`

The backend logger also mirrors those JSON lines to stderr, so `bun run desktop:probe-startup` will show the important startup trace directly in the terminal.
Normal desktop runs now suppress debug chatter on stderr by default. Use `DESKTOP_VERBOSE_LOGS=1` to re-enable full terminal tracing.

## Dev Control Plane Override

- `bun run desktop:dev` stops any existing local runtime before launch and stages the current checkout's `desktop/control-plane/control-plane.mjs` into the shared runtime directory.
- The runtime image entrypoint prefers that staged dev override when present, while still reusing the image-bundled `node_modules`.
- Set `DESKTOP_DISABLE_LOCAL_CONTROL_PLANE_OVERRIDE=1` if you need `desktop:dev` to use the image-bundled control plane instead.

## Runtime Artifacts

The helper supports a lightweight `prepare` step for manual checks. It creates:

- `desktop/.local/runtime/shared/`
- `desktop/.local/runtime/artifacts/`
- `desktop/.local/runtime/containerization/`

In development, the runtime helper is prepared automatically. There is no separate bake step, no disk image to hydrate, and no runtime-time dependency install inside the container.

The desktop app treats the local runtime as an internal dependency. On launch it automatically tries to bring the runtime up, and the first message send will also ensure the runtime is ready if startup has not completed yet. If the helper reports an already-running runtime after a relaunch, the backend does a short `/health` probe before trusting it and restarts the container once when that probe fails. The UI only surfaces runtime state when startup is still in progress or when there is an actual error.

The backend talks to the helper daemon for `status`, `prepare`, `start`, and `stop` instead of spawning a one-shot process for each operation.

## Shipping Model

The desktop runtime no longer needs the whole repo mounted at runtime, and the Electron shell no longer has to assume a source checkout.

- The runtime only mounts the narrow shared directory at `/mnt/camelai-shared`.
- `bun run desktop:stage` builds a staged app payload under `desktop/app-resources/`:
  - `renderer/` static renderer bundle
  - `backend/index.mjs` bundled desktop service module for direct Electron import
  - `bin/camelai-desktop-backend` compiled Bun backend executable
  - `bin/camelai-runtime-helper` compiled Swift runtime helper
  - `kernel/vmlinux` staged Linux kernel for Apple containerization
- The Electron main process can now load that staged desktop service directly and stores mutable state under Electron `userData` instead of under the repo.
- `bun run desktop:start:staged` runs Electron against `desktop/app-resources/` so you can test the packaged layout before building a real `.app`.

## macOS Beta Builds

- `bun run desktop:icons` generates the desktop app icon assets from `public/favicon.svg`.
- `bun run desktop:dist:mac:unsigned` builds an unsigned macOS `.app`, `.dmg`, and `.zip` into `dist/desktop/`.
- `bun run desktop:dist:mac` runs the same packaging flow but allows Electron Builder to sign and notarize when the required Apple credentials and signing identity are installed.
- The packaged app embeds the staged runtime payload under `Contents/Resources/desktop`, so it does not require a source checkout at runtime.
- The DMG is the recommended beta artifact for teammates because it gives the standard drag-to-Applications install flow.

For notarized builds you still need:

- a locally installed `Developer ID Application` certificate in Keychain for code signing
- one Electron Builder notarization auth method:
  - preferred: `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`
  - alternate: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`

Useful local checks after packaging:

```bash
spctl --assess --type execute -vv dist/desktop/mac-arm64/camelAI.app
xcrun stapler validate dist/desktop/camelAI-0.1.0-arm64.dmg
```
