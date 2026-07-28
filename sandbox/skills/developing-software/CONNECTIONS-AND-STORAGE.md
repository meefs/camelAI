# Connections and Object Storage

Read this reference when an app uses workspace connections, databases, external providers, uploads, or R2.

## Workspace Connections

Use the virtual `CONNECTIONS` binding. Credentials remain behind the platform binding and must never be copied into app source or environment variables.

The deployed binding is an RPC service with fixed methods such as `find`,
`methods`, and `invoke`. For method-style calls, wrap it with the scaffolded
`createConnections()` helper. Do not access `context.cloudflare.env.CONNECTIONS[alias]`
directly: Cloudflare RPC interprets the alias as an RPC method name.

Resolve one connection with `find`; use `methods` when the app needs the full
catalog or schemas:

```ts
import { createConnections } from "~/lib/connections";

const binding = context.cloudflare.env.CONNECTIONS;
const connections = createConnections(context.cloudflare.env);
const stripe = await binding.find("stripe");
const result = await connections[stripe.alias]
  .listCustomers({ limit: 10 });
```

Database-style connections expose `query({ query })`. Custom `other`
connections expose authenticated `fetch(input, init)` through the same helper:

```ts
const custom = await binding.find({ type: "other" });
const response = await connections[custom.alias].fetch("/v1/items", {
  method: "GET",
});
```

Prefer an id or alias when several connections can share a provider type;
ambiguous name/type lookup should fail instead of silently choosing one.

When a connection or method comes from user input, validate it against `CONNECTIONS.methods()` before invocation.

`js_exec` already provides a proxied `env.CONNECTIONS`, so its call shape is
deliberately different from a deployed Worker's raw RPC binding. Use it to
inspect and smoke-test workspace connections while developing:

```ts
const entry = await env.CONNECTIONS.find("clickhouse");
return await env.CONNECTIONS[entry.alias].query({ query: "SELECT 1 AS ok" });
```

## R2

Use R2 for files, images, blobs, exports, and other large unstructured objects. Use Durable Object SQLite for relational/queryable application data.

Declare a project-specific bucket name:

```jsonc
{
  "r2_buckets": [
    { "binding": "UPLOADS", "bucket_name": "my-app-uploads" }
  ]
}
```

Access it through `context.cloudflare.env`:

```ts
await context.cloudflare.env.UPLOADS.put(key, file.stream(), {
  httpMetadata: { contentType: file.type },
});

const object = await context.cloudflare.env.UPLOADS.get(key);
if (!object) throw new Response("Not found", { status: 404 });
return new Response(object.body, {
  headers: { "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream" },
});
```

Use multipart upload for large objects. Validate object keys and content types; do not expose raw workspace R2 keys or accept arbitrary traversal-like paths.
