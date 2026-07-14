# Durable Objects

Read this reference when changing persistent state, migrations, object identity, transactions, or WebSockets.

## Preserve the Vertical Slice

The CRUD scaffold includes a working Durable Object, binding, migration, route loader/action, and UI. Rename and extend that slice consistently. Do not create a parallel database layer while leaving the example item store active.

Keep these three surfaces aligned:

1. The exported Durable Object class in `workers/`.
2. `durable_objects.bindings` in `wrangler.jsonc`.
3. A migration with `new_sqlite_classes` for every new SQLite-backed class.

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "ORDERS", "class_name": "OrderStore" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["OrderStore"] }]
}
```

## SQLite API

Durable Object SQLite is not D1. Pass parameters directly to `exec` and read the cursor:

```ts
const rows = this.ctx.storage.sql
  .exec("SELECT * FROM orders WHERE status = ?", status)
  .toArray();

const order = this.ctx.storage.sql
  .exec("SELECT * FROM orders WHERE id = ?", id)
  .one();
```

Do not use `.prepare()`, `.bind()`, `.all()`, `.first()`, `.run()`, or `.batch()`.

Initialize idempotently in the constructor with `CREATE TABLE IF NOT EXISTS`. Use `transactionSync` when several writes must commit atomically:

```ts
this.ctx.storage.transactionSync(() => {
  this.ctx.storage.sql.exec("UPDATE accounts SET balance = balance - ? WHERE id = ?", amount, from);
  this.ctx.storage.sql.exec("UPDATE accounts SET balance = balance + ? WHERE id = ?", amount, to);
});
```

Use `ctx.storage.kv` for simple object-local configuration or session values. It is synchronous; do not add `await`.

## Object Identity

A Durable Object instance owns an isolated database. Choose the id/name from the intended tenancy boundary—workspace, user, room, document, or another domain key. Do not accidentally route every user to one global instance unless shared state is the product requirement.

## Hibernatable WebSockets

Use `ctx.acceptWebSocket(server)` rather than `server.accept()` when idle connections should hibernate. Implement `webSocketMessage`, `webSocketClose`, and `webSocketError`; recover required per-socket metadata with `serializeAttachment`/`deserializeAttachment` because in-memory fields disappear during hibernation.

Use tags with `ctx.getWebSockets(tag)` for targeted broadcast and auto-responses for heartbeat traffic that should not wake the object.
