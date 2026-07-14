# Connections and Object Storage

Read this reference when an app uses workspace connections, databases, external providers, uploads, or R2.

## Workspace Connections

Use the virtual `CONNECTIONS` binding. Credentials remain behind the platform binding and must never be copied into app source or environment variables.

Resolve one connection with `find`; use `methods` when the app needs the full catalog or schemas:

```ts
const stripe = await context.cloudflare.env.CONNECTIONS.find("stripe");
const result = await context.cloudflare.env.CONNECTIONS[stripe.alias]
  .listCustomers({ limit: 10 });
```

Database-style connections expose `query({ query })`. Custom `other` connections expose authenticated `fetch(input, init)`. Prefer an id or alias when several connections can share a provider type; ambiguous name/type lookup should fail instead of silently choosing one.

When a connection or method comes from user input, validate it against `CONNECTIONS.methods()` before invocation.

Use `js_exec` to inspect and smoke-test workspace connections while developing:

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
