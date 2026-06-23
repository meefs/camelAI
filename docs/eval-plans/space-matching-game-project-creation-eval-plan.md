# Space Matching Game Project Creation Eval Plan

## Goal

Update the `space-matching-game-live` eval so it measures the agent's ability to start from a clean workspace with zero projects, create the needed project itself, scaffold a Cloudflare Worker app using the documented software stack, deploy it, and leave behind enough runtime and source evidence for reliable scoring.

This plan is scoped to the committed eval in `chiridion-app`. It should not change the behavior of existing evals unless explicitly called out later.

## Current State

The current `space-matching-game-live` eval pre-creates a project named `space-matching-game` before sending the agent prompt. That makes source inspection easy because the eval already knows the project id, but it weakens the signal: the eval no longer detects whether the agent can create a project from an empty workspace.

The local eval runner is acceptable for this goal:

- It creates a fresh `chiridion-app` checkout per run.
- It copies `.dev.vars` into that checkout.
- It runs the eval through Docker/Miniflare.
- It keeps run artifacts, workdirs, and deployed testing-grounds apps around for debugging.

Those retained host artifacts are fine. The key requirement is that the agent's eval workspace starts with zero project records.

## Scope Answers

This change is at the `space-matching-game-live` eval level only. It should not change `deploy-fake-data-live`, `dashboard-fake-data-live`, `sandbox-write-file-live`, or `custom-prompt-live`.

The required implementation should be in `chiridion-app`, primarily `workers/main/tests/evals/space-matching-game-live.test.ts`. The eval-runner repo should not need code changes because it already clones the selected ref, runs the committed eval, and captures emitted JSON artifacts. The runner dashboard may later choose to display `sourceInspection` or `runtimeAssertions` more richly, but that is optional UI work, not required for eval correctness.

## Revised Eval Shape

1. Create the eval user, org, default workspace, and thread as before.
2. Get the workspace filesystem Durable Object for `defaultWorkspaceId`.
3. Call `workspaceFs.listProjectsForMigrationReset()` before the agent turn.
4. Assert the initial project list is empty.
5. Do not call `workspaceFs.createProject(...)`.
6. Send the plain prompt:

   ```text
   Create a web app that is a space themed matching game with a leaderboard where users can enter their credentials for their high score.
   ```

7. Keep the eval-runtime credential hint if needed:

   ```text
   This eval runtime injects CLOUDFLARE_API_BASE_URL and CLOUDFLARE_API_TOKEN, so do not ask for login or real Cloudflare credentials.
   ```

8. After the agent run, call `workspaceFs.listProjectsForMigrationReset()` again.
9. Assert at least one project was created.
10. Identify the new project by diffing project ids from the before/after lists.
11. Use the new project's authoritative `id` for project runtime filesystem inspection through `/v1/projects/:id/fs/read` and `/v1/projects/:id/fs/list`.
12. Continue to assert live deploy registration and reachability through `result.deployedApps`.

## Added Eval Criteria

Add a hard "created project" assertion:

- Fail if the workspace starts with any projects. That means the harness is not exercising a clean project workspace.
- Fail if no new project exists after the agent run.
- Emit the initial and final project lists into the artifact.
- Emit the selected project id/name used for source inspection.

The assertion should distinguish harness cleanliness failures from agent failures:

- Initial projects not empty: harness/environment failure.
- Initial projects empty and final projects empty: agent failed to create a project.
- Multiple final projects: acceptable if at least one new project can be selected, but emit all project metadata so the behavior is visible.

## Existing Criteria To Keep

Runtime behavior:

- The agent read `developing-software/SKILL.md`.
- The agent used `create-worker`.
- The agent ran `bun run deploy`.
- The agent called `list_apps`.
- The agent called `set_preview`.
- The agent did not use unsupported scaffold commands such as `wrangler init` or `npm create cloudflare`.

Source-level behavior:

- Generated project includes `package.json`.
- `package.json` includes a deploy script that uses Wrangler deploy with the dispatch namespace.
- Generated project includes `components.json` with shadcn/ui configuration.
- Generated project includes `wrangler.jsonc` using the expected Worker entrypoint and assets binding.
- Generated source includes React Router scaffold markers.
- Source shows matching-game mechanics.
- Source shows leaderboard/high-score behavior.
- Source shows a credential or player entry flow tied to high scores.
- Source shows a clear space theme.
- Source shows leaderboard persistence intent through Durable Objects and SQLite.

Deploy behavior:

- Workspace app count increases by one.
- `result.deployedApps` contains a testing-grounds URL.
- The deployed app returns a non-empty HTTP 200.

## Implementation Notes

Use `listProjectsForMigrationReset()` instead of `listProjects()` for project discovery after the agent turn if the eval wants a flat project list. `listProjects()` nests clones under source projects, which is useful for display but less direct for diffing.

Project source inspection should use the newly created project's `id`, not its name. The name is still useful in artifact output and for debugging, but the project runtime service is addressed by project id.

The source inspection helper should no longer assume `PROJECT_NAME` is the project or app directory. It should:

- Read the new project's `/workspace`.
- Find the generated app directory by scoring candidates with `package.json`, `components.json`, `wrangler.jsonc`, and expected package/deploy markers.
- Prefer but not require a directory or package name that resembles the prompt.

## Validation Plan

Run the focused worker test file first. Without real-deploy credentials, the test should compile/import and skip:

```bash
bunx vitest run --config vitest.workers.config.ts --reporter verbose workers/main/tests/evals/space-matching-game-live.test.ts
```

Verify the eval remains discoverable:

```bash
node scripts/run-agent-eval.mjs --help
```

When real-deploy credentials are available, run:

```bash
bun run test:eval space-matching-game-live
```

If running through Illiana's local eval runner, select a committed/pushed branch that contains the eval changes. Local uncommitted `chiridion-app` changes are not visible to that runner because it clones refs from GitHub.

## Non-Goals

- Do not make all evals require agent-created projects.
- Do not delete deployed testing-grounds apps after the run.
- Do not change eval-runner cleanup behavior.
- Do not add browser/gameplay evaluation in this pass.
