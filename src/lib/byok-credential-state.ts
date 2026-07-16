export interface OrgScopedByokCredential {
  orgId: string | null;
  apiKey: string;
}

export const EMPTY_BYOK_CREDENTIAL: OrgScopedByokCredential = {
  orgId: null,
  apiKey: "",
};

export function resolveOrgScopedByokApiKey(
  credential: OrgScopedByokCredential,
  currentOrgId: string | null | undefined,
): string {
  return credential.orgId === (currentOrgId ?? null) ? credential.apiKey : "";
}
