export type CustomDomainStatus = "pending" | "active" | "failed";

export interface CustomDomain {
  domain: string;
  cf_hostname_id: string | null;
  status: CustomDomainStatus;
  ssl_status: string | null;
  created_at: number;
  updated_at: number;
}

type CustomDomainRow = CustomDomain & Record<string, SqlStorageValue>;

export interface CustomDomainStoreContext {
  sql: SqlStorage;
  log(action: string, actorId: string, targetId?: string): void;
}

export function setCustomDomain(
  context: CustomDomainStoreContext,
  domain: string,
  actorId: string,
): CustomDomain {
  const now = Date.now();
  // Org can have at most one custom domain — upsert
  context.sql.exec("DELETE FROM custom_domains");
  context.sql.exec(
    `INSERT INTO custom_domains (domain, cf_hostname_id, status, ssl_status, created_at, updated_at)
     VALUES (?, NULL, 'pending', NULL, ?, ?)`,
    domain,
    now,
    now,
  );
  context.log("custom_domain_set", actorId, domain);
  return {
    domain,
    cf_hostname_id: null,
    status: "pending",
    ssl_status: null,
    created_at: now,
    updated_at: now,
  };
}

export function removeCustomDomain(
  context: CustomDomainStoreContext,
  actorId: string,
): CustomDomain | null {
  const existing = getCustomDomain(context);
  if (!existing) return null;
  context.sql.exec("DELETE FROM custom_domains");
  context.log("custom_domain_removed", actorId, existing.domain);
  return existing;
}

export function getCustomDomain(
  context: Pick<CustomDomainStoreContext, "sql">,
): CustomDomain | null {
  const rows = context.sql
    .exec<CustomDomainRow>(
      "SELECT domain, cf_hostname_id, status, ssl_status, created_at, updated_at FROM custom_domains LIMIT 1",
    )
    .toArray();
  return rows[0] ?? null;
}

export function updateCustomDomainStatus(
  context: Pick<CustomDomainStoreContext, "sql">,
  domain: string,
  status: CustomDomainStatus,
  sslStatus?: string | null,
  cfHostnameId?: string,
): CustomDomain | null {
  const existing = getCustomDomain(context);
  if (!existing || existing.domain !== domain) return null;
  const now = Date.now();
  const updates: string[] = ["status = ?", "updated_at = ?"];
  const params: (string | number | null)[] = [status, now];
  if (sslStatus !== undefined) {
    updates.push("ssl_status = ?");
    params.push(sslStatus ?? null);
  }
  if (cfHostnameId !== undefined) {
    updates.push("cf_hostname_id = ?");
    params.push(cfHostnameId);
  }
  params.push(domain);
  context.sql.exec(
    `UPDATE custom_domains SET ${updates.join(", ")} WHERE domain = ?`,
    ...params,
  );
  return getCustomDomain(context);
}
