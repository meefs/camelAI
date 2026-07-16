# Admin JavaScript Console

`admin_js_exec` is the generic remote console for a deployed camelAI Worker.
It runs JavaScript in an ephemeral Worker and bridges calls back into the
selected staging or production environment. Access requires Admin MCP OAuth and
a camelAI superuser.

Use the console for investigation, break-glass repair, smoke tests, and reusable
integration checks. The code has the same authority in staging and production;
the MCP server you call selects the environment.

## Runtime globals

| Global | Purpose |
| --- | --- |
| `runtime` | Base URL, admin user id, Stripe mode, and binding descriptors. |
| `input` | Read-only JSON parameters supplied separately from the code body. |
| `env` | Proxy over method-bearing Worker bindings, for example `env.APP_KV.get(key)`. |
| `ENV` | Explicit binding discovery and invocation helpers. |
| `DO` | Durable Object namespace, stub, and RPC helpers. |
| `SELF.fetch()` | Fetch the current Worker without adding user or admin authentication. |
| `ADMIN.fetch()` | Fetch an `/api/admin/*` endpoint as the authenticated MCP admin. |
| `ACTOR.fetch()` | Fetch the current Worker with an ephemeral signed session for a validated user/org membership. |
| `IDENTITY` | Provision, reset, and hard-delete password-login E2E actors through production identity helpers. |
| `BILLING` | Read sanitized billing state, set exact available credits, and remove Stripe test customers. |
| `fetch()` | Make an outbound HTTP request from the deployed Worker environment. |
| `assert` | Assertions: `ok`, `equal`, `notEqual`, `deepEqual`, `match`, and `rejects`. |
| `test()` | Run and report a named async integration test without stopping later tests. |
| `sleep()` | Await a delay in milliseconds. |
| `text()` | Append diagnostic output to the tool result. `console.*` is also captured. |

Primitive Worker variables and secrets are not readable. `ENV.list()` includes
their names with `accessible: false`, which is enough to diagnose whether a
binding exists without returning credentials. `CODE_MODE_LOADER` is also
blocked; the console already owns the one ephemeral code runner it needs.

## Binding access

Discover bindings and their callable methods:

```js
return ENV.list();
```

Call normal binding methods directly:

```js
const value = await env.APP_KV.get("some-key");
await env.APP_KV.put("some-key", "new-value");
return value;
```

APIs such as D1 and R2 return intermediate objects. Keep those objects inside
the deployed Worker by using `chain`:

```js
return await env.APP_DB.chain([
  { method: "prepare", args: ["SELECT id, email FROM users LIMIT ?"] },
  { method: "bind", args: [10] },
  { method: "all" },
]);
```

The explicit forms are equivalent:

```js
await ENV.call("APP_KV", "put", ["key", "value"]);
const response = await ENV.fetch("DISPATCHER", "https://app.example/path");
```

Use `DO` when addressing Durable Objects because it preserves `idFromName` and
`idFromString` semantics:

```js
const org = await DO.call("ORG", "org_id", "getInfo");
const workspace = DO.stub("WORKSPACE", "workspace_id");
return { org, workspace: await workspace.getInfo() };
```

## HTTP access

The fetch helpers return normal `Response` objects, so `.json()`, `.text()`,
headers, status, URL, and redirects work as expected. Request bodies may be
strings, `URLSearchParams`, or JSON-serializable values. URL-encoded and JSON
content types are added automatically. `FormData` is not transported across the
console bridge; use a string or `URLSearchParams` for form actions.

```js
const stats = await ADMIN.fetch("/api/admin/stats");
assert.equal(stats.status, 200);

const health = await SELF.fetch("/health");
const billing = await ACTOR.fetch(
  { userId: "user_id", orgId: "org_id" },
  "/settings/organization/billing",
);
const external = await fetch("https://example.com/status");

return {
  stats: await stats.json(),
  health: health.status,
  external: external.status,
};
```

`ADMIN.fetch()` only accepts admin API paths and refuses the MCP and OAuth
endpoints. `SELF.fetch()` does not invent a browser session, which keeps
authentication behavior honest when testing public or signed endpoints.

`ACTOR.fetch()` accepts `{ userId, orgId, workspaceId? }`, confirms that the
user exists and belongs to the organization, mints an ephemeral in-memory
session, and sends it only to the same Worker origin. It rejects admin API
paths and external URLs. The session token is never returned to console code.
Every actor request records the admin id, actor ids, route, method, status, and
duration without recording request or response bodies.

Response bodies are capped at 1 MB inside the bridge, and the final console
result is independently capped by `max_output_characters`.

## Manual E2E controls

`IDENTITY` and `BILLING` are first-class control-plane facades for manual
staging browser tests. They execute inside the selected Worker environment and
do not add fixture HTTP endpoints. Passwords are accepted as inputs but never
returned by the facade or written to observability.

Create a normal password-login account using the same user/org helpers as the
signup route. The account is email-verified and its onboarding record is reset
to the incomplete state:

```js
const actor = await IDENTITY.createActor({
  email: input.email,
  password: input.password,
  name: "Billing E2E",
});
// actor is { userId, orgId, workspaceId }; credentials are not returned.
return actor;
```

Reset onboarding for another pass, or clean up the fixture:

```js
await IDENTITY.resetActor(actor.userId);
const deletion = await IDENTITY.deleteActor(actor.userId);
```

`deleteActor` uses the production organization and user hard-delete routines.
As a safety boundary it refuses users with multiple organizations and only
deletes an organization when the actor created it and remains its sole owner.
It also refuses actors with linked Stripe objects until
`BILLING.deleteTestCustomer` succeeds. It returns counts and warning totals,
not deleted profile data. Repeating a successful deletion is a no-op with
`alreadyDeleted: true`.

Read and mutate billing state while Playwright keeps the browser and chat open:

```js
const before = await BILLING.snapshot(actor.orgId);
const change = await BILLING.setAvailableCredits(actor.orgId, 0);
const after = await BILLING.snapshot(actor.orgId);
return { before, change, after };
```

Snapshots include normalized plan/status, credit limits, chargeable usage,
available credits, and booleans indicating whether Stripe objects are linked.
Stripe customer and subscription identifiers are intentionally omitted.
`setAvailableCredits` preserves purchased-credit accounting and adjusts the
grant total against chargeable usage, matching the admin credit-set behavior.

After a payment test, remove the Stripe fixture before deleting the actor:

```js
await BILLING.deleteTestCustomer(actor.orgId);
await IDENTITY.deleteActor(actor.userId);
```

`deleteTestCustomer` hard-fails unless the deployed Worker reports
`STRIPE_MODE=test`. It verifies customer metadata and subscription ownership
where available, cancels the subscription, deletes the test customer, and
clears the local Stripe projection. It never returns Stripe identifiers or
credentials. If cleanup fails, keep the actor ids and retry explicitly rather
than hiding the failure. Repeating cleanup after the organization was already
deleted is a no-op with `alreadyDeleted: true`.

## Integration tests

Use named tests for staging smoke suites. All cases run, and any failure marks
the MCP tool result as an error while retaining every case result.

```js
await test("admin API responds", async () => {
  const response = await ADMIN.fetch("/api/admin/stats");
  assert.equal(response.status, 200);
  const stats = await response.json();
  assert.ok(stats.total_users >= 1);
});

await test("org projection is readable", async () => {
  const org = await DO.call("ORG", "org_id", "getInfo");
  assert.equal(org.id, "org_id");
});

return { environment: runtime.baseUrl };
```

For a mutating flow, make setup, action, verification, and cleanup separate
named tests. Use unique fixture ids and idempotency keys. Staging uses Stripe
test mode, but it still contains shared state: clean up test records and never
assume a console process or local variable survives the call.

The first checked-in suite is
[`scripts/admin-js-exec/staging-billing-smoke.jsbody`](../scripts/admin-js-exec/staging-billing-smoke.jsbody).
Pass `{ "org_id": "..." }` as the tool's `input`; it verifies Stripe test mode,
the admin API, the target org, and the paid-seat projection without mutating
staging.

## Calling from mcporter

Keep invocations serial because mcporter OAuth callbacks share a local port.
The configured MCP name determines staging versus production.

```bash
bunx mcporter call admin-staging.admin_js_exec \
  code:='return { runtime, bindings: ENV.list() }' \
  input:='{}' \
  timeout_ms=30000 max_output_characters=120000
```

For longer suites, place the JavaScript in a local file and pass its contents
using the argument mechanism supported by the current MCP client instead of
maintaining a heavily escaped one-liner.

## Auditing and limits

Executions emit an `admin_js_exec` observability event with the admin user id,
duration, code size, case count, and success/failure status. First-class
identity and billing mutations also emit `admin_js_exec_control` events with
the admin id, operation, affected ids, status, and duration. Code, output,
request bodies, passwords, and credentials are not written to Analytics Engine.

The default timeout is 30 seconds and the maximum is 120 seconds. The default
final output limit is 120,000 characters and the maximum is 1,000,000.
