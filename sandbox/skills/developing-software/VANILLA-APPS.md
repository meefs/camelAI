# Vanilla Apps and Browser Games

Use `vanilla` when plain HTML, CSS, and browser JavaScript are the architecture, not merely the visual style. It is well suited to focused sites, calculators, quizzes, interactive explainers, and small DOM or canvas games.

Use `crud` instead when the product needs accounts, authoritative server state, shared records, a durable leaderboard, or multiplayer coordination. Local-only progress does not require a server; shared or security-sensitive state does.

## Preserve the Scaffold Contract

- Browser files live in `public/`: start with `index.html`, `styles.css`, and `main.js` and split modules only as complexity earns it.
- Keep `worker.js` as the static asset handler and optional endpoint seam.
- Keep `scripts/build.mjs`: it copies `public/` to `build/client`, copies the Worker to `build/server`, and writes `build/server/wrangler.json` for deployment.
- Do not add React, Tailwind, shadcn, or a bundler unless the request truly needs them. If the architecture grows into a stateful product, starting again from `crud` is usually cleaner.

## Interaction Structure

- Give each important state one owner in JavaScript and derive the DOM from it. Avoid scattering state across element text, classes, and unrelated globals.
- Prefer event delegation for repeated controls and named functions for input, update, and render phases.
- Keep controls usable with keyboard and touch. Use semantic buttons, visible focus states, status announcements, and a pause/reset path where appropriate.
- Respect `prefers-reduced-motion`. Start audio only after user interaction and provide a mute control.

## Game Loops

For turn-based or event-driven games, update state and render only after input. Do not introduce a continuous loop unnecessarily.

For animation or real-time play:

```js
let previous = performance.now();

function frame(now) {
  const deltaSeconds = Math.min((now - previous) / 1000, 0.05);
  previous = now;
  update(deltaSeconds);
  render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
```

Cap the delta so a backgrounded tab cannot produce a giant physics step. Pause when the page is hidden if background progress is not part of the design.

For canvas:

- Keep world coordinates independent from CSS pixels.
- Size the backing buffer for `devicePixelRatio`, then scale the drawing context.
- Convert pointer coordinates from the canvas bounding rectangle into world coordinates.
- Recompute dimensions on resize without discarding game state.

## Persistence

Use `localStorage` only for non-sensitive, single-browser preferences or progress. Parse defensively, version the stored shape, and make reset possible. Never treat local storage as authoritative for scores, entitlements, identity, or shared data.

Use a Durable Object when state must be shared, durable on the server, transactionally updated, or protected from client tampering. That is normally a signal to use the `crud` scaffold.

## Verification

A successful deploy is sufficient for routine build-and-ship requests. Do not automatically launch `env.BROWSER` or capture screenshots after deployment. If the user requests browser/E2E verification, the task is specifically debugging deployed behavior, or browser evidence is explicitly required, test only the relevant interactions and inspect `logs.pageErrors`. For a requested game verification pass, relevant checks can include keyboard operation, pause/resume, reset, win/loss boundaries, persistence, layout sizing, and rapid or simultaneous inputs.
