# Resend Native Connection Plan

Audience: coding agent implementing the Resend connection in camelAI.

## Summary

Add Resend as a first-class workspace connection with integration type `resend`.
Users should be able to add a Resend API key once, then call it from chat, code
mode, deterministic workflows, project VMs, and published apps through the
existing `CONNECTIONS` binding. Do not expose the raw API key to app code,
workspace files, chat logs, or project containers.

This is a standard native connection addition if the goal is a more stable
Resend-specific version of the existing raw "Other" API connection. The core
V1 surface should be a provider-owned authenticated `fetch` method: camelAI
stores the API key, owns the Resend base URL/auth headers/User-Agent behavior,
and app code calls Resend endpoints without knowing the credential.

Do not productize every Resend feature in camelAI for V1. Batch send,
attachments, broadcasts, contacts, domains, and future Resend APIs can all be
used by app/workflow code through the native authenticated fetch surface when a
user needs them.

Resend is a normal connection, not a channel. Keep it under Connections, not
Channels. The native camelAI workspace Email channel is separate and handles
inbound workspace email; a Resend connection is for using a customer's Resend
account from apps and workflows.

## References

- Existing custom Resend note from the user:
  `/Users/illiana/Downloads/resend.md`
- Logo source:
  `/Users/illiana/Downloads/Resend/Resend_Symbol_0.svg`
- Resend API docs:
  - Base URL and auth: https://resend.com/docs/api-reference/introduction
  - Send email: https://resend.com/docs/api-reference/emails/send-email
  - Retrieve sent email: https://resend.com/docs/api-reference/emails/retrieve-email
  - List domains: https://resend.com/docs/api-reference/domains/list-domains
  - Errors: https://resend.com/docs/api-reference/errors

Important Resend API details verified from the docs:

- Base URL is `https://api.resend.com`.
- Auth is `Authorization: Bearer re_xxxxxxxxx`.
- Direct HTTP requests must include a `User-Agent` header or Resend can reject
  the request with `403`.
- `POST /emails` requires `from`, `to`, and `subject`; it accepts `html`, `text`,
  or `template`.
- API keys can have `sending_access` or `full_access`. A sending-only key is
  enough for `POST /emails`, but read/admin endpoints such as listing domains
  can fail with `restricted_api_key`.

## Current Codebase Shape

Read these before coding:

| Purpose | File |
|---|---|
| Integration definitions and form schemas | `src/lib/integration-registry.ts` |
| Logo registration | `src/lib/integration-logo-registry.ts` |
| Connection icon loader | `src/lib/integration-icons.tsx` |
| Connection list/detail helpers | `src/lib/connections-shared.ts` |
| Connections page loader/action | `src/routes/_app.connections.tsx` |
| Runtime method facade and fetch dispatch | `workers/main/src/connections-runtime.ts` |
| Stateless sandbox/project RPC endpoint | `workers/main/src/routes/integrations-mcp.ts` |
| Published app service binding | `workers/main/src/connections-service.ts` |
| Starter app method facade | `sandbox/create-worker/templates/starter/app/lib/connections.ts` |
| Runtime tests | `workers/main/tests/connections-runtime.test.ts` |
| RPC route tests | `workers/main/tests/connections-rpc-route.test.ts` |

Do not add a new Cloudflare binding. Deployed apps already get the virtual
`CONNECTIONS` service binding, project VMs use the existing RPC route, and
code mode already exposes `env.CONNECTIONS`.

Also note: adding `resend` only to `INTEGRATION_REGISTRY` is not enough. The
generic `fetch` method is currently exposed only for integration type `other`.
A native `resend` connection needs an intentional native HTTP provider fetch
helper so `connections.<alias>.fetch(...)` works for Resend while camelAI owns
the base URL and auth behavior.

## Product Scope

### V1

- Add Resend to the Add Connection picker.
- Store the Resend API key as encrypted integration credentials.
- Show the official Resend symbol with light/dark variants.
- Expose a native authenticated API method:
  - `connections.<alias>.fetch(input, init)`
- Resolve relative paths against `https://api.resend.com`.
- Inject Resend auth and User-Agent headers server-side.
- Restrict native Resend fetches to the Resend API origin.
- Preserve all existing app/runtime paths:
  - chat code mode
  - deterministic workflows
  - project VM RPC
  - published Cloudflare Workers apps

### Not Required For A Good V1

These are not connector requirements:

- Batch send (`POST /emails/batch`)
- Attachments
- Broadcasts, audiences, contacts, topics, automations, webhooks
- Resend inbound receiving APIs
- UI for choosing or verifying a default sending domain
- Platform-level delivery logs beyond existing app logs

Those are Resend product surfaces that app code can use through
`connections.<alias>.fetch(...)` if the user asks for them. They only become
camelAI connector work if product wants curated helper methods or UI around
them later.

## Implementation Steps

### 1. Add the connection definition

Update `src/lib/integration-registry.ts`.

Add a `resend` entry near `sendgrid`:

```ts
resend: {
  type: 'resend',
  displayName: 'Resend',
  description: 'Send transactional emails with Resend',
  category: 'communication',
  authMethod: 'api_key',
  configSchema: [],
  credentialSchema: [
    {
      name: 'api_key',
      label: 'API Key',
      type: 'password',
      required: true,
      placeholder: 're_...',
      description:
        'Create in Resend API Keys. Sending Access is enough for sending email; Full Access may be required when app code calls read/admin endpoints.',
    },
  ],
},
```

Do not hard-block API keys that do not start with `re_`; use the placeholder
and description as guidance. API key formats can change.

No database migration is needed. Workspace integrations already store generic
`integration_type`, `config`, and encrypted credentials.

### 2. Add light/dark logo support

Create two files:

- `public/logos/resend_light.svg`
- `public/logos/resend_dark.svg`

Use the user-supplied source SVG for the light variant. It has a black fill,
which is correct on light backgrounds.

For the dark variant, keep the same SVG geometry but change the path fill to
white. Register it in `src/lib/integration-logo-registry.ts`:

```ts
resend: 'themed',
```

Expected behavior: `IntegrationIcon` uses `resend_light.svg` in light mode and
`resend_dark.svg` in dark mode.

### 3. Add native HTTP provider fetch support

Update `workers/main/src/connections-runtime.ts`.

The existing custom API implementation has the pieces Resend needs:

- `OTHER_CONNECTION_FETCH_METHOD`
- `normalizeOtherFetchInput`
- `otherFetchMethod`
- `otherFetchHeaders`
- `boundedResponseText`
- `responseHeadersObject`

Refactor the "Other" fetch path into a small provider-aware fetch helper
instead of copying the whole implementation.

Suggested shape:

```ts
const NATIVE_HTTP_API_CONNECTIONS: Record<string, {
  baseUrl: string;
  credentialKeys: string[];
  authHeader: 'bearer';
  defaultHeaders?: Record<string, string>;
}> = {
  resend: {
    baseUrl: 'https://api.resend.com',
    credentialKeys: ['api_key'],
    authHeader: 'bearer',
    defaultHeaders: {
      accept: 'application/json',
      'user-agent': 'camelai-resend-connection/1.0',
    },
  },
};
```

Then replace `otherConnectionMethods(connection)` with a more general helper:

```ts
function authenticatedFetchMethods(connection: ConnectionSummary): ConnectionMethodSummary[] {
  if (
    connection.type !== 'other' &&
    !NATIVE_HTTP_API_CONNECTIONS[connection.type]
  ) {
    return [];
  }
  return [OTHER_CONNECTION_FETCH_METHOD];
}
```

Use that helper where `listConnectionMethods()` currently combines
`virtualChannelMethods(connection)` and `otherConnectionMethods(connection)`.

Update `invokeConnectionMethod()` so any connection whose method tool is
`authenticated_fetch` routes to a generalized function:

```ts
if (targetMethod.tool === OTHER_CONNECTION_FETCH_TOOL) {
  return callAuthenticatedConnectionFetch(
    env,
    context,
    target.connection.id,
    request.input,
  );
}
```

The generalized function should:

- Keep existing `other` behavior for custom API connections.
- Add `resend` behavior from `NATIVE_HTTP_API_CONNECTIONS`.
- Decrypt `credentials.api_key` server-side.
- Resolve relative paths against `https://api.resend.com`.
- Reject absolute URLs whose origin is not `https://api.resend.com`.
- Ignore caller-supplied `authorization`, `proxy-authorization`, `host`, and
  `content-length` headers, as the current custom fetch path already does.
- Set `Authorization: Bearer <api key>` server-side.
- Set `User-Agent: camelai-resend-connection/1.0` server-side unless a future
  product decision explicitly allows overriding it.
- Preserve Response-like return payloads so the starter `createConnections()`
  facade still turns `fetch` results into a `Response`.

Do not add Resend to `src/lib/provider-mcp-registry.ts` for this V1. A provider
MCP entry implies curated MCP tools, but the goal here is a stable native
authenticated API client.

### 4. Example usage

Published apps, code mode, and deterministic workflows should use the same
method-style facade they use for custom API connections:

```ts
const resend = await env.CONNECTIONS.find({ type: 'resend' });
const connections = createConnections(env);

const response = await connections[resend.alias].fetch('/emails', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    from: 'Acme <onboarding@example.com>',
    to: ['customer@example.com'],
    subject: 'Welcome',
    html: '<p>Thanks for signing up.</p>',
  }),
});

if (!response.ok) {
  throw new Error(await response.text());
}
```

The same native fetch method can call other Resend endpoints without new
camelAI connector work:

```ts
await connections[resend.alias].fetch('/emails/batch', { method: 'POST', ... });
await connections[resend.alias].fetch('/domains', { method: 'GET' });
await connections[resend.alias].fetch('/contacts', { method: 'POST', ... });
```

The app/agent owns the endpoint-specific body shape. camelAI owns only the
connection, base URL, allowed origin, and auth injection.

### 5. Optional future helper methods

Do not implement these for V1 unless product explicitly asks for a more curated
API:

- `sendEmail`
- `batchSendEmails`
- `listDomains`
- `createContact`
- `createBroadcast`

These helper methods could be layered on top of the native Resend fetch later.
They are not needed for users to access the underlying Resend feature set.

### 6. Stateless RPC endpoint

No separate hosted-broker branch should be needed in
`workers/main/src/routes/integrations-mcp.ts` if the RPC endpoint already routes
`invoke` through `invokeConnectionMethod()` from `connections-runtime.ts`.

Verify this with a route-level test. If that route has a parallel hard-coded
method path for `authenticated_fetch`, update it to use the same generalized
native HTTP provider helper instead of creating a Resend-specific branch.

### 7. Optional welcome-screen surfacing

The Add Connection dialog will pick Resend up automatically from
`INTEGRATION_REGISTRY`.

Only update `src/components/welcome-screen/integration-buttons.tsx` if product
wants Resend featured in onboarding. This is optional and should not block the
native connection.

### 8. Agent setup prompts and docs

No custom connection handoff is needed. Once `resend` is in the registry,
agent tools that call `list_integration_types` should see it.

If updating any user-facing setup copy, keep it short:

- "Create a Resend API key in the Resend dashboard."
- "Sending Access is enough for sending emails."
- "Use a verified sending domain for production delivery."

Do not tell users to paste the key into app code.

## Tests

Add or update focused tests.

### Runtime tests

File: `workers/main/tests/connections-runtime.test.ts`

Add tests for native Resend fetch:

- Create a fake `resend` integration with encrypted `{ api_key: 're_test' }`.
- Assert `listConnectionMethods(...)` includes a Resend entry with method name
  `fetch` and tool `authenticated_fetch`.
- Stub `fetch`.
- Call:

```ts
await invokeConnectionMethod(envWith(records), context, {
  connection: 'resend_txn',
  method: 'fetch',
  input: {
    input: '/emails',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: 'Acme <onboarding@example.com>',
        to: ['customer@example.com'],
        subject: 'Welcome',
        html: '<p>Hello</p>',
      }),
    },
  },
});
```

Assert:

- URL is `https://api.resend.com/emails`.
- Method is `POST`.
- Headers include:
  - `authorization: Bearer re_test`
  - `user-agent: camelai-resend-connection/1.0`
  - `content-type: application/json`
- Body includes only the expected fields.
- Result is the existing Response-like fetch payload.

Add validation/error tests:

- Missing API key returns a setup/auth style error through the existing runtime
  auth status flow.
- Absolute URL to `https://api.resend.com/...` is allowed.
- Absolute URL to any other origin is rejected.
- Caller-supplied `authorization` is ignored/replaced.
- Resend `403` response is returned as a Response-like payload, not converted
  into an internal camelAI exception.

### Method facade tests

In `workers/main/tests/connections-runtime.test.ts`, add a method catalog check:

- `listConnectionMethods(...)` for a Resend record exposes method name `fetch`
  with tool `authenticated_fetch`.
- `invokeConnectionMethod(...)` can call `fetch`.

### RPC route tests

File: `workers/main/tests/connections-rpc-route.test.ts`

Add a small route-level check that a Resend connection can be discovered and
invoked through the stateless RPC route, or extend the existing route method
listing test to assert the Resend `fetch` method appears.

### UI/type tests

At minimum run:

```bash
bun run typecheck
bun run test:workers -- workers/main/tests/connections-runtime.test.ts
bun run test:workers -- workers/main/tests/connections-rpc-route.test.ts
```

If the implementation touches visible connections UI, also run the nearest
Vitest/UI test suite if one exists for connections, plus a quick browser smoke
test of `/connections`.

## Acceptance Criteria

- Resend appears in the Add Connection picker with the Resend logo.
- The logo is black in light mode and white in dark mode.
- Creating a Resend connection stores only encrypted credentials and no raw API
  key in config.
- A saved Resend connection is @-mentionable like other normal connections.
- `env.CONNECTIONS.methods()` includes a Resend entry with `fetch`.
- Published app code can call `connections.<alias>.fetch('/emails', ...)`.
- Project VM/RPC callers can discover and invoke the same `fetch` method.
- The native fetch path sets Resend auth and User-Agent headers server-side.
- Provider errors are surfaced clearly without logging message contents or
  credentials.
- Sending-only API keys work for `POST /emails`.
- App code can call other Resend endpoints such as batch send, domains,
  contacts, or broadcasts through the same authenticated fetch without new
  camelAI connector work.

## Open Questions

1. Should Resend be featured on the welcome screen, or only appear in the full
   connection picker? This is a product placement decision, not required for
   the native connection.
2. Should camelAI add curated helper methods later for common tasks such as
   `sendEmail`? This is optional because native fetch already supports the
   complete Resend API surface.
