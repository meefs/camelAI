# Other Connections Method Binding Notes

## Current State

Custom `other` connections are callable through the source-compatible
`CONNECTIONS` binding from both user Workers and `js_exec`.

- `CONNECTIONS.methods()` exposes a synthesized `fetch` method.
- `CONNECTIONS.find({ type: "other" })` resolves one custom API connection.
- `connections[alias].fetch(input, init)` behaves like normal `fetch`.
- The runtime applies stored authentication from encrypted credentials/config.
- Relative URLs resolve against the configured `base_url`.
- Absolute `http`/`https` URLs are temporarily allowed for migration.

Example API:

```js
const custom = await env.CONNECTIONS.find({ type: "other" });
const response = await connections[custom.alias].fetch("/v1/items", {
  method: "GET",
});
return await response.json();
```

## Follow-Up

- Restrict absolute URLs to configured trusted hosts once migration is complete.
