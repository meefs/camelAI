# Other Connections Method Binding TODO

## Current State

Custom `other` connections are mostly a setup flow today.

- The Connections page starts an agent-guided chat for `Other`.
- The agent can call `prompt_connection_setup` with dynamic credential fields.
- The chat UI renders those fields, submits the values, and `ChatThreadDO` creates the workspace integration.
- The submitted values are stored as encrypted credentials.
- The sandbox/container still receives compatibility `INT_OTHER_*` environment variables.

The new source-compatible connection binding does not yet make these custom connections cleanly callable. `CONNECTIONS.list()` and `CONNECTIONS.get()` can see them, but `CONNECTIONS.methods()` does not expose useful methods for `other` because method generation is currently backed by native/MCP provider definitions. Some code advertises an `authenticated_fetch` capability, but there is not a real method implementation behind it yet.

## Desired Shape

`other` should become a generic authenticated HTTP connection that works the same way from user workers and from `js_exec`.

Example target API:

```ts
await connections.myCustomApi.request({
  path: "/v1/items",
  method: "GET",
  query: { limit: "10" },
});
```

The runtime should inject authentication from stored connection credentials/config, so worker and `js_exec` code never sees raw secrets unless we intentionally expose them.

## Implementation Notes

- Add a synthesized `request` method for `other` connections in the shared connections runtime.
- Keep the implementation behind `CONNECTIONS.__invoke(...)` so user workers and `js_exec` stay source-compatible.
- Store non-secret config separately from credentials during dynamic setup, especially:
  - `base_url`
  - `auth_type`
  - `auth_header`
- Restrict requests to the configured `base_url` host/origin.
- Reject arbitrary absolute URLs unless they are inside the configured base URL.
- Support JSON and text responses initially.
- Avoid relying on `INT_OTHER_*` env vars for the long-term interface; those are compatibility only.

## Follow-Up

Once the method binding works, update the agent prompt/docs so agents prefer:

```ts
await connections.<connectionAlias>.request(...)
```

over reading `INT_OTHER_*` environment variables.
