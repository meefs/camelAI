# Desktop App Architecture

## Goal

Ship a macOS desktop app that:

- does not depend on a source checkout at runtime
- does not expose a localhost backend as the renderer transport
- keeps the Claude Agent SDK inside the guest runtime
- uses a narrow, explicit host↔guest file boundary
- is packageable as a signed Electron app

## Target Architecture

```
Electron Renderer
  -> Electron IPC
Electron Main
  -> local desktop app service
  -> Swift VM helper
  -> persistent guest RPC channel
Linux Guest
  -> long-lived guest daemon
  -> Docker
  -> containerized guest daemon
  -> Claude Agent SDK
```

## Principles

- Renderer is UI only.
- Electron main owns orchestration, persistence, and transport.
- Guest runtime is long-lived and warm.
- VM bootstrap is not on the per-message hot path.
- App code ships as immutable resources.
- User data lives under Electron `userData`.

## Runtime Layers

### Renderer

- Chat UI
- Subscribes to desktop events over preload IPC
- Sends commands over preload IPC
- No direct `fetch` or WebSocket dependency on a localhost backend

### Electron Main

- Starts the local desktop service
- Loads the staged desktop service bundle directly in packaged builds
- Falls back to a backend child process in local development
- Bridges service events to renderer windows
- Stores mutable state under `~/Library/Application Support/<app>`

### Desktop Service

- Thread/message persistence
- VM runtime orchestration
- Guest control-plane bridge
- Structured transcript persistence

Current implementation note:

- Packaged and staged builds now load a bundled `DesktopService` module directly from app resources.
- Local development still falls back to the compiled/backend child path, which speaks line-delimited JSON over stdio to Electron main instead of exposing a localhost server in the normal desktop path.

### VM Helper

- Owns VM lifecycle
- Now exposes a persistent stdio JSON-RPC daemon for lifecycle/status commands
- Today: direct Apple Virtualization Framework ownership
- Ubuntu appliance bootstrap installs Docker, mounts the narrow virtiofs share, and starts the guest control plane inside a Docker container
- Exposes the guest control-plane port back to the host through a local vsock-backed proxy
- Next: absorb even more guest bootstrap/control-plane logic so the host only sees helper RPCs

### Guest Daemon

- Long-lived process inside the VM, now intended to run inside Docker
- Owns Claude Agent SDK session lifecycle
- One warm connection per thread from the host bridge

## Current Refactor Status

Implemented:

- staged desktop resources for packaging
- staged desktop service module + compiled backend binary + VM helper + renderer bundle + guest bundle
- Electron-managed backend process
- direct in-process desktop service loading in the staged/packageable path
- persistent Swift VM-helper daemon boundary for lifecycle/status commands
- warm per-thread host↔guest connection
- cached guest bundle/auth sync
- structured transcript persistence
- renderer transport migrated off localhost to preload IPC in the desktop path

Still to do:

- move more guest bootstrap and guest control-plane startup behind the helper boundary
- remove the separate backend executable and move orchestration fully into Electron main
- explicit workspace import/sync model
- packaged app signing/notarization

## Packaging Model

Immutable resources:

- `Contents/Resources/desktop/renderer`
- `Contents/Resources/desktop/backend/index.mjs`
- `Contents/Resources/desktop/bin/camelai-desktop-backend`
- `Contents/Resources/desktop/bin/camelai-vm-helper`
- `Contents/Resources/desktop/guest`

Mutable state:

- Electron `userData` directory
- SQLite / persisted transcript store
- VM state and guest cache

## Hot Path Requirements

Per message send should not:

- re-copy the guest bundle
- re-run `bun install`
- re-sync Claude auth unless changed
- re-open a host↔guest control-plane connection for the same thread

## Next Major Step

Move more guest bootstrap orchestration out of [desktop/backend/vm.ts](/Users/miguelsalinas/.codex/worktrees/719e/chiridion-2/desktop/backend/vm.ts) and behind the helper daemon so Node becomes a thinner client of the AVF runtime boundary.
