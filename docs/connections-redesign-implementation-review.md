# Connections Redesign Implementation Review

Reviewed the current working-tree diff after the latest implementation pass. The previous admin-enforcement concern has been addressed: `/connections` mutations now check org-admin status, and OAuth connection/reconnect flows use a shared workspace/manage-connections access helper.

## Findings

### P2 - Optional creator/profile enrichment can blank the whole connection list

The loader fetches integration records and creator profiles inside one promise chain (`src/routes/_app.connections.tsx:448-464`). If `getUsersByIds` fails, the catch returns `[]`, so a noncritical profile lookup failure makes the UI render as if there are no saved connections. This is a larger failure mode than the optional metadata deserves.

Recommendation: load integration records first, then wrap creator-profile enrichment separately. On profile lookup failure, keep the connection records and render creator names as unknown/null while logging the profile error.

## Missing Automated Tests To Add

### Component and route UI tests

- Render the Connections page with zero integrations and assert native Email still appears under Channels, with the empty "No saved connections yet" prompt below it.
- Render Slack, Telegram, Gmail, SendGrid, and Postgres records and assert only Email/Slack/Telegram are in Channels while Gmail/SendGrid/Postgres are in Connections.
- Assert opening a row sets `?selected=...`, renders the detail panel, and closing clears the URL param.
- Assert the grid remains responsive when the panel is open, including wide desktop coverage where two columns should remain available if there is enough room.
- Assert non-admin users do not see Add/Rename/Configure/Reconnect/Clone/Delete controls, while admin users do.
- Assert nested row controls are keyboard-safe: pressing Enter/Space on "Open in chat" or the overflow trigger does not also select the row.
- Assert inline rename submits exactly once across Enter + blur, updates optimistically, revalidates on success, and rolls back on server error.
- Assert delete clears the selected panel and rolls back the list if the server returns an error.
- Assert "Open in chat" writes the `@slug ` draft and navigates to `/chat`.
- Assert OAuth `success`, `error`, and `reason` URL params produce the expected toast and are removed without dropping `selected` when both are present.

### Loader/action tests

- Add admin-success coverage for `createIntegration`, `updateIntegration`, `deleteIntegration`, and `duplicateIntegration`; the current action test only covers the non-admin denial path.
- Test that unknown/unsupported intents do not invoke the admin guard unnecessarily and return `Unknown action`.
- Test duplicate-to-workspace rejects target workspaces outside the current org.
- Test loader behavior for Slack metadata from config and server-side credential fallback, and assert encrypted credentials are never returned to the client.
- Test loader behavior when `getUsersByIds` fails: connections should still render with missing creator display names.
- Test native email loader data for configured domain, missing domain, plan-enabled, and plan-disabled states.
- Test Telegram create flow writes a setup token record and returns the deep link without exposing credentials.
- Test remote MCP OAuth creation returns the follow-up OAuth URL and validates/normalizes server URLs.

### Worker OAuth tests

- Extend `verifyWorkspaceManageConnectionsAccess` tests for archived workspace, missing org membership, and `access_level: "none"` paths.
- For Slack/Notion/Salesforce/remote MCP OAuth start handlers, assert non-admin users redirect with `admin_required` before OAuth state is created.
- For OAuth callbacks, assert a user demoted after state creation is denied before any integration is created or updated.
- For Slack callback, assert non-secret team metadata is mirrored into integration config and SlackTeamRegistry receives `access.orgId`.
- For reauth callbacks, assert an `integration_id` of the wrong type is rejected and does not create a replacement integration.

### E2E/smoke tests

- Add a Playwright smoke test for the Connections page covering search, sort, select/open panel, inline rename, and delete confirmation against a seeded workspace.
- Add responsive smoke coverage for desktop panel-open layout, including the intentional two-column wide layout, and mobile Sheet behavior.

## Verification Run

- `bun run test:run -- tests/connections-shared.test.ts tests/connections-action.test.ts` passed.
- `bun run test:workers -- workers/main/tests/integrations-oauth-access.test.ts` passed.
- `bun run typecheck` passed.
- `bun run lint` passed.
