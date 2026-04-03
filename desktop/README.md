# camelAI Desktop Prototype

This is a separate local-first desktop project that lives alongside the Cloudflare web app.

Current scope:

- Electron shell
- local desktop service for persistence/orchestration, with a Bun child only as the current dev fallback
- persisted local threads/messages
- persisted local model preference (`sonnet` or `opus`)
- persisted structured transcripts for assistant tool calls and thinking blocks
- Claude Agent SDK runtime inside the Linux guest, using the same Claude Code auth state as the local `claude` CLI by default
- Swift VM helper that prepares and boots a Linux guest directly through Apple Virtualization Framework
- prebaked Ubuntu appliance as the only supported VM boot path
- macOS packaging via Electron Builder with a drag-to-Applications DMG

Not in scope yet:

- login, orgs, billing, onboarding
- Cloudflare deployment and published apps
- Durable Objects / KV / R2
- packaging, signing, and updater flows

## Commands

```bash
bun run desktop:appliance:bake
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
bun run desktop:vm-helper:build
desktop/vm-helper/.build/debug/camelai-vm-helper prepare --json
desktop/vm-helper/.build/debug/camelai-vm-helper status --json
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
export DESKTOP_VM_HELPER_PATH=/custom/path/to/camelai-vm-helper
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

- `desktop/backend` owns local persistence and proxies chat turns into the guest control plane.
- `desktop/guest` contains the Dockerized Linux-side Claude Agent SDK control plane and its isolated dependency set.
- `desktop/electron` owns the app window and preload bridge.
- `desktop/renderer` owns the chat UI.
- `desktop/vm-helper` is the VM control boundary. It prepares the narrow shared host directory, copies a packaged Ubuntu appliance disk into app data, and boots the VM directly with Apple Virtualization Framework.
- `desktop/vm-helper` exposes a persistent stdio JSON-RPC daemon for VM lifecycle/status commands and a local host-side proxy for the guest control-plane port.
- The Linux guest now boots Ubuntu directly under AVF, mounts `/mnt/camelai-shared` over virtiofs, verifies guest DNS, starts Docker, and runs the Claude control plane inside a container while bridging the control-plane port back to the host over virtio socket.
- `desktop/app-resources` is the staged immutable app payload for packaging: bundled desktop-service module, compiled backend binary fallback, built renderer, packaged Ubuntu appliance disk, VM helper binary, and the guest Docker build context.
- The desktop backend pre-stages the guest Docker build context, auth files, and guest env into the shared directory before boot so the Ubuntu guest can consume them on first mount. Repeated turns reuse the same booted runtime instead of rehydrating the VM.
- Host Claude login now follows the same rule in both dev and packaged runs: the desktop backend stages `~/.claude.json` plus usable Claude Code OAuth credentials into the guest's Linux-style `~/.claude/.credentials.json`, including macOS Keychain-backed auth.
- The desktop renderer now talks to Electron main over preload IPC in the normal app path.
- In staged/packageable builds, Electron main loads the bundled desktop service directly from app resources.
- In local development, Electron main still falls back to the backend child process and bridges backend stdio events to the renderer.
- `bun run desktop:probe` runs a hidden Electron startup probe against the real dev startup path and prints JSON diagnostics for renderer/backend/preload handshake issues.
- `bun run desktop:probe-startup` is the fastest startup-only repro loop and now includes backend/VM stderr trace output.
- `bun run desktop:probe-turn` waits for the local runtime to boot and then verifies a real desktop chat turn over the stdio backend transport.
- `bun run desktop:probe:guest:health` is the fastest guest-only health check.
- `bun run desktop:probe:guest` boots the VM and verifies a full guest `/turn` without Electron or the backend stdio bridge.
- `bun run desktop:probe:staged` does the same against the staged/packageable app layout.
- The guest Claude runtime now loads only project-level Claude settings. Host user settings and local plugin marketplace config are intentionally not imported into the VM.
- Normal desktop boots assume a prebaked appliance image with the base guest runtime already installed. `bun run desktop:appliance:bake` is the one-time flow that hydrates `desktop/.local/vm/disk.raw` in development.
- Normal boots do not install app dependencies in the guest OS. The guest starts Docker, then pulls the configured control-plane image or falls back to a local `docker build` from the staged guest context.

## Logging

The desktop stack now writes structured JSON logs for the host send path, VM runtime checks, guest control-plane bridge, and guest Claude SDK stderr.

- Dev backend logs: `desktop/.local/logs/desktop-backend.log`
- Electron app logs: `~/Library/Application Support/Electron/data/logs/desktop-backend.log`
- Guest control-plane logs: `<DESKTOP_VM_DIR>/artifacts/guest-control-plane.log`
- Guest Claude SDK debug log: `<DESKTOP_VM_DIR>/shared/logs/claude-sdk-debug.log`

The backend logger also mirrors those JSON lines to stderr, so `bun run desktop:probe-startup` will show the important startup/VM trace directly in the terminal.
Normal desktop runs now suppress debug chatter on stderr by default. Use `DESKTOP_VERBOSE_LOGS=1` to re-enable full terminal tracing.

## VM Artifacts

The helper now supports a real `prepare` step. It creates:

- `desktop/.local/vm/config.json`
- `desktop/.local/vm/state.json`
- `desktop/.local/vm/disk.raw` as the guest root disk
- `desktop/.local/vm/shared/` for future host↔guest file sharing
- `desktop/.local/vm/artifacts/` for boot assets and runtime state

In development, `desktop/.local/vm/disk.raw` must already be a baked appliance image. If it is missing, `bun run desktop:dev` now fails fast and tells you to run `bun run desktop:appliance:bake`.

The desktop app now treats the Linux VM as an internal dependency. On launch it automatically tries to bring the runtime up, and the first message send will also ensure the VM/guest runtime is ready if startup has not completed yet. The UI only surfaces runtime state when startup is still in progress or when there is an actual error.

The backend now talks to the helper daemon for `status`, `prepare`, `start`, and `stop` instead of spawning a one-shot helper process for each of those operations.

## Shipping Model

The desktop VM no longer needs the whole repo mounted into the guest to boot the Claude runtime, and the Electron shell no longer has to assume a source checkout at runtime.

- The guest control plane is copied into a VM-local app directory during bootstrap.
- The Linux guest only mounts the narrow shared directory at `/mnt/camelai-shared`.
- `bun run desktop:stage` now builds a staged app payload under `desktop/app-resources/`:
  - `renderer/` static renderer bundle
  - `backend/index.mjs` bundled desktop service module for direct Electron import
  - `bin/camelai-desktop-backend` compiled Bun backend executable
  - `bin/camelai-vm-helper` compiled Swift VM helper
  - `guest/` copied guest runtime bundle with its guest-local `node_modules`
  - `vm-appliance/disk.raw` packaged Ubuntu appliance disk cloned into the staged app resources
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

The remaining product/runtime steps after packaging are tightening the helper/desktop-service boundary even further, moving more guest bootstrap logic behind the helper, and adding explicit workspace import/sync so the guest only sees the project the user opened instead of the development source tree.
