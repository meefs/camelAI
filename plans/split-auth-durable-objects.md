# Split `workers/main/src/auth.ts` Plan

## Context

`workers/main/src/auth.ts` is currently a large mixed-purpose module (~6k+ lines). Despite the name, it is not only authentication code. It contains the central user/org/account Durable Objects and many adjacent domains:

- `UserDO`
- `OrgDO`
- auth/session-adjacent user state
- profile, password, email verification, onboarding
- user org memberships
- chat tab/group UI state
- org info/settings/model picker config
- members and invitations
- integrations
- worker scripts and custom domains
- workspace metadata
- threads
- BYOK/model provider config
- usage and limits
- admin index dispatch helpers

The goal is to make the code easier to navigate while preserving Durable Object bindings and behavior.

## Guiding Principles

- Keep external Durable Object binding names stable: `USER`, `ORG`, `WORKSPACE`, `CHAT_THREAD`.
- Prefer mechanical moves first; avoid behavior changes during file splitting.
- Keep `workers/main/src/auth.ts` as a compatibility barrel until all imports are migrated intentionally.
- Run focused Worker tests after each stage.
- Avoid renaming exported Durable Object classes unless there is a separate migration plan.
- Do not mix schema/data migrations with file organization changes unless unavoidable.

## Stage 1: Low-Risk Mechanical Split

Status: complete.

Implemented files:

```txt
workers/main/src/identity/
  env.ts
  index.ts
  user-do.ts
  org-do.ts
```

`workers/main/src/auth.ts` is now a compatibility barrel that re-exports `./identity/index.js`.

Validation completed:

```bash
bun run typecheck
bun run test:workers -- workers/main/tests/auth-do.test.ts workers/main/tests/user-do-chat-groups.test.ts workers/main/tests/billing-org.test.ts
```

Goal: reduce the misleading size/name of `auth.ts` without changing behavior.

Proposed structure:

```txt
workers/main/src/identity/
  env.ts
  types.ts
  user-do.ts
  org-do.ts
  index.ts
```

Tasks:

1. Move `DOEnv` into `identity/env.ts`.
2. Move shared exported interfaces/types from `auth.ts` into `identity/types.ts` where practical.
3. Move `UserDO` into `identity/user-do.ts`.
4. Move `OrgDO` into `identity/org-do.ts`.
5. Add `identity/index.ts` re-exporting the public API.
6. Replace `workers/main/src/auth.ts` with a compatibility barrel, e.g.:

   ```ts
   export * from "./identity";
   ```

7. Update only imports that must change because of local relative paths after the move.
8. Preserve imports from `./auth` elsewhere unless there is a clear reason to migrate them now.

Validation:

```bash
bun run typecheck
bun run test:workers -- workers/main/tests/auth*.test.ts
```

If focused auth tests do not map cleanly, run the nearest relevant Worker test files touching `UserDO` / `OrgDO`.

## Stage 2: Extract Pure Helpers

Status: complete for the first safe batch.

Extracted files:

```txt
workers/main/src/identity/
  admin-events.ts
  billing-state.ts
  onboarding.ts
  org-slugs.ts
  superuser.ts
  thread-summary.ts
  usage.ts
```

Extracted helpers include admin index event dispatch, superuser email checks, onboarding normalization, org slug helpers, thread summary status normalization, billing field normalization, and usage scalar normalizers.

Validation completed:

```bash
bun run typecheck
bun run test:workers -- workers/main/tests/auth-do.test.ts workers/main/tests/user-do-chat-groups.test.ts workers/main/tests/billing-org.test.ts
bun run test:workers
```

Goal: pull stateless helper logic out of Durable Object class files.

Candidate helper modules:

```txt
workers/main/src/identity/
  admin-events.ts
  org-slugs.ts
  onboarding.ts
  thread-preview.ts
  billing-state.ts
  usage-state.ts
  row-mappers.ts
```

Likely candidates from current `auth.ts`:

- superuser email helper / constants
- org slug hashing/generation/registration helpers
- admin index event dispatch helper
- onboarding preference normalizer
- thread completion status normalizer
- row-to-domain mappers that do not need direct class state
- billing/usage normalization helpers that are pure

Rules:

- Extract helpers only if they are pure or have very small explicit dependencies.
- Keep SQL schema setup/migration close to the owning DO until the ownership boundaries are clearer.
- Add or preserve unit coverage where helper behavior is non-trivial.

Validation:

```bash
bun run typecheck
bun run test:workers
```

## Stage 3: Optional Domain-Oriented Extraction

Status: in progress.

Started with a low-risk domain extraction:

```txt
workers/main/src/identity/org/
  custom-domains.ts
```

The legacy org custom-domain SQL operations now live in `identity/org/custom-domains.ts`; `OrgDO` keeps the same public RPC methods and delegates to the domain helper using a small context object.

Goal: split `OrgDO` / `UserDO` internals by domain after the mechanical split is stable.

Potential domains:

```txt
workers/main/src/identity/user/
  profile.ts
  auth-credentials.ts
  onboarding.ts
  memberships.ts
  chat-groups.ts

workers/main/src/identity/org/
  info.ts
  members.ts
  invitations.ts
  integrations.ts
  worker-scripts.ts
  custom-domains.ts
  workspaces.ts
  threads.ts
  model-provider-config.ts
  usage.ts
```

Approach options:

1. **Mixin/helper functions:** keep `OrgDO` as the class, but delegate domain operations to helper functions that receive a small context object.
2. **Internal service classes:** create small classes wrapping SQL/KV access for each domain.
3. **Keep some domains in the DO file:** if extracting a domain makes transaction ordering or schema ownership less clear, leave it in place.

Recommended order:

1. Extract domains with the fewest dependencies first, such as custom domains or invitations. Custom domains started.
2. Then integrations and worker scripts.
3. Then workspace/thread metadata.
4. Leave billing/usage and membership/ownership flows until later because they are higher risk.

Validation:

Run targeted tests per domain plus typecheck. For broader changes:

```bash
bun run typecheck
bun run test:workers
```

## Open Questions

- Should imports across the repo eventually use `./identity` instead of `./auth`?
- Should `UserDO` and `OrgDO` keep their names permanently, or should names like `UserAccountDO` / `OrganizationDO` be considered later?
- Which tests are the best fast smoke tests for `UserDO` / `OrgDO` behavior?
- Are any external scripts or Wrangler entrypoints relying on `auth.ts` directly?

## Success Criteria

- `auth.ts` is no longer a large implementation file.
- `UserDO` and `OrgDO` are easier to find and navigate.
- Durable Object bindings remain stable.
- Typecheck and relevant Worker tests pass after each stage.
- No auth, org, membership, billing, workspace, or thread behavior changes are introduced unintentionally.
