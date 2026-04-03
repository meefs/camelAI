# Desktop Local App

This document tracks the local-first macOS desktop project that lives beside the Cloudflare web app.

## Goal

Build a separate Electron application that keeps the chat UX direction of camelAI while replacing the web platform runtime with:

- no login
- no Cloudflare auth/storage/runtime dependencies
- local persistence
- a macOS-only sandbox path using Apple Virtualization Framework

## Current Scaffold

- `desktop/backend/service.ts` now holds the reusable desktop app service boundary for local persistence, VM orchestration, and guest bridging; it auto-starts the VM on app boot and treats VM lifecycle as an internal runtime concern rather than a user-managed step
- `desktop/backend/server.ts` is now a transport wrapper for HTTP/WebSocket or stdio, rather than the core desktop logic
- `desktop/backend/vm.ts` now talks to a persistent Swift helper daemon for VM `status`/`prepare`/`start`/`stop`, pre-stages the guest bundle/auth/env into the shared directory before boot, and waits on the guest control-plane health check through the helper's local proxy
- `desktop/guest` runs the Claude Agent SDK inside the Linux VM, preserving the same basic runtime split as the web app
- `desktop/renderer` is a Vite React UI using the repo's existing Tailwind/shadcn primitives and now talks to Electron over preload IPC in the normal app path
- `desktop/electron` loads the renderer and, in staged/packageable builds, now imports a bundled desktop service module directly from app resources
- `desktop/vm-helper` now supports a real `prepare` step and a real `start`/`stop` path by owning a direct Apple Virtualization Framework VM
- the Linux guest now boots Ubuntu directly under AVF, mounts the narrow host share with virtiofs, starts a Dockerized guest control plane, and exposes that control plane back to the host through a local vsock-backed proxy instead of a user-visible VM workflow

## Immediate Next Steps

1. Move more guest bootstrap orchestration behind the helper daemon so Node becomes a thinner desktop-service client.
2. Move local development onto the same direct in-process desktop-service path that staged builds already use.
3. Replace JSON persistence with SQLite once the runtime contract settles.
4. Add explicit workspace import/sync so the VM only sees user-opened projects.
5. Add signing/notarization once the runtime model stabilizes.
